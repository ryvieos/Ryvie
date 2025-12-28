const express = require('express');
const router = express.Router();
const { verifyToken, hasPermission } = require('../middleware/auth');
const { getApps, getAppById, clearCache, getStoreHealth, getRateLimitInfo, updateAppFromStore, uninstallApp, progressEmitter } = require('../services/appStoreService');
const { checkStoreCatalogUpdate } = require('../services/updateCheckService');
const { updateStoreCatalog } = require('../services/updateService');

// Map pour stocker les workers actifs (appId -> worker process)
const activeWorkers = new Map();

// Map pour stocker la dernière progression de chaque installation (appId -> { progress, message, stage })
const lastProgressMap = new Map();

/**
 * GET /api/appstore/active-installations - Retourne la liste des installations en cours
 */
router.get('/appstore/active-installations', verifyToken, (req: any, res: any) => {
  const activeInstallations = Array.from(activeWorkers.keys());
  res.json({
    success: true,
    installations: activeInstallations
  });
});

/**
 * GET /api/appstore/apps - Liste toutes les apps disponibles
 */
router.get('/appstore/apps', async (req: any, res: any) => {
  try {
    const apps = await getApps();
    res.json({
      success: true,
      count: Array.isArray(apps) ? apps.length : 0,
      data: apps || []
    });
  } catch (error: any) {
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
router.get('/appstore/apps/:id', async (req: any, res: any) => {
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
  } catch (error: any) {
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
router.get('/appstore/health', async (req: any, res: any) => {
  try {
    const health = await getStoreHealth();
    res.json(health);
  } catch (error: any) {
    console.error('[appStore] Erreur lors de la récupération de la santé:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

/**
 * GET /api/appstore/rate-limit - Informations sur les limites GitHub API
 * 
 * IMPORTANT : Cet endpoint ne consomme AUCUNE requête GitHub !
 * Il lit simplement les données en mémoire mises à jour lors des vraies requêtes.
 */
router.get('/appstore/rate-limit', async (req: any, res: any) => {
  try {
    const rateLimitInfo = getRateLimitInfo();
    
    // Calculer des informations supplémentaires
    const info: any = { ...rateLimitInfo };
    
    if (rateLimitInfo.limit && rateLimitInfo.remaining !== null) {
      info.percentUsed = ((rateLimitInfo.limit - rateLimitInfo.remaining) / rateLimitInfo.limit * 100).toFixed(1);
      info.percentRemaining = (rateLimitInfo.remaining / rateLimitInfo.limit * 100).toFixed(1);
    }
    
    if (rateLimitInfo.reset) {
      const resetDate = new Date(rateLimitInfo.reset * 1000);
      info.resetDate = resetDate.toISOString();
      info.minutesUntilReset = Math.ceil((resetDate.getTime() - Date.now()) / 60000);
    }
    
    // Ajouter un statut
    if (!rateLimitInfo.limit) {
      info.status = 'unknown';
      info.message = 'Aucune requête GitHub effectuée encore';
    } else if (rateLimitInfo.remaining === 0) {
      info.status = 'exceeded';
      info.message = 'Limite atteinte - attendez la réinitialisation';
    } else if (rateLimitInfo.remaining < 10) {
      info.status = 'critical';
      info.message = 'Limite presque atteinte';
    } else if (rateLimitInfo.remaining < rateLimitInfo.limit * 0.2) {
      info.status = 'warning';
      info.message = 'Moins de 20% de requêtes restantes';
    } else {
      info.status = 'ok';
      info.message = 'Limite GitHub OK';
    }
    
    res.set('Content-Type', 'application/json');
    res.send(JSON.stringify(info, null, 2));
  } catch (error: any) {
    console.error('[appStore] Erreur lors de la récupération du rate limit:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

/**
 * GET /api/appstore/check - Vérifie les mises à jour du catalogue
 */
router.get('/appstore/check', verifyToken, async (req: any, res: any) => {
  try {
    console.log('[appStore] Vérification des mises à jour du catalogue...');
    const update = await checkStoreCatalogUpdate();
    res.json(update);
  } catch (error: any) {
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
router.post('/appstore/update', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  try {
    console.log('[appStore] Lancement de la mise à jour du catalogue...');
    const result = await updateStoreCatalog();
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
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
router.post('/appstore/cache/clear', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  try {
    await clearCache();
    res.json({
      success: true,
      message: 'Cache local effacé'
    });
  } catch (error: any) {
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
router.get('/appstore/progress/:appId', (req: any, res: any) => {
  const appId = req.params.appId;
  
  // Configurer les headers pour SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
  });
  
  // Vérifier si l'installation est active
  const isActive = activeWorkers.has(appId);
  
  // Récupérer la dernière progression connue
  const lastProgressData = lastProgressMap.get(appId) || { progress: 0, message: 'Installation en cours...', stage: 'active' };
  
  // Envoyer un ping initial avec le statut et la vraie progression
  if (isActive) {
    res.write(`data: ${JSON.stringify({ appId, ...lastProgressData })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ appId, progress: 0, message: 'Installation non trouvée', stage: 'inactive' })}\n\n`);
    res.end();
    return;
  }
  
  let lastProgressValue = 0;
  
  // Écouter les événements de progression pour cette app
  const progressListener = (update) => {
    if (update.appId === appId) {
      lastProgressValue = update.progress || 0;
      // Sauvegarder la dernière progression dans la Map
      lastProgressMap.set(appId, { progress: update.progress || 0, message: update.message, stage: update.stage });
      res.write(`data: ${JSON.stringify(update)}\n\n`);
      
      // Fermer la connexion si l'installation est terminée
      if (update.progress >= 100 || update.stage === 'completed' || update.stage === 'error') {
        setTimeout(() => {
          progressEmitter.off('progress', progressListener);
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          res.end();
        }, 1000);
      }
    }
  };
  
  progressEmitter.on('progress', progressListener);
  
  // Heartbeat toutes les 5 secondes pour garder la connexion vivante
  const heartbeatInterval = setInterval(() => {
    if (!activeWorkers.has(appId)) {
      // L'installation n'est plus active
      res.write(`data: ${JSON.stringify({ appId, progress: lastProgressValue, message: 'Installation terminée ou annulée', stage: 'inactive' })}\n\n`);
      clearInterval(heartbeatInterval);
      progressEmitter.off('progress', progressListener);
      res.end();
    } else {
      // Envoyer un heartbeat
      res.write(`: heartbeat\n\n`);
    }
  }, 5000);
  
  // Nettoyer l'écouteur quand le client se déconnecte
  req.on('close', () => {
    progressEmitter.off('progress', progressListener);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    res.end();
  });
  
  // Timeout de sécurité (30 minutes)
  setTimeout(() => {
    progressEmitter.off('progress', progressListener);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    res.end();
  }, 30 * 60 * 1000);
});

/**
 * POST /api/appstore/apps/:id/install - Installe ou met à jour une app depuis l'App Store
 * L'installation se fait dans un processus séparé pour ne pas bloquer le serveur
 */
router.post('/appstore/apps/:id/install', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
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
    
    // Stocker le worker actif pour pouvoir l'annuler plus tard
    activeWorkers.set(appId, worker);
    
    worker.on('message', (message) => {
      if (message.type === 'log') {
        console.log(`[Worker ${appId}]`, message.message);
      } else if (message.type === 'progress') {
        // Retransmettre les événements de progression au progressEmitter principal
        progressEmitter.emit('progress', message.data);
      }
    });
    
    worker.on('exit', (code) => {
      // Retirer le worker de la map quand il se termine
      activeWorkers.delete(appId);
      // Nettoyer la progression sauvegardée
      lastProgressMap.delete(appId);
      
      if (code === 0) {
        console.log(`[appStore] ✅ Installation de ${appId} terminée avec succès`);
      } else {
        console.error(`[appStore] ❌ Installation de ${appId} échouée avec le code ${code}`);
        
        // Émettre un événement de progression d'erreur pour notifier le frontend
        progressEmitter.emit('progress', {
          appId: appId,
          progress: 0,
          message: 'Erreur lors de l\'installation/mise à jour',
          stage: 'error'
        });
      }
    });
    
    worker.on('error', (error) => {
      console.error(`[appStore] ❌ Erreur du worker pour ${appId}:`, error);
      activeWorkers.delete(appId);
      lastProgressMap.delete(appId);
      
      // Émettre un événement de progression d'erreur pour notifier le frontend
      progressEmitter.emit('progress', {
        appId: appId,
        progress: 0,
        message: error.message || 'Erreur lors de l\'installation/mise à jour',
        stage: 'error'
      });
    });
    
  } catch (error: any) {
    console.error(`[appStore] Erreur lors du lancement de l'installation de ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/appstore/apps/:id/cancel - Annule une installation en cours
 */
router.post('/appstore/apps/:id/cancel', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  try {
    const appId = req.params.id;
    console.log(`[appStore] 🛑 Demande d'annulation de l'installation de ${appId}...`);
    
    // Vérifier si un worker est actif pour cette app
    const worker = activeWorkers.get(appId);
    
    if (!worker) {
      console.log(`[appStore] ⚠️ Aucune installation en cours pour ${appId}`);
      return res.json({
        success: true,
        message: `Aucune installation en cours pour ${appId}`,
        appId: appId
      });
    }
    
    // Tuer le processus worker
    console.log(`[appStore] 🔪 Arrêt du worker pour ${appId}...`);
    worker.kill('SIGTERM');
    
    // Retirer de la map
    activeWorkers.delete(appId);
    lastProgressMap.delete(appId);
    
    // Envoyer un événement de progression pour informer le frontend
    progressEmitter.emit('progress', {
      appId: appId,
      progress: 0,
      message: 'Installation annulée par l\'utilisateur',
      stage: 'cancelled'
    });
    
    console.log(`[appStore] ✅ Installation de ${appId} annulée avec succès`);
    
    res.json({
      success: true,
      message: `Installation de ${appId} annulée avec succès`,
      appId: appId
    });
    
  } catch (error: any) {
    console.error(`[appStore] Erreur lors de l'annulation de ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/appstore/apps/:id/uninstall - Désinstalle une application
 */
router.delete('/appstore/apps/:id/uninstall', verifyToken, hasPermission('manage_apps'), async (req: any, res: any) => {
  try {
    const appId = req.params.id;
    console.log(`[appStore] Lancement de la désinstallation de ${appId}...`);
    
    const result = await uninstallApp(appId);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error: any) {
    console.error(`[appStore] Erreur lors de la désinstallation de ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export = router;