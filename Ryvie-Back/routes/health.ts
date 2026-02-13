const express = require('express');
const router = express.Router();
const startupTracker = require('../services/startupTracker');

/**
 * GET /api/health - Health check endpoint
 * Utilisé par le frontend pour détecter quand le backend est prêt après un redémarrage
 */
router.get('/health', (req: any, res: any) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: Date.now()
  });
});

/**
 * GET /api/health/ready - Readiness check endpoint
 * Retourne 200 uniquement quand TOUS les services sont initialisés (Keycloak, AppStore, etc.)
 * Utilisé par update-and-restart.sh pour attendre la fin complète du démarrage
 */
router.get('/health/ready', (req: any, res: any) => {
  const status = startupTracker.getStatus();
  
  if (status.ready) {
    res.status(200).json({ 
      status: 'ready',
      timestamp: Date.now(),
      services: status.services
    });
  } else {
    res.status(503).json({ 
      status: 'initializing',
      timestamp: Date.now(),
      pending: status.pending,
      services: status.services
    });
  }
});

export = router;
