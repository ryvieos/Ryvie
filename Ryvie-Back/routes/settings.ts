const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { checkAllUpdates } = require('../services/updateCheckService');
const { updateRyvie, updateApp, updateProgressEmitter } = require('../services/updateService');
const { SETTINGS_FILE, NETBIRD_FILE } = require('../config/paths');
const crypto = require('crypto');

// Charger les paramètres
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const json = JSON.parse(data);
      // S'assurer qu'un id existe
      if (!json.id) {
        json.id = (crypto.randomUUID ? crypto.randomUUID() : 'ryvie-' + crypto.randomBytes(16).toString('hex'));
        saveSettings(json);
      }
      return json;
    } else {
      // Créer le dossier si nécessaire et le fichier avec valeurs par défaut + id
      const defaults = {
        id: (crypto.randomUUID ? crypto.randomUUID() : 'ryvie-' + crypto.randomBytes(16).toString('hex')),
        tokenExpirationMinutes: 60
      };
      saveSettings(defaults);
      return defaults;
    }
  } catch (error: any) {
    console.error('[settings] Erreur lors du chargement des paramètres:', error);
  }
  
  // Paramètres par défaut
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : 'ryvie-' + crypto.randomBytes(16).toString('hex')),
    tokenExpirationMinutes: 60
  };
}

// Sauvegarder les paramètres
function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    return true;
  } catch (error: any) {
    console.error('[settings] Erreur lors de la sauvegarde des paramètres:', error);
    return false;
  }
}

// GET /api/settings/token-expiration - Récupérer la durée d'expiration du token
router.get('/settings/token-expiration', verifyToken, (req: any, res: any) => {
  try {
    const settings = loadSettings();
    res.json({ minutes: settings.tokenExpirationMinutes || 60 });
  } catch (error: any) {
    console.error('[settings] Erreur GET token-expiration:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/settings/token-expiration - Modifier la durée d'expiration du token
router.patch('/settings/token-expiration', verifyToken, (req: any, res: any) => {
  try {
    const { minutes } = req.body;
    
    if (!minutes || minutes < 1 || minutes > 1440) {
      return res.status(400).json({ error: 'Durée invalide (1-1440 minutes)' });
    }
    
    const settings = loadSettings();
    settings.tokenExpirationMinutes = parseInt(minutes);
    
    if (saveSettings(settings)) {
      // Mettre à jour la variable d'environnement pour les prochains tokens
      process.env.JWT_EXPIRES_MINUTES = minutes.toString();

      // Aligner aussi la durée de session SSO Keycloak (idle + max lifespan), pour
      // que ce réglage gouverne la vraie session SSO et pas seulement le JWT dashboard.
      // Best-effort, non bloquant : un échec Keycloak n'empêche pas la sauvegarde.
      try {
        const { setRealmSessionTimeout } = require('../services/keycloakService');
        Promise.resolve(setRealmSessionTimeout(parseInt(minutes))).catch(() => {});
      } catch (_) {}

      console.log(`[settings] Durée d'expiration du token modifiée: ${minutes} minutes`);
      res.json({ 
        success: true, 
        message: `Durée de session modifiée: ${minutes} minutes`,
        minutes: minutes
      });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[settings] Erreur PATCH token-expiration:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/settings/update-status - Récupérer le statut de la mise à jour en cours
router.get('/settings/update-status', verifyToken, (req: any, res: any) => {
  try {
    const statusFile = '/tmp/ryvie-update-status.json';
    
    if (fs.existsSync(statusFile)) {
      const data = fs.readFileSync(statusFile, 'utf8');
      const status = JSON.parse(data);
      res.json(status);
    } else {
      res.json({ 
        step: 'idle', 
        message: 'Aucune mise à jour en cours',
        progress: 0
      });
    }
  } catch (error: any) {
    console.error('[settings] Erreur GET update-status:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/settings/updates - Vérifier les mises à jour disponibles
router.get('/settings/updates', verifyToken, async (req: any, res: any) => {
  try {
    console.log('[settings] Vérification des mises à jour...');
    const updates = await checkAllUpdates();
    res.json(updates);
  } catch (error: any) {
    console.error('[settings] Erreur lors de la vérification des mises à jour:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la vérification des mises à jour',
      details: error.message 
    });
  }
});

// POST /api/settings/start-update-monitor - Démarrer le service de monitoring
router.post('/settings/start-update-monitor', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const { spawn, execSync } = require('child_process');
    const path = require('path');
    const fs = require('fs');
    
    let clientOrigin = typeof req.body?.origin === 'string' ? req.body.origin.trim() : '';
    if (!clientOrigin) {
      const headerOrigin = (req.get('origin') || '').trim();
      if (headerOrigin) {
        clientOrigin = headerOrigin;
      }
    }
    if (!clientOrigin) {
      const referer = (req.get('referer') || '').trim();
      if (referer) {
        try {
          const parsed = new URL(referer);
          clientOrigin = parsed.origin;
        } catch (_) {
          // ignore
        }
      }
    }
    
    // Créer un dossier temporaire pour le service de monitoring
    const tmpDir = '/tmp/ryvie-update-monitor';
    const monitorScript = path.join(tmpDir, 'monitor.js');
    const monitorHtml = path.join(tmpDir, 'update-monitor.html');
    const templateScript = path.join(__dirname, '../../../scripts/update-monitor-template.js');
    const templateHtml = path.join(__dirname, '../../../scripts/update-monitor.html');
    
    console.log('[settings] Création du dossier temporaire:', tmpDir);
    
    // Supprimer l'ancien dossier s'il existe
    if (fs.existsSync(tmpDir)) {
      execSync(`rm -rf ${tmpDir}`);
    }
    
    // Créer le nouveau dossier
    fs.mkdirSync(tmpDir, { recursive: true });
    
    // Copier les fichiers du service de monitoring
    if (fs.existsSync(templateScript)) {
      fs.copyFileSync(templateScript, monitorScript);
      console.log('[settings] Template JS copié vers:', monitorScript);
    } else {
      throw new Error('Template de monitoring introuvable: ' + templateScript);
    }
    if (fs.existsSync(templateHtml)) {
      fs.copyFileSync(templateHtml, monitorHtml);
      console.log('[settings] Template HTML copié vers:', monitorHtml);
    } else {
      throw new Error('Template HTML de monitoring introuvable: ' + templateHtml);
    }
    
    // Créer un lien symbolique vers node_modules du backend
    const backendNodeModules = path.join(__dirname, '../../node_modules');
    const tmpNodeModules = path.join(tmpDir, 'node_modules');
    
    if (fs.existsSync(backendNodeModules)) {
      try {
        fs.symlinkSync(backendNodeModules, tmpNodeModules, 'dir');
        console.log('[settings] Lien symbolique node_modules créé');
      } catch (err: any) {
        // Si le lien existe déjà, ignorer l'erreur
        if (err.code !== 'EEXIST') {
          console.warn('[settings] Impossible de créer le lien symbolique:', err.message);
        }
      }
    }
    
    // Créer un fichier .env avec l'URL de retour pour garantir la bonne redirection
    const envFile = path.join(tmpDir, '.env');
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost';
    const fallbackOrigin = `${protocol}://${host}`;
    const returnUrl = clientOrigin && /^https?:\/\//.test(clientOrigin) ? clientOrigin : fallbackOrigin;
    
    const envContent = `# Configuration du service Update Monitor
RETURN_URL=${returnUrl}
CREATED_AT=${new Date().toISOString()}
`;
    
    fs.writeFileSync(envFile, envContent);
    console.log('[settings] Fichier .env créé avec URL de retour:', returnUrl);
    
    // Créer le dossier /data/logs s'il n'existe pas
    const logsDir = '/data/logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    // Démarrer le service en arrière-plan avec nohup et setsid pour survivre au redémarrage PM2
    // Rediriger les logs vers /data/logs/update-monitor.log pour debugging
    const logFile = path.join(logsDir, 'update-monitor.log');
    const startScript = path.join(tmpDir, 'start-monitor.sh');
    const startScriptContent = `#!/bin/bash
cd ${tmpDir}
echo "=== Service Update Monitor démarré à $(date) ===" > ${logFile}
echo "URL de retour: ${returnUrl}" >> ${logFile}
nohup node ${monitorScript} > /dev/null 2>&1 &
echo $!
`;
    
    fs.writeFileSync(startScript, startScriptContent);
    fs.chmodSync(startScript, '755');
    
    console.log('[settings] Script de démarrage créé:', startScript);
    
    // Lancer le script avec setsid pour créer une nouvelle session
    const result = execSync(`setsid ${startScript}`, { encoding: 'utf8' }).trim();
    const pid = parseInt(result);
    
    console.log('[settings] Service de monitoring démarré (PID:', pid, ')');
    console.log('[settings] Le service tournera sur le port 3001');
    console.log('[settings] Il se supprimera automatiquement après la mise à jour');
    console.log('[settings] Le processus survivra au redémarrage PM2');
    
    // Vérifier que le processus est bien lancé
    try {
      execSync(`ps -p ${pid}`, { stdio: 'ignore' });
      console.log('[settings] ✓ Processus confirmé actif');
    } catch (e) {
      throw new Error('Le processus de monitoring n\'a pas démarré correctement');
    }
    
    res.json({ 
      success: true, 
      message: 'Service de monitoring démarré',
      pid: pid,
      port: 3001
    });
  } catch (error: any) {
    console.error('[settings] Erreur démarrage service monitoring:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/settings/update-ryvie - Mettre à jour Ryvie
router.post('/settings/update-ryvie', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    console.log('[settings] Démarrage de la mise à jour de Ryvie...');
    
    // Notifier tous les clients connectés qu'une mise à jour démarre
    const io = (global as any).io;
    if (io) {
      io.emit('system-update-started', { message: 'Mise à jour système en cours' });
      console.log('[settings] 📡 Notification de mise à jour diffusée via WebSocket');
    }
    
    const result = await updateRyvie();
    
    if (result.success && result.needsRestart) {
      // Envoyer la réponse immédiatement
      res.json({
        success: true,
        message: 'Code mis à jour. Redémarrage en cours...'
      });
      
      const snapshotPath = result.snapshotPath;
      
      // Enregistrer le snapshot pour vérification au prochain démarrage
      if (snapshotPath) {
        const { registerPendingSnapshot } = require('../utils/snapshotCleanup');
        registerPendingSnapshot(snapshotPath);
      }
      
      // Redémarrer PM2 après un court délai (pour que la réponse soit envoyée)
      setTimeout(() => {
        const { execSync } = require('child_process');
        console.log('[settings] Redémarrage PM2...');
        
        try {
          execSync('/usr/local/bin/pm2 reload all --force', { stdio: 'inherit' });
          console.log('[settings] PM2 reload lancé');
        } catch (error: any) {
          console.error('[settings] ❌ Erreur lors du redémarrage PM2:', error.message);
        }
      }, 1000);
      
    } else if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error('[settings] Erreur lors de la mise à jour de Ryvie:', error);
    res.status(500).json({ 
      success: false,
      error: 'Erreur lors de la mise à jour',
      details: error.message 
    });
  }
});

// Map pour stocker les workers de mise à jour actifs (appName -> worker process)
const activeUpdateWorkers = new Map();

// Map pour stocker la dernière progression de chaque mise à jour (appName -> { progress, message, stage })
const lastUpdateProgressMap = new Map();

/**
 * GET /api/settings/update-progress/:appName - Server-Sent Events pour suivre la progression de mise à jour
 */
router.get('/settings/update-progress/:appName', verifyToken, (req: any, res: any) => {
  const appName = req.params.appName;
  
  // Configurer les headers pour SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
  });
  
  // Vérifier si la mise à jour est active
  const isActive = activeUpdateWorkers.has(appName);
  
  // Récupérer la dernière progression connue
  const lastProgressData = lastUpdateProgressMap.get(appName) || { progress: 0, message: 'Mise à jour en cours...', stage: 'active' };
  
  // Envoyer un ping initial avec le statut et la vraie progression
  if (isActive) {
    res.write(`data: ${JSON.stringify({ appName, ...lastProgressData })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ appName, progress: 0, message: 'Mise à jour non trouvée', stage: 'inactive' })}\n\n`);
    res.end();
    return;
  }
  
  let lastProgressValue = 0;
  
  // Écouter les événements de progression pour cette app
  const progressListener = (update) => {
    if (update.appName === appName) {
      lastProgressValue = update.progress || 0;
      // Sauvegarder la dernière progression dans la Map
      lastUpdateProgressMap.set(appName, { progress: update.progress || 0, message: update.message, stage: update.stage });
      res.write(`data: ${JSON.stringify(update)}\n\n`);
      
      // Fermer la connexion si la mise à jour est terminée
      if (update.progress >= 100 || update.stage === 'completed' || update.stage === 'error') {
        setTimeout(() => {
          updateProgressEmitter.off('progress', progressListener);
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          res.end();
        }, 1000);
      }
    }
  };
  
  updateProgressEmitter.on('progress', progressListener);
  
  // Heartbeat toutes les 5 secondes pour garder la connexion vivante
  const heartbeatInterval = setInterval(() => {
    if (!activeUpdateWorkers.has(appName)) {
      // La mise à jour n'est plus active
      res.write(`data: ${JSON.stringify({ appName, progress: lastProgressValue, message: 'Mise à jour terminée ou annulée', stage: 'inactive' })}\n\n`);
      clearInterval(heartbeatInterval);
      updateProgressEmitter.off('progress', progressListener);
      res.end();
    } else {
      // Envoyer un heartbeat
      res.write(`: heartbeat\n\n`);
    }
  }, 5000);
  
  // Nettoyer l'écouteur quand le client se déconnecte
  req.on('close', () => {
    updateProgressEmitter.off('progress', progressListener);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    res.end();
  });
  
  // Timeout de sécurité (30 minutes)
  setTimeout(() => {
    updateProgressEmitter.off('progress', progressListener);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    res.end();
  }, 30 * 60 * 1000);
});

/**
 * GET /api/settings/active-updates - Retourne la liste des mises à jour en cours
 */
router.get('/settings/active-updates', verifyToken, (req: any, res: any) => {
  const activeUpdates = Array.from(activeUpdateWorkers.keys());
  res.json({
    success: true,
    updates: activeUpdates
  });
});

// POST /api/settings/update-app - Mettre à jour une application
router.post('/settings/update-app', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const { appName } = req.body;
    
    if (!appName) {
      return res.status(400).json({ 
        success: false,
        error: 'Nom de l\'application requis' 
      });
    }
    
    // Vérifier si une mise à jour est déjà en cours pour cette app
    if (activeUpdateWorkers.has(appName)) {
      return res.status(409).json({
        success: false,
        error: 'Mise à jour déjà en cours',
        message: `Une mise à jour est déjà en cours pour ${appName}`
      });
    }
    
    console.log(`[settings] Lancement de la mise à jour de ${appName} dans un processus séparé...`);
    
    // Répondre immédiatement au client
    res.json({
      success: true,
      message: `Mise à jour de ${appName} lancée en arrière-plan`,
      appName: appName
    });
    
    // Lancer la mise à jour dans un processus enfant séparé (non-bloquant)
    const { fork } = require('child_process');
    const workerPath = require('path').join(__dirname, '../workers/updateWorker.js');
    
    const worker = fork(workerPath, [appName], {
      detached: false,
      stdio: 'inherit'
    });
    
    // Stocker le worker actif
    activeUpdateWorkers.set(appName, worker);
    
    worker.on('message', (message) => {
      if (message.type === 'log') {
        console.log(`[UpdateWorker ${appName}]`, message.message);
      } else if (message.type === 'progress') {
        // Retransmettre les événements de progression au updateProgressEmitter principal
        updateProgressEmitter.emit('progress', message.data);
      }
    });
    
    worker.on('exit', (code) => {
      // Retirer le worker de la map quand il se termine
      activeUpdateWorkers.delete(appName);
      // Nettoyer la progression sauvegardée
      lastUpdateProgressMap.delete(appName);
      
      if (code === 0) {
        console.log(`[settings] ✅ Mise à jour de ${appName} terminée avec succès`);
      } else {
        console.error(`[settings] ❌ Mise à jour de ${appName} échouée avec le code ${code}`);
        
        // Émettre un événement de progression d'erreur pour notifier le frontend
        updateProgressEmitter.emit('progress', {
          appName: appName,
          progress: 0,
          message: 'Erreur lors de la mise à jour',
          stage: 'error'
        });
      }
    });
    
    worker.on('error', (error) => {
      console.error(`[settings] ❌ Erreur du worker pour ${appName}:`, error);
      activeUpdateWorkers.delete(appName);
      lastUpdateProgressMap.delete(appName);
      
      // Émettre un événement de progression d'erreur pour notifier le frontend
      updateProgressEmitter.emit('progress', {
        appName: appName,
        progress: 0,
        message: error.message || 'Erreur lors de la mise à jour',
        stage: 'error'
      });
    });
    
  } catch (error: any) {
    console.error(`[settings] Erreur lors du lancement de la mise à jour:`, error);
    res.status(500).json({ 
      success: false,
      error: 'Erreur lors de la mise à jour',
      details: error.message 
    });
  }
});

// GET /api/machine-id - Public endpoint returning the Ryvie machine ID
router.get('/machine-id', (req: any, res: any) => {
  try {
    const settings = loadSettings();
    const ryvieId = settings?.id;

    if (!ryvieId) {
      console.error('[settings] Impossible de récupérer l\'ID Ryvie (non défini)');
      return res.status(500).json({
        success: false,
        error: 'Unable to retrieve machine ID'
      });
    }

    return res.json({
      success: true,
      ryvieId
    });
  } catch (error: any) {
    console.error('[settings] Erreur lors de la récupération de l\'ID Ryvie:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to retrieve machine ID'
    });
  }
});

// GET /api/settings/ryvie-domains - Récupérer les domaines publics Netbird (nécessite authentification)
router.get('/settings/ryvie-domains', verifyToken, isAdmin, (req: any, res: any) => {
  try {
    // Accès réservé aux administrateurs (middleware isAdmin ci-dessus). Les URLs publiques
    // et la setup key sont sensibles (la setup key permet de rejoindre le VPN), mais on
    // autorise désormais un admin authentifié à les récupérer y compris en accès distant.
    // Les utilisateurs non-admins reçoivent 403 partout.
    console.log(`[settings] Accès ryvie-domains (admin) - Utilisateur: ${req.user?.username || req.user?.uid}`);

    // Charger settings pour récupérer l'id de l'instance
    const settings = loadSettings();

    // Lire le fichier netbird-data.json
    if (!fs.existsSync(NETBIRD_FILE)) {
      return res.status(404).json({ error: 'Fichier netbird-data.json non trouvé', ryvieId: settings?.id || null });
    }
    
    const data = fs.readFileSync(NETBIRD_FILE, 'utf8');
    const netbirdData = JSON.parse(data);

    const tunnelHost = netbirdData && netbirdData.received && netbirdData.received.backendHost
      ? netbirdData.received.backendHost
      : null;

    let setupKey = null;
    try {
      // La setup key NetBird peut être écrite à plusieurs emplacements selon le mode
      // de provisioning de la box. On essaie les chemins connus dans l'ordre.
      const envPath = ['/data/config/netbird/.env', '/netbird/.env']
        .find((p) => fs.existsSync(p));
      if (envPath) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const line = envContent.split(/\r?\n/).find(l => l.trim().startsWith('NETBIRD_SETUP_KEY='));
        if (line) {
          const baseKey = line.substring('NETBIRD_SETUP_KEY='.length).trim();
          // Ajouter l'IP du tunnel à la clé si disponible
          if (tunnelHost && baseKey) {
            setupKey = `${baseKey}-${tunnelHost}`;
          } else {
            setupKey = baseKey;
          }
        }
      }
    } catch (_: any) {}

    // Retourner les domaines publics avec l'ID
    if (netbirdData.domains) {
      res.json({
        success: true,
        id: netbirdData.id || null,
        ryvieId: settings?.id || null,
        domains: netbirdData.domains,
        tunnelHost: tunnelHost,
        setupKey: setupKey
      });
    } else {
      res.status(404).json({ error: 'Aucun domaine trouvé dans le fichier', ryvieId: settings?.id || null });
    }
  } catch (error: any) {
    console.error('[settings] Erreur lors de la lecture des domaines Netbird:', error);
    res.status(500).json({ 
      error: 'Erreur serveur',
      details: error.message 
    });
  }
});

// GET /api/settings/vpn-peers - Lister les appareils (peers) du réseau VPN Ryvie/NetBird
// Accessible à tout utilisateur authentifié (pas seulement les admins) : c'est une simple
// visibilité des appareils du réseau, sans information sensible (pas de clé de setup).
router.get('/settings/vpn-peers', verifyToken, async (req: any, res: any) => {
  try {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    let stdout = '';
    try {
      ({ stdout } = await execPromise('netbird status -d', { timeout: 10000 }));
    } catch (err: any) {
      return res.status(503).json({
        success: false,
        error: 'Impossible de récupérer le statut NetBird',
        details: err.message,
        peers: []
      });
    }

    // Parse de la section "Peers detail:" :
    //  - l'en-tête d'un peer est une ligne avec UNE seule espace de tête et se terminant par ':'
    //  - les lignes de détail commencent par au moins deux espaces (NetBird IP, Status, etc.)
    const lines = stdout.split(/\r?\n/);
    const peers: any[] = [];
    let current: any = null;

    for (const line of lines) {
      const header = line.match(/^ (\S[^:]*):\s*$/); // 1 espace + hostname + ':'
      if (header) {
        if (current) peers.push(current);
        const fqdn = header[1];
        current = {
          fqdn,
          hostname: fqdn.split('.')[0],
          ip: null,
          status: 'Unknown',
          connectionType: null,
          lastHandshake: null,
          latency: null
        };
        continue;
      }
      if (!current) continue;

      let m;
      if ((m = line.match(/NetBird IP:\s*(\S+)/))) { current.ip = (m[1] || '').replace(/\/\d+$/, ''); continue; }
      if ((m = line.match(/^\s*Status:\s*(\S+)/))) { current.status = m[1]; continue; }
      if ((m = line.match(/Connection type:\s*(.+?)\s*$/))) {
        current.connectionType = m[1] === '-' ? null : m[1];
        continue;
      }
      if ((m = line.match(/Last WireGuard handshake:\s*(.+?)\s*$/))) {
        current.lastHandshake = m[1] === '-' ? null : m[1];
        continue;
      }
      if ((m = line.match(/Latency:\s*(.+?)\s*$/))) {
        current.latency = m[1];
        continue;
      }
    }
    if (current) peers.push(current);

    // Extraire les infos de la box locale (le Ryvie lui-même) depuis le résumé de fin de
    // sortie : ce sont des lignes en colonne 0 (sans espace de tête), donc jamais capturées
    // comme peers ci-dessus. On l'ajoute comme "self" pour qu'il apparaisse dans la liste.
    let selfPeer: any = null;
    const selfFqdnMatch = stdout.match(/^FQDN:\s*(\S+)/m);
    const selfIpMatch = stdout.match(/^NetBird IP:\s*(\S+)/m);
    if (selfFqdnMatch || selfIpMatch) {
      const fqdn = selfFqdnMatch ? selfFqdnMatch[1] : 'ryvie';
      selfPeer = {
        fqdn,
        hostname: fqdn.split('.')[0],
        ip: selfIpMatch ? selfIpMatch[1].replace(/\/\d+$/, '') : null,
        status: 'Connected',
        self: true,
        connectionType: null,
        lastHandshake: null,
        latency: null
      };
    }

    // Ignorer les nœuds d'infrastructure NetBird (relais/routage du réseau de production),
    // qui ne sont pas de vrais appareils utilisateurs : hostnames "netbirdprod-node-*".
    const isInfra = (p: any) => /^netbirdprod/i.test(String(p.hostname || p.fqdn || ''));
    let filtered = peers.filter(p => !isInfra(p));

    // Ne pas dupliquer la box locale si elle apparaît aussi dans la liste des peers
    if (selfPeer) {
      filtered = filtered.filter(p => p.ip !== selfPeer.ip && p.fqdn !== selfPeer.fqdn);
    }

    // Peers connectés en premier, puis tri alphabétique par nom
    filtered.sort((a, b) => {
      const ca = /connected/i.test(a.status) ? 0 : 1;
      const cb = /connected/i.test(b.status) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return String(a.hostname).localeCompare(String(b.hostname));
    });

    // La box locale toujours en tête
    const finalPeers = selfPeer ? [selfPeer, ...filtered] : filtered;

    res.json({
      success: true,
      count: finalPeers.length,
      connected: finalPeers.filter(p => /connected/i.test(p.status)).length,
      peers: finalPeers
    });
  } catch (error: any) {
    console.error('[settings] Erreur lors de la récupération des peers VPN:', error);
    res.status(500).json({ success: false, error: 'Erreur serveur', details: error.message, peers: [] });
  }
});

export = router;
