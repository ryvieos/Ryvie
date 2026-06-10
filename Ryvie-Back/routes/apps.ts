const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { verifyToken, hasPermission, isAdmin } = require('../middleware/auth');
const { getAppStatus, startApp, stopApp, restartApp } = require('../services/dockerService');
const appManager = require('../services/appManagerService');
const appAccounts = require('../services/appAccountsService');

// GET /api/apps - list applications and status
router.get('/apps', async (req: any, res: any) => {
  try {
    const apps = await getAppStatus();
    res.status(200).json(apps);
  } catch (error: any) {
    console.error('Erreur lors de la récupération du statut des applications:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du statut des applications' });
  }
});

// POST /api/apps/:id/start - start an application
router.post('/apps/:id/start', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  const { id } = req.params;
  try {
    // Essayer d'abord avec appManager (manifests)
    let result = await appManager.startApp(id);
    
    // Si échec, fallback sur dockerService
    if (!result.success) {
      result = await startApp(id);
    }
    
    res.status(200).json(result);
  } catch (error: any) {
    console.error(`Erreur lors du démarrage de l'application ${id}:`, error);
    res.status(500).json({ error: `Erreur serveur lors du démarrage de l'application`, message: error.message });
  }
});

// POST /api/apps/:id/stop - stop an application
router.post('/apps/:id/stop', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  const { id } = req.params;
  try {
    // Essayer d'abord avec appManager (manifests)
    let result = await appManager.stopApp(id);
    
    // Si échec, fallback sur dockerService
    if (!result.success) {
      result = await stopApp(id);
    }
    
    res.status(200).json(result);
  } catch (error: any) {
    console.error(`Erreur lors de l'arrêt de l'application ${id}:`, error);
    res.status(500).json({ error: `Erreur serveur lors de l'arrêt de l'application`, message: error.message });
  }
});

// POST /api/apps/:id/restart - restart an application
router.post('/apps/:id/restart', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  const { id } = req.params;
  try {
    // Essayer d'abord avec appManager (manifests)
    let result = await appManager.restartApp(id);
    
    // Si échec, fallback sur dockerService
    if (!result.success) {
      result = await restartApp(id);
    }
    
    res.status(200).json(result);
  } catch (error: any) {
    console.error(`Erreur lors du redémarrage de l'application ${id}:`, error);
    res.status(500).json({ error: `Erreur serveur lors du redémarrage de l'application`, message: error.message });
  }
});

// GET /api/apps/:id/icon - get application icon
router.get('/apps/:id/icon', async (req: any, res: any) => {
  const { id } = req.params;
  try {
    const iconPath = appManager.getAppIcon(id);
    
    if (!iconPath || !fs.existsSync(iconPath)) {
      // Retourner une icône générique si pas trouvée
      return res.status(404).json({ error: 'Icône non trouvée' });
    }

    // Déterminer le type MIME
    const ext = path.extname(iconPath).toLowerCase();
    const mimeTypes = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    // Headers CORS pour les icônes
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    const iconStream = fs.createReadStream(iconPath);
    iconStream.pipe(res);
  } catch (error: any) {
    console.error(`Erreur lors de la récupération de l'icône de ${id}:`, error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération de l\'icône' });
  }
});

// GET /api/apps/:id/accounts - list internal accounts of a non-SSO app (admin only)
router.get('/apps/:id/accounts', verifyToken, isAdmin, async (req: any, res: any) => {
  const { id } = req.params;
  try {
    const result = await appAccounts.listAccounts(id);
    res.status(200).json(result);
  } catch (error: any) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error(`Erreur lors du listing des comptes de ${id}:`, error.message);
    }
    res.status(status).json({ error: error.message || 'Erreur serveur' });
  }
});

// POST /api/apps/:id/accounts/:accountId/reset-password - reset an account password (admin only)
router.post('/apps/:id/accounts/:accountId/reset-password', verifyToken, isAdmin, async (req: any, res: any) => {
  const { id, accountId } = req.params;
  const { password } = req.body || {};
  try {
    await appAccounts.resetPassword(id, accountId, password);
    res.status(200).json({ success: true });
  } catch (error: any) {
    const status = error.status || 500;
    // Ne jamais logger le mot de passe — uniquement le message d'erreur.
    if (status >= 500) {
      console.error(`Erreur lors de la réinitialisation d'un compte de ${id}:`, error.message);
    }
    res.status(status).json({ success: false, error: error.message || 'Erreur serveur' });
  }
});

// POST /api/apps/:id/reset-owner - reset app owner access via its native CLI (admin only)
router.post('/apps/:id/reset-owner', verifyToken, isAdmin, async (req: any, res: any) => {
  const { id } = req.params;
  try {
    const result = await appAccounts.resetOwner(id);
    res.status(200).json(result);
  } catch (error: any) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error(`Erreur réinitialisation d'accès de ${id}:`, error.message);
    }
    res.status(status).json({ success: false, error: error.message || 'Erreur serveur' });
  }
});

// GET /api/apps/:id/default-credentials - default account status for an app (any authenticated user)
// Renvoie les identifiants par défaut UNIQUEMENT tant qu'ils n'ont pas été changés.
router.get('/apps/:id/default-credentials', verifyToken, async (req: any, res: any) => {
  const { id } = req.params;
  try {
    const status = await appAccounts.getDefaultStatus(id);
    res.status(200).json(status);
  } catch (error: any) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error(`Erreur statut compte par défaut de ${id}:`, error.message);
    }
    res.status(status).json({ error: error.message || 'Erreur serveur' });
  }
});

// GET /api/apps/manifests - list all apps with manifests
router.get('/apps/manifests', async (req: any, res: any) => {
  try {
    const apps = await appManager.listInstalledApps();
    res.status(200).json(apps);
  } catch (error: any) {
    console.error('Erreur lors de la récupération des manifests:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération des manifests' });
  }
});

export = router;
