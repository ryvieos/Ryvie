const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { verifyToken, hasPermission } = require('../middleware/auth');
const { getAppStatus, startApp, stopApp, restartApp } = require('../services/dockerService');
const appManager = require('../services/appManagerService');

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
