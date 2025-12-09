const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const Docker = require('dockerode');
const { getLocalIP } = require('../utils/network');
const { REVERSE_PROXY_DIR } = require('../config/paths');

const execPromise = util.promisify(exec);
const docker = new Docker();
const EXPECTED_CONFIG = {
  composeFile: path.join(REVERSE_PROXY_DIR, 'docker-compose.yml'),
  caddyfile: path.join(REVERSE_PROXY_DIR, 'Caddyfile'),
  containerName: 'caddy'
};

// Templates de configuration
const DOCKER_COMPOSE_TEMPLATE = `version: "3.8"
services:
  caddy:
    image: caddy:latest
    container_name: caddy
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /data/config/reverse-proxy/Caddyfile:/etc/caddy/Caddyfile:ro
      - /data/config/reverse-proxy/data:/data
      - /data/config/reverse-proxy/config:/config
`;

/**
 * Génère le contenu du Caddyfile avec host.docker.internal (same-origin setup)
 * Utilise host.docker.internal car Caddy tourne dans Docker et doit accéder à l'hôte
 */
function generateCaddyfileContent() {
  return `{
  auto_https off
}

# Rediriger HTTPS -> HTTP (évite le forçage HTTPS local)
https://ryvie.local {
  redir http://ryvie.local{uri} permanent
}

# Site local
http://ryvie.local {
  encode gzip

  # 1) Socket.IO (WebSocket support)
  @socketio path /socket.io/*
  reverse_proxy @socketio host.docker.internal:3002 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
  }

  # 2) API Backend (routes /api/* et /status)
  @api path /api/* /status
  reverse_proxy @api host.docker.internal:3002 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
  }

  # 3) Connecteur OnlyOffice sous le même host (NE PAS retirer le préfixe)
  @onlyoffice path /plugins/onlyoffice*
  reverse_proxy @onlyoffice host.docker.internal:5000

  # 4) Tout le reste vers le frontend (webpack dev)
  reverse_proxy host.docker.internal:3000 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
  }
}
`;
}

/**
 * Crée le dossier de configuration et les fichiers s'ils n'existent pas
 */
async function ensureConfigFiles() {
  try {
    // Créer le dossier principal s'il n'existe pas
    try {
      await fs.mkdir(REVERSE_PROXY_DIR, { recursive: true });
      console.log('[reverseProxyService] 📁 Dossier créé:', REVERSE_PROXY_DIR);
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
    
    // Créer les sous-dossiers pour les volumes Caddy
    const subDirs = ['data', 'config'];
    for (const dir of subDirs) {
      const dirPath = path.join(REVERSE_PROXY_DIR, dir);
      try {
        await fs.mkdir(dirPath, { recursive: true });
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    
    let filesCreated = false;
    
    // Créer docker-compose.yml s'il n'existe pas
    try {
      await fs.access(EXPECTED_CONFIG.composeFile);
    } catch {
      await fs.writeFile(EXPECTED_CONFIG.composeFile, DOCKER_COMPOSE_TEMPLATE);
      console.log('[reverseProxyService] ✅ docker-compose.yml créé');
      filesCreated = true;
    }
    
    // Créer Caddyfile s'il n'existe pas
    try {
      await fs.access(EXPECTED_CONFIG.caddyfile);
    } catch {
      const caddyfileContent = generateCaddyfileContent();
      await fs.writeFile(EXPECTED_CONFIG.caddyfile, caddyfileContent);
      console.log('[reverseProxyService] ✅ Caddyfile créé avec IP:', getLocalIP());
      filesCreated = true;
    }
    
    return { success: true, filesCreated };
  } catch (error: any) {
    console.error('[reverseProxyService] ❌ Erreur lors de la création des fichiers:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Vérifie si le fichier docker-compose.yml existe et a la bonne configuration
 */
async function checkComposeFile() {
  try {
    const content = await fs.readFile(EXPECTED_CONFIG.composeFile, 'utf8');
    
    // Vérifications basiques
    const checks = [
      content.includes('caddy:latest'),
      content.includes('container_name: caddy'),
      content.includes('restart: unless-stopped'),
      content.includes('host.docker.internal:host-gateway'),
      content.includes('80:80'),
      content.includes('443:443')
    ];
    
    const isValid = checks.every(check => check);
    
    if (!isValid) {
      console.warn('[reverseProxyService] ⚠️  docker-compose.yml existe mais configuration incomplète');
    }
    
    return { exists: true, valid: isValid, content };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.warn('[reverseProxyService] ⚠️  docker-compose.yml non trouvé:', EXPECTED_CONFIG.composeFile);
      return { exists: false, valid: false };
    }
    throw error;
  }
}

/**
 * Vérifie si le Caddyfile utilise localhost ou une IP
 */
function checkCaddyfileHost(content) {
  const usesLocalhost = content.includes('reverse_proxy') && content.includes('localhost:');
  const usesIP = /reverse_proxy(?:\s+@\w+)?\s+(\d+\.\d+\.\d+\.\d+):/.test(content);
  
  if (usesLocalhost) {
    return { type: 'localhost', value: 'localhost' };
  } else if (usesIP) {
    const matches = content.matchAll(/reverse_proxy(?:\s+@\w+)?\s+(\d+\.\d+\.\d+\.\d+):(\d+)/g);
    const ips = [...matches].map(m => m[1]);
    return { type: 'ip', value: ips.length > 0 ? ips[ips.length - 1] : null };
  }
  
  return { type: 'unknown', value: null };
}

/**
 * Vérifie si le Caddyfile existe et a la bonne configuration
 */
async function checkCaddyfile() {
  try {
    const content = await fs.readFile(EXPECTED_CONFIG.caddyfile, 'utf8');
    
    // Vérifications basiques
    const checks = [
      content.includes('auto_https off'),
      content.includes('ryvie.local'),
      content.includes('reverse_proxy') && content.includes(':3000'),
      content.includes('@api') && content.includes(':3002'),
      content.includes('@socketio') && content.includes(':3002'),
      content.includes('@onlyoffice') && content.includes(':5000')
    ];
    
    const isValid = checks.every(check => check);
    
    // Vérifier le type d'hôte utilisé (localhost ou IP)
    const hostInfo = checkCaddyfileHost(content);
    
    // Vérifier si la redirection HTTPS est présente (recommandé mais pas obligatoire)
    const hasHttpsRedirect = content.includes('https://ryvie.local') && content.includes('redir');
    if (!hasHttpsRedirect) {
      console.warn('[reverseProxyService] ⚠️  Redirection HTTPS→HTTP non configurée (Chrome peut forcer HTTPS)');
    }
    
    if (!isValid) {
      console.warn('[reverseProxyService] ⚠️  Caddyfile existe mais configuration incomplète');
    }
    
    return { exists: true, valid: isValid, content, hostInfo, hasHttpsRedirect };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.warn('[reverseProxyService] ⚠️  Caddyfile non trouvé:', EXPECTED_CONFIG.caddyfile);
      return { exists: false, valid: false };
    }
    throw error;
  }
}

/**
 * Vérifie si le container Caddy existe et son état
 */
async function checkCaddyContainer() {
  try {
    const containers = await docker.listContainers({ all: true });
    const caddyContainer = containers.find(c => 
      c.Names.some(name => name.includes(EXPECTED_CONFIG.containerName))
    );
    
    if (!caddyContainer) {
      return { exists: false, running: false };
    }
    
    const isRunning = caddyContainer.State === 'running';
    
    return {
      exists: true,
      running: isRunning,
      id: caddyContainer.Id,
      state: caddyContainer.State,
      status: caddyContainer.Status
    };
  } catch (error: any) {
    console.error('[reverseProxyService] Erreur lors de la vérification du container:', error);
    return { exists: false, running: false, error: error.message };
  }
}

/**
 * Arrête le container Caddy via docker-compose
 */
async function stopCaddy() {
  try {
    console.log('[reverseProxyService] 🛑 Arrêt de Caddy...');
    
    const { stdout, stderr } = await execPromise(
      'docker compose down',
      { cwd: REVERSE_PROXY_DIR }
    );
    
    if (stderr && !stderr.includes('Stopping') && !stderr.includes('Removing')) {
      console.warn('[reverseProxyService] Warnings:', stderr);
    }
    
    console.log('[reverseProxyService] ✅ Caddy arrêté avec succès');
    return { success: true, output: stdout };
  } catch (error: any) {
    console.error('[reverseProxyService] ❌ Erreur lors de l\'arrêt de Caddy:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Démarre le container Caddy via docker-compose
 */
async function startCaddy() {
  try {
    console.log('[reverseProxyService] 🚀 Démarrage de Caddy...');
    
    const { stdout, stderr } = await execPromise(
      'docker compose up -d',
      { cwd: REVERSE_PROXY_DIR }
    );
    
    if (stderr && !stderr.includes('Creating') && !stderr.includes('Starting')) {
      console.warn('[reverseProxyService] Warnings:', stderr);
    }
    
    console.log('[reverseProxyService] ✅ Caddy démarré avec succès');
    return { success: true, output: stdout };
  } catch (error: any) {
    console.error('[reverseProxyService] ❌ Erreur lors du démarrage de Caddy:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Met à jour le Caddyfile (maintenant utilise localhost)
 */
async function updateCaddyfileIP() {
  try {
    const caddyfileContent = generateCaddyfileContent();
    
    await fs.writeFile(EXPECTED_CONFIG.caddyfile, caddyfileContent);
    console.log('[reverseProxyService] ✅ Caddyfile mis à jour avec localhost');
    
    return { success: true, usingLocalhost: true };
  } catch (error: any) {
    console.error('[reverseProxyService] ❌ Erreur lors de la mise à jour du Caddyfile:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Redémarre Caddy (down puis up)
 */
async function restartCaddy() {
  try {
    console.log('[reverseProxyService] 🔄 Redémarrage de Caddy...');
    
    // Arrêter Caddy
    const stopResult = await stopCaddy();
    if (!stopResult.success) {
      return { success: false, error: 'Échec de l\'arrêt de Caddy', details: stopResult };
    }
    
    // Attendre un peu
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Redémarrer Caddy
    const startResult = await startCaddy();
    if (!startResult.success) {
      return { success: false, error: 'Échec du démarrage de Caddy', details: startResult };
    }
    
    console.log('[reverseProxyService] ✅ Caddy redémarré avec succès');
    return { success: true };
  } catch (error: any) {
    console.error('[reverseProxyService] ❌ Erreur lors du redémarrage de Caddy:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Vérifie et démarre Caddy si nécessaire
 */
async function ensureCaddyRunning() {
  try {
    console.log('[reverseProxyService] 🔍 Vérification du reverse proxy Caddy...');
    
    // 0. Créer les fichiers de configuration s'ils n'existent pas
    const configResult = await ensureConfigFiles();
    if (!configResult.success) {
      return {
        success: false,
        error: 'Impossible de créer les fichiers de configuration',
        details: configResult
      };
    }
    
    if (configResult.filesCreated) {
      console.log('[reverseProxyService] 📝 Fichiers de configuration créés');
    }
    
    // 1. Vérifier les fichiers de configuration
    const [composeCheck, caddyfileCheck] = await Promise.all([
      checkComposeFile(),
      checkCaddyfile()
    ]);
    
    if (!composeCheck.exists || !composeCheck.valid) {
      console.error('[reverseProxyService] ❌ docker-compose.yml manquant ou invalide');
      return {
        success: false,
        error: 'Configuration docker-compose.yml manquante ou invalide',
        details: { composeCheck, caddyfileCheck }
      };
    }
    
    if (!caddyfileCheck.exists || !caddyfileCheck.valid) {
      console.warn('[reverseProxyService] ⚠️  Caddyfile manquant ou invalide, régénération...');
      
      // Supprimer l'ancien Caddyfile s'il existe
      try {
        await fs.unlink(EXPECTED_CONFIG.caddyfile);
        console.log('[reverseProxyService] 🗑️  Ancien Caddyfile supprimé');
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.warn('[reverseProxyService] ⚠️  Erreur lors de la suppression:', error.message);
        }
      }
      
      // Recréer le Caddyfile
      const caddyfileContent = generateCaddyfileContent();
      await fs.writeFile(EXPECTED_CONFIG.caddyfile, caddyfileContent);
      console.log('[reverseProxyService] ✅ Nouveau Caddyfile créé avec IP:', getLocalIP());
      
      // Redémarrer Caddy si il est en cours d'exécution
      const containerStatus = await checkCaddyContainer();
      if (containerStatus.running) {
        console.log('[reverseProxyService] 🔄 Redémarrage de Caddy pour appliquer la nouvelle configuration...');
        const restartResult = await restartCaddy();
        
        if (!restartResult.success) {
          console.warn('[reverseProxyService] ⚠️  Échec du redémarrage de Caddy:', restartResult.error);
        } else {
          console.log('[reverseProxyService] ✅ Caddy redémarré avec succès');
        }
      }
    }
    
    console.log('[reverseProxyService] ✅ Fichiers de configuration OK');
    
    // 2. Vérifier si le Caddyfile utilise encore une IP au lieu de localhost
    const hostInfo = caddyfileCheck.hostInfo;
    if (hostInfo && hostInfo.type === 'ip') {
      console.log(`[reverseProxyService] 🔄 Migration détectée: IP (${hostInfo.value}) → localhost`);
      
      // Mettre à jour le Caddyfile pour utiliser localhost
      const caddyfileContent = generateCaddyfileContent();
      await fs.writeFile(EXPECTED_CONFIG.caddyfile, caddyfileContent);
      console.log('[reverseProxyService] ✅ Caddyfile mis à jour pour utiliser localhost');
      
      // Vérifier si Caddy est en cours d'exécution et le redémarrer
      const containerStatus = await checkCaddyContainer();
      if (containerStatus.running) {
        console.log('[reverseProxyService] 🔄 Redémarrage de Caddy pour appliquer localhost...');
        const restartResult = await restartCaddy();
        
        if (!restartResult.success) {
          return {
            success: false,
            error: 'Échec du redémarrage de Caddy',
            details: restartResult
          };
        }
        
        // Attendre et vérifier que Caddy est bien redémarré
        await new Promise(resolve => setTimeout(resolve, 2000));
        const newStatus = await checkCaddyContainer();
        
        if (!newStatus.running) {
          return {
            success: false,
            error: 'Caddy redémarré mais pas running',
            container: newStatus
          };
        }
        
        console.log('[reverseProxyService] ✅ Caddy redémarré avec localhost');
        return {
          success: true,
          migrated: true,
          restarted: true,
          oldHost: hostInfo.value,
          newHost: 'localhost',
          container: newStatus
        };
      }
    }
    
    // 3. Vérifier l'état du container
    const containerStatus = await checkCaddyContainer();
    
    if (containerStatus.running) {
      console.log('[reverseProxyService] ✅ Caddy est déjà en cours d\'exécution');
      return {
        success: true,
        alreadyRunning: true,
        usingLocalhost: true,
        container: containerStatus
      };
    }
    
    // 4. Démarrer Caddy si nécessaire
    if (!containerStatus.exists || !containerStatus.running) {
      console.log('[reverseProxyService] 🔄 Caddy n\'est pas démarré, lancement en cours...');
      const startResult = await startCaddy();
      
      if (!startResult.success) {
        return {
          success: false,
          error: 'Échec du démarrage de Caddy',
          details: startResult
        };
      }
      
      // Attendre un peu et revérifier
      await new Promise(resolve => setTimeout(resolve, 2000));
      const newStatus = await checkCaddyContainer();
      
      if (!newStatus.running) {
        console.error('[reverseProxyService] ❌ Caddy démarré mais pas en cours d\'exécution');
        return {
          success: false,
          error: 'Caddy démarré mais pas running',
          container: newStatus
        };
      }
      
      console.log('[reverseProxyService] ✅ Caddy démarré avec succès');
      return {
        success: true,
        started: true,
        container: newStatus
      };
    }
    
  } catch (error: any) {
    console.error('[reverseProxyService] ❌ Erreur lors de la vérification/démarrage:', error);
    return {
      success: false,
      error: error.message,
      stack: error.stack
    };
  }
}

/**
 * Obtient le statut actuel du reverse proxy
 */
async function getReverseProxyStatus() {
  try {
    const [composeCheck, caddyfileCheck, containerStatus] = await Promise.all([
      checkComposeFile(),
      checkCaddyfile(),
      checkCaddyContainer()
    ]);
    
    return {
      configured: composeCheck.valid && caddyfileCheck.valid,
      running: containerStatus.running,
      details: {
        compose: composeCheck,
        caddyfile: caddyfileCheck,
        container: containerStatus
      }
    };
  } catch (error: any) {
    console.error('[reverseProxyService] Erreur lors de la récupération du statut:', error);
    return {
      configured: false,
      running: false,
      error: error.message
    };
  }
}

export = {
  ensureCaddyRunning,
  getReverseProxyStatus,
  checkCaddyContainer,
  startCaddy,
  stopCaddy,
  restartCaddy,
  updateCaddyfileIP
};
