const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { verifyToken } = require('../middleware/auth');

// Répertoire pour stocker les préférences utilisateur
const PREFERENCES_DIR = '/data/config/user-preferences';

// S'assurer que le répertoire existe
if (!fs.existsSync(PREFERENCES_DIR)) {
  fs.mkdirSync(PREFERENCES_DIR, { recursive: true });
}

/**
 * Récupère le fichier de préférences d'un utilisateur
 */
function getUserPreferencesPath(username) {
  return path.join(PREFERENCES_DIR, `${username}.json`);
}

/**
 * Charge les préférences d'un utilisateur
 */
function loadUserPreferences(username) {
  const filePath = getUserPreferencesPath(username);
  
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`[userPreferences] Erreur lecture préférences de ${username}:`, error);
      return null;
    }
  }
  
  return null;
}

/**
 * Sauvegarde les préférences d'un utilisateur
 */
function saveUserPreferences(username, preferences) {
  const filePath = getUserPreferencesPath(username);
  
  try {
    fs.writeFileSync(filePath, JSON.stringify(preferences, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`[userPreferences] Erreur sauvegarde préférences de ${username}:`, error);
    return false;
  }
}

// GET /api/user/preferences - Récupérer les préférences de l'utilisateur
router.get('/user/preferences', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username; // uid est le nom d'utilisateur dans le JWT
    console.log('[userPreferences] GET pour utilisateur:', username);
    const preferences = loadUserPreferences(username);
    
    if (preferences) {
      res.json(preferences);
    } else {
      // Retourner des préférences par défaut
      res.json({
        zones: {},
        theme: 'default',
        language: 'fr'
      });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur GET:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/user/preferences - Sauvegarder les préférences de l'utilisateur
router.post('/user/preferences', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] POST pour utilisateur:', username);
    const preferences = req.body;
    
    if (saveUserPreferences(username, preferences)) {
      res.json({ success: true, message: 'Préférences sauvegardées' });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur POST:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/zones - Mettre à jour uniquement les zones
router.patch('/user/preferences/zones', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH zones pour utilisateur:', username);
    const { zones } = req.body;
    
    // Charger les préférences existantes
    let preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    
    // Mettre à jour les zones
    preferences.zones = zones;
    
    if (saveUserPreferences(username, preferences)) {
      console.log('[userPreferences] Zones sauvegardées avec succès pour', username);
      res.json({ success: true, message: 'Zones sauvegardées' });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur PATCH zones:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
