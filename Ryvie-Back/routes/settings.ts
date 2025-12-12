const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { checkAllUpdates } = require('../services/updateCheckService');
const { updateRyvie, updateApp } = require('../services/updateService');
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

// POST /api/settings/update-ryvie - Mettre à jour Ryvie
router.post('/settings/update-ryvie', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    console.log('[settings] Démarrage de la mise à jour de Ryvie...');
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
    
    console.log(`[settings] Démarrage de la mise à jour de ${appName}...`);
    const result = await updateApp(appName);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error(`[settings] Erreur lors de la mise à jour de l'app:`, error);
    res.status(500).json({ 
      success: false,
      error: 'Erreur lors de la mise à jour',
      details: error.message 
    });
  }
});

// GET /api/settings/ryvie-domains - Récupérer les domaines publics Netbird (local uniquement, sans token)
router.get('/settings/ryvie-domains', (req: any, res: any) => {
  try {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const clientIPRaw = xff || req.ip || req.connection.remoteAddress || '';
    const cleanIP = clientIPRaw.replace('::ffff:', '');
    const hostHeader = String(req.headers.host || '');
    const hostOnly = hostHeader.split(':')[0].toLowerCase();

    const isLocalHost = hostHeader.startsWith('localhost') || cleanIP === 'localhost' || hostOnly.endsWith('.local');
    const isLoopback = cleanIP === '127.0.0.1' || cleanIP.startsWith('127.') || cleanIP === '::1';

    let isPrivateIPv4 = false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(cleanIP)) {
      const [a,b] = cleanIP.split('.').map(n => parseInt(n,10));
      isPrivateIPv4 = cleanIP.startsWith('10.') ||
                      cleanIP.startsWith('192.168.') ||
                      (a === 172 && b >= 16 && b <= 31);
    }

    // IPv6 privé (ULA fc00::/7 => fc.. ou fd..), link-local fe80::/10
    const isPrivateIPv6 = cleanIP.startsWith('fc') || cleanIP.startsWith('fd') || cleanIP.startsWith('fe80:');

    const isLocal = isLocalHost || isLoopback || isPrivateIPv4 || isPrivateIPv6;

    // Refuser explicitement l'accès si la requête passe par un domaine public Netbird
    try {
      if (fs.existsSync(NETBIRD_FILE)) {
        const nb = JSON.parse(fs.readFileSync(NETBIRD_FILE, 'utf8')) || {};
        const domains = nb.domains ? Object.values(nb.domains).filter(Boolean).map(d => String(d).toLowerCase()) : [];
        if (domains.includes(hostOnly) || hostOnly.endsWith('.ryvie.fr')) {
          console.log(`[settings] Accès via domaine public Netbird refusé (${hostOnly})`);
          return res.status(403).json({ error: 'Accès refusé: cette API n\'est pas exposée via le domaine public' });
        }
      }
    } catch (_: any) {}

    // Bloquer le port public 3002 uniquement si la requête n'est PAS locale
    if (!isLocal && hostHeader.includes(':3002')) {
      console.log(`[settings] Accès via port public 3002 refusé pour ryvie-domains depuis ${clientIPRaw} (nettoyé: ${cleanIP})`);
      return res.status(403).json({ error: 'Accès refusé: cette API n\'est pas exposée via l\'adresse publique' });
    }

    if (!isLocal) {
      console.log(`[settings] Tentative d'accès non-local à ryvie-domains depuis ${clientIPRaw} (nettoyé: ${cleanIP})`);
      return res.status(403).json({ error: 'Accès refusé: cette API est uniquement accessible en local' });
    }
    
    console.log(`[settings] Accès autorisé à ryvie-domains depuis ${clientIPRaw} (nettoyé: ${cleanIP})`);
    
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
      const envPath = '/data/config/netbird/.env';
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const line = envContent.split(/\r?\n/).find(l => l.trim().startsWith('NETBIRD_SETUP_KEY='));
        if (line) {
          setupKey = line.substring('NETBIRD_SETUP_KEY='.length).trim();
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

export = router;
