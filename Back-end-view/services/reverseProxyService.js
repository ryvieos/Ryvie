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
 * Génère le contenu du Caddyfile avec l'IP de l'hôte
 */
function generateCaddyfileContent() {
  const hostIP = getLocalIP();
  return `{
  auto_https off
}

# Rediriger HTTPS vers HTTP (pour éviter le forçage HTTPS de Chrome)
https://ryvie.local {
  redir http://ryvie.local{uri} permanent
}

http://ryvie.local {
  encode gzip
  # Proxy vers le frontend webpack-dev-server sur l'hôte
  reverse_proxy ${hostIP}:3000
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
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    
    // Créer les sous-dossiers pour les volumes Caddy
    const subDirs = ['data', 'config'];
    for (const dir of subDirs) {
      const dirPath = path.join(REVERSE_PROXY_DIR, dir);
      try {
        await fs.mkdir(dirPath, { recursive: true });
      } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('[reverseProxyService] ⚠️  docker-compose.yml non trouvé:', EXPECTED_CONFIG.composeFile);
      return { exists: false, valid: false };
    }
    throw error;
  }
}

/**
 * Extrait l'IP du Caddyfile actuel
 */
function extractIPFromCaddyfile(content) {
  const match = content.match(/reverse_proxy\s+(\d+\.\d+\.\d+\.\d+):(\d+)/);
  return match ? match[1] : null;
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
      content.includes('reverse_proxy') && content.includes(':3000')
    ];
    
    const isValid = checks.every(check => check);
    
    // Extraire l'IP actuelle
    const currentIP = extractIPFromCaddyfile(content);
    
    // Vérifier si la redirection HTTPS est présente (recommandé mais pas obligatoire)
    const hasHttpsRedirect = content.includes('https://ryvie.local') && content.includes('redir');
    if (!hasHttpsRedirect) {
      console.warn('[reverseProxyService] ⚠️  Redirection HTTPS→HTTP non configurée (Chrome peut forcer HTTPS)');
    }
    
    if (!isValid) {
      console.warn('[reverseProxyService] ⚠️  Caddyfile existe mais configuration incomplète');
    }
    
    return { exists: true, valid: isValid, content, currentIP, hasHttpsRedirect };
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    console.error('[reverseProxyService] ❌ Erreur lors du démarrage de Caddy:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Met à jour le Caddyfile avec la nouvelle IP
 */
async function updateCaddyfileIP() {
  try {
    const newIP = getLocalIP();
    const caddyfileContent = generateCaddyfileContent();
    
    await fs.writeFile(EXPECTED_CONFIG.caddyfile, caddyfileContent);
    console.log('[reverseProxyService] ✅ Caddyfile mis à jour avec IP:', newIP);
    
    return { success: true, newIP };
  } catch (error) {
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
  } catch (error) {
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
      console.error('[reverseProxyService] ❌ Caddyfile manquant ou invalide');
      return {
        success: false,
        error: 'Caddyfile manquant ou invalide',
        details: { composeCheck, caddyfileCheck }
      };
    }
    
    console.log('[reverseProxyService] ✅ Fichiers de configuration OK');
    
    // 2. Vérifier si l'IP a changé
    const currentHostIP = getLocalIP();
    const caddyfileIP = caddyfileCheck.currentIP;
    
    if (caddyfileIP && caddyfileIP !== currentHostIP) {
      console.log(`[reverseProxyService] 🔄 Changement d'IP détecté: ${caddyfileIP} → ${currentHostIP}`);
      
      // Mettre à jour le Caddyfile
      const updateResult = await updateCaddyfileIP();
      if (!updateResult.success) {
        return {
          success: false,
          error: 'Échec de la mise à jour du Caddyfile',
          details: updateResult
        };
      }
      
      // Vérifier si Caddy est en cours d'exécution
      const containerStatus = await checkCaddyContainer();
      if (containerStatus.running) {
        console.log('[reverseProxyService] 🔄 Redémarrage de Caddy pour appliquer la nouvelle IP...');
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
        
        console.log('[reverseProxyService] ✅ Caddy redémarré avec nouvelle IP:', currentHostIP);
        return {
          success: true,
          ipChanged: true,
          restarted: true,
          oldIP: caddyfileIP,
          newIP: currentHostIP,
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
        currentIP: currentHostIP,
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
    
  } catch (error) {
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
  } catch (error) {
    console.error('[reverseProxyService] Erreur lors de la récupération du statut:', error);
    return {
      configured: false,
      running: false,
      error: error.message
    };
  }
}

module.exports = {
  ensureCaddyRunning,
  getReverseProxyStatus,
  checkCaddyContainer,
  startCaddy,
  stopCaddy,
  restartCaddy,
  updateCaddyfileIP
};
