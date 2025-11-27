const express = require('express');
const router = express.Router();
const { verifyToken, hasPermission } = require('../middleware/auth');
const { getApps, getAppById, clearCache, getStoreHealth, updateAppFromStore, uninstallApp, progressEmitter } = require('../services/appStoreService');
const { checkStoreCatalogUpdate } = require('../services/updateCheckService');
const { updateStoreCatalog } = require('../services/updateService');

/**
 * GET /api/appstore/apps - Liste toutes les apps disponibles
 */
router.get('/appstore/apps', async (req, res) => {
  try {
    const apps = await getApps();
    res.json({
      success: true,
      count: Array.isArray(apps) ? apps.length : 0,
      data: apps || []
    });
  } catch (error) {
    console.error('[appStore] Erreur lors de la récupération des apps:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/appstore/apps/:id - Récupère une app par son ID
 */
router.get('/appstore/apps/:id', async (req, res) => {
  try {
    const appId = req.params.id;
    const app = await getAppById(appId);
    
    if (!app) {
      return res.status(404).json({
        success: false,
        error: 'App not found'
      });
    }
    
    res.json({
      success: true,
      data: app
    });
  } catch (error) {
    console.error(`[appStore] Erreur lors de la récupération de l'app ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/appstore/health - Santé du service
 */
router.get('/appstore/health', async (req, res) => {
  try {
    const health = await getStoreHealth();
    res.json(health);
  } catch (error) {
    console.error('[appStore] Erreur lors de la récupération de la santé:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

/**
 * GET /api/appstore/check - Vérifie les mises à jour du catalogue
 */
router.get('/appstore/check', verifyToken, async (req, res) => {
  try {
    console.log('[appStore] Vérification des mises à jour du catalogue...');
    const update = await checkStoreCatalogUpdate();
    res.json(update);
  } catch (error) {
    console.error('[appStore] Erreur lors de la vérification:', error);
    res.status(500).json({
      error: 'Erreur lors de la vérification des mises à jour',
      details: error.message
    });
  }
});

/**
 * POST /api/appstore/update - Met à jour le catalogue
 */
router.post('/appstore/update', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  try {
    console.log('[appStore] Lancement de la mise à jour du catalogue...');
    const result = await updateStoreCatalog();
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('[appStore] Erreur lors de la mise à jour:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/appstore/cache/clear - Efface le cache local
 */
router.post('/appstore/cache/clear', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  try {
    await clearCache();
    res.json({
      success: true,
      message: 'Cache local effacé'
    });
  } catch (error) {
    console.error('[appStore] Erreur lors de l\'effacement du cache:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/appstore/progress/:appId - Server-Sent Events pour suivre la progression d'installation
 */
router.get('/appstore/progress/:appId', (req, res) => {
  const appId = req.params.appId;
  
  // Configurer les headers pour SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
  });
  
  // Envoyer un ping initial
  res.write(`data: ${JSON.stringify({ appId, progress: 0, message: 'Connexion établie', stage: 'connected' })}\n\n`);
  
  // Écouter les événements de progression pour cette app
  const progressListener = (update) => {
    if (update.appId === appId) {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
      
      // Fermer la connexion si l'installation est terminée
      if (update.progress >= 100 || update.stage === 'completed') {
        setTimeout(() => {
          res.end();
        }, 1000);
      }
    }
  };
  
  progressEmitter.on('progress', progressListener);
  
  // Nettoyer l'écouteur quand le client se déconnecte
  req.on('close', () => {
    progressEmitter.off('progress', progressListener);
    res.end();
  });
  
  // Timeout de sécurité (30 minutes)
  setTimeout(() => {
    progressEmitter.off('progress', progressListener);
    res.end();
  }, 30 * 60 * 1000);
});

/**
 * POST /api/appstore/apps/:id/install - Installe ou met à jour une app depuis l'App Store
 * L'installation se fait dans un processus séparé pour ne pas bloquer le serveur
 */
router.post('/appstore/apps/:id/install', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  try {
    const appId = req.params.id;
    console.log(`[appStore] Lancement de l'installation/mise à jour de ${appId} dans un processus séparé...`);
    
    // Répondre immédiatement au client
    res.json({
      success: true,
      message: `Installation de ${appId} lancée en arrière-plan`,
      appId: appId
    });
    
    // Lancer l'installation dans un processus enfant séparé (non-bloquant)
    const { fork } = require('child_process');
    const workerPath = require('path').join(__dirname, '../workers/installWorker.js');
    
    const worker = fork(workerPath, [appId], {
      detached: false,
      stdio: 'inherit'
    });
    
    worker.on('message', (message) => {
      if (message.type === 'log') {
        console.log(`[Worker ${appId}]`, message.message);
      } else if (message.type === 'progress') {
        // Retransmettre les événements de progression au progressEmitter principal
        progressEmitter.emit('progress', message.data);
      }
    });
    
    worker.on('exit', (code) => {
      if (code === 0) {
        console.log(`[appStore] ✅ Installation de ${appId} terminée avec succès`);
      } else {
        console.error(`[appStore] ❌ Installation de ${appId} échouée avec le code ${code}`);
      }
    });
    
    worker.on('error', (error) => {
      console.error(`[appStore] ❌ Erreur du worker pour ${appId}:`, error);
    });
    
  } catch (error) {
    console.error(`[appStore] Erreur lors du lancement de l'installation de ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/appstore/apps/:id/uninstall - Désinstalle une application
 */
router.delete('/appstore/apps/:id/uninstall', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  try {
    const appId = req.params.id;
    console.log(`[appStore] Lancement de la désinstallation de ${appId}...`);
    
    const result = await uninstallApp(appId);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error(`[appStore] Erreur lors de la désinstallation de ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;