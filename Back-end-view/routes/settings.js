const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { checkAllUpdates } = require('../services/updateCheckService');

const SETTINGS_FILE = '/data/config/server-settings.json';

// Charger les paramètres
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[settings] Erreur lors du chargement des paramètres:', error);
  }
  
  // Paramètres par défaut
  return {
    tokenExpirationMinutes: 15
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
  } catch (error) {
    console.error('[settings] Erreur lors de la sauvegarde des paramètres:', error);
    return false;
  }
}

// GET /api/settings/token-expiration - Récupérer la durée d'expiration du token
router.get('/settings/token-expiration', verifyToken, (req, res) => {
  try {
    const settings = loadSettings();
    res.json({ minutes: settings.tokenExpirationMinutes || 15 });
  } catch (error) {
    console.error('[settings] Erreur GET token-expiration:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/settings/token-expiration - Modifier la durée d'expiration du token
router.patch('/settings/token-expiration', verifyToken, (req, res) => {
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
  } catch (error) {
    console.error('[settings] Erreur PATCH token-expiration:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/settings/updates - Vérifier les mises à jour disponibles
router.get('/settings/updates', verifyToken, async (req, res) => {
  try {
    console.log('[settings] Vérification des mises à jour...');
    const updates = await checkAllUpdates();
    res.json(updates);
  } catch (error) {
    console.error('[settings] Erreur lors de la vérification des mises à jour:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la vérification des mises à jour',
      details: error.message 
    });
  }
});

module.exports = router;
