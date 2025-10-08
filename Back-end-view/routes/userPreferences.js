const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const { verifyToken } = require('../middleware/auth');

// Répertoire pour stocker les préférences utilisateur
const PREFERENCES_DIR = '/data/config/user-preferences';
const BACKGROUNDS_DIR = '/data/images/backgrounds'; // Fonds uploadés par les utilisateurs
const PRESETS_DIR = '/opt/Ryvie/Ryvie-Front/public/images/backgrounds'; // Fonds prédéfinis

// S'assurer que les répertoires existent
if (!fs.existsSync(PREFERENCES_DIR)) {
  fs.mkdirSync(PREFERENCES_DIR, { recursive: true });
}
if (!fs.existsSync(BACKGROUNDS_DIR)) {
  fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
}

// GET /api/geocode/search?q=NAME - Chercher plusieurs villes (auto-complétion)
router.get('/geocode/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=fr&format=json`;
    const r = await axios.get(url, { timeout: 4000 });
    const items = (r.data?.results || []).map(it => ({
      name: it.name,
      country: it.country,
      latitude: it.latitude,
      longitude: it.longitude,
      admin1: it.admin1 || null
    }));
    res.json({ results: items });
  } catch (e) {
    console.error('[userPreferences] Erreur geocode/search:', e.message);
    res.json({ results: [] });
  }
});

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

// PATCH /api/user/preferences/weather-city - Mettre à jour la ville météo
router.patch('/user/preferences/weather-city', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH weather-city pour utilisateur:', username);
    const { weatherCity } = req.body;
    
    // Autoriser la suppression de la ville: if empty or '__auto__'
    const shouldClear = !weatherCity || weatherCity === '__auto__';
    
    // Charger les préférences existantes
    let preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    
    // Mettre à jour ou supprimer la ville météo
    if (shouldClear) {
      if (preferences.weatherCity) delete preferences.weatherCity;
    } else {
      preferences.weatherCity = weatherCity;
    }
    
    if (saveUserPreferences(username, preferences)) {
      console.log('[userPreferences] Ville météo sauvegardée:', shouldClear ? '(auto)' : weatherCity, 'pour', username);
      res.json({ success: true, message: shouldClear ? 'Ville météo supprimée (auto)' : 'Ville météo sauvegardée' });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur PATCH weather-city:', error);
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

// PATCH /api/user/preferences/dark-mode - Mettre à jour le mode sombre
router.patch('/user/preferences/dark-mode', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH dark-mode pour utilisateur:', username);
    const { darkMode } = req.body;
    
    if (darkMode === undefined) {
      return res.status(400).json({ error: 'darkMode requis' });
    }
    
    // Charger les préférences existantes
    let preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    
    // Mettre à jour le mode sombre
    preferences.darkMode = darkMode;
    
    if (saveUserPreferences(username, preferences)) {
      console.log('[userPreferences] Mode sombre sauvegardé:', darkMode, 'pour', username);
      res.json({ success: true, message: 'Mode sombre sauvegardé', darkMode });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur PATCH dark-mode:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/backgrounds/presets - Lister tous les fonds d'écran prédéfinis depuis public/
router.get('/backgrounds/presets', (req, res) => {
  try {
    console.log('[userPreferences] Liste des fonds prédéfinis depuis public/');
    
    // Lire tous les fichiers du dossier public/images/backgrounds
    const files = fs.existsSync(PRESETS_DIR) ? fs.readdirSync(PRESETS_DIR) : [];
    
    // Filtrer uniquement les images
    const presetBackgrounds = files
      .filter(file => /\.(jpg|jpeg|png|webp)$/i.test(file))
      .map(file => {
        const filePath = path.join(PRESETS_DIR, file);
        const stats = fs.statSync(filePath);
        const nameWithoutExt = path.parse(file).name;
        
        return {
          filename: file,
          id: `preset-${file}`, // Inclure l'extension dans l'ID
          name: nameWithoutExt.charAt(0).toUpperCase() + nameWithoutExt.slice(1).replace(/-/g, ' '),
          uploadDate: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)); // Tri alphabétique
    
    res.json({ backgrounds: presetBackgrounds });
  } catch (error) {
    console.error('[userPreferences] Erreur liste fonds prédéfinis:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/user/preferences/backgrounds/list - Lister les fonds personnalisés de l'utilisateur
router.get('/user/preferences/backgrounds/list', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] Liste des fonds pour:', username);
    
    // Lire tous les fichiers du dossier backgrounds
    const files = fs.readdirSync(BACKGROUNDS_DIR);
    
    // Filtrer les fichiers de l'utilisateur (format: username-timestamp.ext)
    const userBackgrounds = files
      .filter(file => file.startsWith(`${username}-`) && /\.(jpg|jpeg|png|webp)$/i.test(file))
      .map(file => {
        const filePath = path.join(BACKGROUNDS_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          id: `custom-${file}`,
          uploadDate: stats.mtime,
          size: stats.size
        };
      })
      .sort((a, b) => b.uploadDate - a.uploadDate); // Plus récent en premier
    
    res.json({ backgrounds: userBackgrounds });
  } catch (error) {
    console.error('[userPreferences] Erreur liste fonds:', error);
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

// GET /api/backgrounds/presets/:filename - Servir un fond prédéfini
router.get('/backgrounds/presets/:filename', (req, res) => {
  const filename = req.params.filename;
  const imagePath = path.join(PRESETS_DIR, filename);
  
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

// GET /api/backgrounds/:filename - Servir une image de fond uploadée
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

// DELETE /api/user/preferences/background/:filename - Supprimer un fond personnalisé
router.delete('/user/preferences/background/:filename', verifyToken, (req, res) => {
  try {
    const username = req.user.uid || req.user.username;
    const filename = req.params.filename;
    
    // Vérifier que le fichier appartient bien à l'utilisateur
    if (!filename.startsWith(`${username}-`)) {
      return res.status(403).json({ error: 'Accès interdit' });
    }
    
    const filePath = path.join(BACKGROUNDS_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Fichier non trouvé' });
    }
    
    // Supprimer le fichier
    fs.unlinkSync(filePath);
    console.log('[userPreferences] Fond supprimé:', filename);
    
    // Si c'était le fond actif, remettre le fond par défaut
    const preferences = loadUserPreferences(username);
    if (preferences?.backgroundImage === `custom-${filename}`) {
      preferences.backgroundImage = 'default';
      saveUserPreferences(username, preferences);
      console.log('[userPreferences] Fond actif remis par défaut');
    }
    
    res.json({ success: true, message: 'Fond supprimé' });
  } catch (error) {
    console.error('[userPreferences] Erreur suppression fond:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/geolocate - Obtenir la position via l'IP du client
router.get('/geolocate', async (req, res) => {
  try {
    // Récupérer l'IP du client
    let clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || req.socket.remoteAddress;
    
    // Nettoyer l'IP (enlever le préfixe IPv6 si présent)
    if (clientIp && clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.replace('::ffff:', '');
    }
    
    // Si l'IP est locale, essayer de récupérer l'IP publique
    const isLocalIp = !clientIp || 
                      clientIp === '::1' || 
                      clientIp === '127.0.0.1' || 
                      clientIp.startsWith('192.168.') || 
                      clientIp.startsWith('10.') ||
                      clientIp.startsWith('172.16.') ||
                      clientIp.startsWith('172.17.') ||
                      clientIp.startsWith('172.18.') ||
                      clientIp.startsWith('172.19.') ||
                      clientIp.startsWith('172.2') ||
                      clientIp.startsWith('172.30.') ||
                      clientIp.startsWith('172.31.');
    
    if (isLocalIp) {
      console.log('[userPreferences] IP locale détectée, récupération IP publique...');
      try {
        // Récupérer l'IP publique du serveur
        const ipResp = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
        clientIp = ipResp.data.ip;
        console.log('[userPreferences] IP publique récupérée:', clientIp);
      } catch (ipErr) {
        console.warn('[userPreferences] Impossible de récupérer IP publique:', ipErr.message);
      }
    }
    
    console.log('[userPreferences] Géolocalisation IP pour:', clientIp);
    
    // Utiliser une API de géolocalisation IP gratuite
    try {
      const geoResp = await axios.get(`http://ip-api.com/json/${clientIp}?fields=status,message,country,city,lat,lon`);
      
      if (geoResp.data.status === 'success') {
        console.log('[userPreferences] Géolocalisation réussie:', geoResp.data.city);
        res.json({
          city: geoResp.data.city,
          latitude: geoResp.data.lat,
          longitude: geoResp.data.lon,
          country: geoResp.data.country
        });
      } else {
        console.warn('[userPreferences] Géolocalisation échouée, fallback Paris');
        // Fallback sur Paris si l'IP est locale ou non trouvée
        res.json({
          city: 'Paris',
          latitude: 48.8566,
          longitude: 2.3522,
          country: 'France'
        });
      }
    } catch (apiErr) {
      console.error('[userPreferences] Erreur API géolocalisation:', apiErr.message);
      // Fallback sur Paris
      res.json({
        city: 'Paris',
        latitude: 48.8566,
        longitude: 2.3522,
        country: 'France'
      });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur géolocalisation:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/geocode/:city - Géocoder une ville pour obtenir ses coordonnées
router.get('/geocode/:city', async (req, res) => {
  try {
    const city = req.params.city;
    console.log('[userPreferences] Géocodage de:', city);
    
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=fr&format=json`;
    const geocodeResp = await axios.get(geocodeUrl);
    
    if (geocodeResp.data?.results?.[0]) {
      const result = geocodeResp.data.results[0];
      res.json({
        name: result.name,
        latitude: result.latitude,
        longitude: result.longitude,
        country: result.country
      });
    } else {
      res.status(404).json({ error: 'Ville non trouvée' });
    }
  } catch (error) {
    console.error('[userPreferences] Erreur géocodage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
