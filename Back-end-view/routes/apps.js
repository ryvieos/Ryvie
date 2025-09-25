const express = require('express');
const router = express.Router();
const { verifyToken, hasPermission } = require('../middleware/auth');
const { getAppStatus, startApp, stopApp, restartApp } = require('../services/dockerService');

// GET /api/apps - list applications and status
router.get('/apps', async (req, res) => {
  try {
    const apps = await getAppStatus();
    res.status(200).json(apps);
  } catch (error) {
    console.error('Erreur lors de la récupération du statut des applications:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du statut des applications' });
  }
});

// POST /api/apps/:id/start - start an application
router.post('/apps/:id/start', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await startApp(id);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Erreur lors du démarrage de l'application ${id}:`, error);
    res.status(500).json({ error: `Erreur serveur lors du démarrage de l'application`, message: error.message });
  }
});

// POST /api/apps/:id/stop - stop an application
router.post('/apps/:id/stop', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await stopApp(id);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Erreur lors de l'arrêt de l'application ${id}:`, error);
    res.status(500).json({ error: `Erreur serveur lors de l'arrêt de l'application`, message: error.message });
  }
});

// POST /api/apps/:id/restart - restart an application
router.post('/apps/:id/restart', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await restartApp(id);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Erreur lors du redémarrage de l'application ${id}:`, error);
    res.status(500).json({ error: `Erreur serveur lors du redémarrage de l'application`, message: error.message });
  }
});

module.exports = router;
