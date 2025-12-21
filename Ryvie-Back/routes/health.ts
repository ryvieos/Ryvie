const express = require('express');
const router = express.Router();

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

export = router;
