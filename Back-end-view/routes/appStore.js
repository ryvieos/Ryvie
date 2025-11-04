const express = require('express');
const router = express.Router();
const { verifyToken, hasPermission } = require('../middleware/auth');
const { getApps, getAppById, clearCache, getStoreHealth } = require('../services/appStoreService');
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

module.exports = router;