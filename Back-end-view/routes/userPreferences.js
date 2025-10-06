const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');

// Répertoire pour stocker les préférences utilisateur
const PREFERENCES_DIR = '/data/config/user-preferences';
const BACKGROUNDS_DIR = '/data/apps/Ryvie/Ryvie-Front/public/images/backgrounds';

// S'assurer que les répertoires existent
if (!fs.existsSync(PREFERENCES_DIR)) {
  fs.mkdirSync(PREFERENCES_DIR, { recursive: true });
}
if (!fs.existsSync(BACKGROUNDS_DIR)) {
  fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
}

// Configuration de multer pour l'upload des fonds d'écran
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, BACKGROUNDS_DIR);
  },
  filename: (req, file, cb) => {
    const username = req.user.uid || req.user.username;
    const ext = path.extname(file.originalname);
    const filename = `${username}-${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Seules les images sont acceptées'));
    }
  }
});

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

// PATCH /api/user/preferences/background - Mettre à jour le fond d'écran
router.patch('/user/preferences/background', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH background pour utilisateur:', username);
    const { backgroundImage } = req.body;
    
    if (!backgroundImage) {
      return res.status(400).json({ error: 'backgroundImage requis' });
    }
    
    // Charger les préférences existantes
    let preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    
    // Mettre à jour le fond d'écran
    preferences.backgroundImage = backgroundImage;
    
    if (saveUserPreferences(username, preferences)) {
      console.log('[userPreferences] Fond d\'écran sauvegardé:', backgroundImage, 'pour', username);
      res.json({ success: true, message: 'Fond d\'écran sauvegardé' });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur PATCH background:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/user/preferences/background/upload - Uploader un fond d'écran personnalisé
router.post('/user/preferences/background/upload', verifyToken, upload.single('background'), async (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier uploadé' });
    }
    
    console.log('[userPreferences] Upload fond d\'écran pour:', username, '- Fichier:', req.file.filename);
    
    // Supprimer l'ancien fond personnalisé si existant
    const preferences = loadUserPreferences(username);
    if (preferences?.backgroundImage?.startsWith('custom-')) {
      const oldFilename = preferences.backgroundImage.replace('custom-', '');
      const oldPath = path.join(BACKGROUNDS_DIR, oldFilename);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
        console.log('[userPreferences] Ancien fond supprimé:', oldFilename);
      }
    }
    
    // Sauvegarder la référence dans les préférences
    const backgroundId = `custom-${req.file.filename}`;
    let userPrefs = preferences || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    userPrefs.backgroundImage = backgroundId;
    
    if (saveUserPreferences(username, userPrefs)) {
      res.json({ 
        success: true, 
        message: 'Fond d\'écran uploadé',
        backgroundImage: backgroundId
      });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur upload background:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// GET /api/user/preferences/background/image - Récupérer l'image de fond personnalisée
router.get('/user/preferences/background/image', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    const preferences = loadUserPreferences(username);
    
    if (!preferences?.backgroundImage?.startsWith('custom-')) {
      return res.status(404).json({ error: 'Pas de fond personnalisé' });
    }
    
    const filename = preferences.backgroundImage.replace('custom-', '');
    const imagePath = path.join(BACKGROUNDS_DIR, filename);
    
    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({ error: 'Image non trouvée' });
    }
    
    // Headers CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(imagePath);
  } catch (error) {
    console.error('[userPreferences] Erreur récupération image:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/backgrounds/default - Servir le fond d'écran par défaut
router.get('/backgrounds/default', (req, res) => {
  const defaultBgPath = path.join(BACKGROUNDS_DIR, 'background.webp');
  
  if (fs.existsSync(defaultBgPath)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(defaultBgPath);
  } else {
    res.status(404).json({ error: 'Fond par défaut non trouvé' });
  }
});

// GET /api/backgrounds/:filename - Servir une image de fond
router.get('/backgrounds/:filename', (req, res) => {
  const filename = req.params.filename;
  const imagePath = path.join(BACKGROUNDS_DIR, filename);
  
  if (fs.existsSync(imagePath)) {
    // Headers CORS pour permettre le chargement cross-origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h
    res.sendFile(imagePath);
  } else {
    res.status(404).json({ error: 'Image non trouvée' });
  }
});

module.exports = router;
