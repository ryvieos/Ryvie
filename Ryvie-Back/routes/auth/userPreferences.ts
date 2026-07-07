const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const { verifyToken } = require('../middleware/auth');
const { PREFERENCES_DIR, BACKGROUNDS_DIR, PRESETS_DIR, MANIFESTS_DIR } = require('../config/paths');

// Répertoire pour stocker les préférences utilisateur

// S'assurer que les répertoires existent
if (!fs.existsSync(PREFERENCES_DIR)) {
  fs.mkdirSync(PREFERENCES_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Sérialisation des cycles read-modify-write du fichier de préférences, PAR
// utilisateur. Plusieurs chemins écrivent le MÊME <user>.json sans coordination
// (reconcileAllUsersLayout appelé 1× par install -> 2× en parallèle quand on
// installe 2 apps d'un coup, le GET /user/preferences qui réconcilie+sauvegarde
// et que le front poll en boucle pendant l'install, et les PATCH de sauvegarde
// manuelle). Sans verrou, ces opérations s'entrelacent sur leurs `await` :
// l'une lit l'état S, une autre écrit S', puis la première réécrit (S + sa
// modif) en écrasant S' -> "lost update". L'écriture gagnante porte alors une
// base antérieure au dernier déplacement -> les icônes "reviennent" à leur
// ancienne position (même des apps pas en cours d'install).
//
// On enchaîne donc toutes les opérations d'un même utilisateur, et on relit le
// fichier À L'INTÉRIEUR du verrou (juste avant d'écrire) pour toujours partir
// du dernier état persisté.
const userPrefsLocks: { [username: string]: Promise<any> } = {};

function withUserPrefsLock<T>(username: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = userPrefsLocks[username] || Promise.resolve();
  // Exécuter fn après l'opération précédente, qu'elle ait réussi ou échoué.
  const run = prev.then(() => fn(), () => fn());
  // La chaîne stockée ne doit jamais rejeter, sinon les opérations suivantes
  // seraient court-circuitées : on neutralise son résultat.
  userPrefsLocks[username] = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Trouve une position libre dans la grille pour un item de taille width x height
 * @param layout - Layout actuel {itemId: {col, row, w, h}}
 * @param width - Largeur de l'item
 * @param height - Hauteur de l'item
 * @param maxCols - Nombre de colonnes max (défaut: 12)
 * @returns {col, row, w, h} ou null si aucune position libre
 */
function findFreePosition(layout: any, width: number = 1, height: number = 1, maxCols: number = 12) {
  const occupiedCells = new Set<string>();
  
  // Marquer toutes les cellules occupées
  for (const [id, pos] of Object.entries(layout)) {
    if (!pos || typeof pos !== 'object') continue;
    const p = pos as any;
    const w = p.w || 1;
    const h = p.h || 1;
    const col = p.col || 0;
    const row = p.row || 0;
    
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        occupiedCells.add(`${r},${c}`);
      }
    }
  }
  
  // Chercher une position libre ligne par ligne
  for (let row = 0; row < 100; row++) {
    for (let col = 0; col <= maxCols - width; col++) {
      let isFree = true;
      
      for (let r = row; r < row + height && isFree; r++) {
        for (let c = col; c < col + width && isFree; c++) {
          if (occupiedCells.has(`${r},${c}`)) {
            isFree = false;
          }
        }
      }
      
      if (isFree) {
        console.log(`[findFreePosition] Position libre trouvée: (${col}, ${row}) pour ${width}x${height}`);
        return { col, row, w: width, h: height };
      }
    }
  }
  
  console.warn(`[findFreePosition] Aucune position libre trouvée pour ${width}x${height}`);
  return null;
}

/**
 * Récupère la liste des ids d'apps installées (depuis /data/config/manifests)
 * Retourne un tableau d'ids formatés 'app-<id>'
 */
async function getInstalledAppIds() {
  const fs = require('fs');
  const path = require('path');
  const manifestsDir = MANIFESTS_DIR;
  const apps = [];
  try {
    if (!fs.existsSync(manifestsDir)) return apps;
    const appFolders = fs.readdirSync(manifestsDir).filter(f => {
      const stat = fs.statSync(path.join(manifestsDir, f));
      return stat.isDirectory();
    });
    for (const folder of appFolders) {
      const manifestPath = path.join(manifestsDir, folder, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.id) apps.push(`app-${manifest.id}`);
      } catch (_: any) {}
    }
  } catch (_: any) {}
  return apps;
}

/**
 * Fonction de réconciliation du layout pour tous les utilisateurs
 * À appeler après l'installation d'une nouvelle app
 */
async function reconcileAllUsersLayout() {
  const fs = require('fs');
  const path = require('path');
  
  try {
    console.log('[reconcileAllUsersLayout] 🔄 Début de la réconciliation pour tous les utilisateurs');
    
    // Récupérer la liste des apps installées
    const installed = await getInstalledAppIds();
    
    // Lire tous les fichiers de préférences
    if (!fs.existsSync(PREFERENCES_DIR)) {
      console.log('[reconcileAllUsersLayout] ℹ️ Aucun répertoire de préférences');
      return;
    }
    
    const files = fs.readdirSync(PREFERENCES_DIR).filter((f: string) => f.endsWith('.json'));
    
    for (const file of files) {
      const username = file.replace('.json', '');
      const filePath = path.join(PREFERENCES_DIR, file);

      // Sérialiser avec les autres écritures de cet utilisateur (autre install
      // concurrente, GET réconciliant, PATCH manuel) et relire le fichier ICI,
      // sous verrou, pour ne jamais repartir d'une base périmée.
      await withUserPrefsLock(username, () => {
      try {
        const preferences = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        if (!preferences.launcher) return;
        
        const existingApps = Array.isArray(preferences.launcher.apps) ? preferences.launcher.apps : [];
        const missing = installed.filter(id => !existingApps.includes(id));
        
        if (missing.length > 0) {
          const layout = preferences.launcher.layout || {};
          const anchors = preferences.launcher.anchors || {};
          
          let maxAnchor = 0;
          for (const a of Object.values(anchors)) {
            if (typeof a === 'number') maxAnchor = Math.max(maxAnchor, (a as number));
          }
          
          console.log(`[reconcileAllUsersLayout] 🆕 Placement de ${missing.length} app(s) pour ${username}:`, missing);
          
          missing.forEach((appId) => {
            if (layout[appId]) return;
            
            const pos = findFreePosition(layout, 1, 1, 12);
            if (pos) {
              layout[appId] = pos;
              console.log(`[reconcileAllUsersLayout] ✅ ${appId} placé à (${pos.col}, ${pos.row}) pour ${username}`);
            } else {
              const maxRow = Math.max(0, ...Object.values(layout).map((p: any) => (p.row || 0) + (p.h || 1)));
              layout[appId] = { col: 0, row: maxRow + 1, w: 1, h: 1 };
              console.log(`[reconcileAllUsersLayout] ⚠️ ${appId} placé à (0,${maxRow + 1}) pour ${username}`);
            }
            
            if (typeof anchors[appId] !== 'number') {
              const pos = layout[appId] as any;
              const BASE_COLS = 12;
              const anchorIndex = (pos.row || 0) * BASE_COLS + (pos.col || 0);
              anchors[appId] = anchorIndex;
              console.log(`[reconcileAllUsersLayout] 🔗 Ancre créée pour ${appId}: ${anchorIndex} (${username})`);
            }
          });
          
          preferences.launcher.layout = layout;
          preferences.launcher.anchors = anchors;
          preferences.launcher.apps = [...existingApps, ...missing];
          
          fs.writeFileSync(filePath, JSON.stringify(preferences, null, 2));
          console.log(`[reconcileAllUsersLayout] 💾 ${username}: ${missing.length} app(s) ajoutée(s)`);
        }
      } catch (err: any) {
        console.warn(`[reconcileAllUsersLayout] ⚠️ Erreur pour ${username}:`, err.message);
      }
      });
    }
    
    console.log('[reconcileAllUsersLayout] ✅ Réconciliation terminée');
  } catch (error: any) {
    console.error('[reconcileAllUsersLayout] ❌ Erreur:', error.message);
  }
}
if (!fs.existsSync(BACKGROUNDS_DIR)) {
  fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
}

// GET /api/geocode/search?q=NAME - Chercher plusieurs villes (auto-complétion)
router.get('/geocode/search', async (req: any, res: any) => {
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
  } catch (e: any) {
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
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
    } catch (error: any) {
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
  } catch (error: any) {
    console.error(`[userPreferences] Erreur sauvegarde préférences de ${username}:`, error);
    return false;
  }
}

/**
 * Génère un layout et des anchors par défaut à partir des apps installées
 * Layout par défaut avec widgets weather, cpu-ram et storage
 */
async function generateDefaultLauncher() {
  const maxCols = 12;
  
  // Widgets par défaut avec IDs corrects pour le frontend.
  // 'weather' est positionné dans layout/anchors ci-dessous : il doit AUSSI figurer
  // ici, sinon il n'est jamais rendu (c'était le bug du widget météo manquant).
  const defaultWidgets = [
    { id: 'weather', type: 'weather' },
    { id: 'widget-cpu-ram-0', type: 'cpu-ram' },
    { id: 'widget-storage-1', type: 'storage' }
  ];
  
  // Layout par défaut: weather + cpu-ram sur la ligne 0, storage et apps sur la ligne 2
  const layout: any = {
    weather: { col: 3, row: 0, w: 3, h: 2 },
    'widget-cpu-ram-0': { col: 6, row: 0, w: 2, h: 2 },
    'widget-storage-1': { col: 6, row: 2, w: 2, h: 2 }
  };
  
  // Ancres calculées: row * maxCols + col
  const anchors: any = {
    weather: 0 * maxCols + 3, // 3
    'widget-cpu-ram-0': 0 * maxCols + 6, // 6
    'widget-storage-1': 2 * maxCols + 6 // 30
  };
  
  try {
    // Charger les apps depuis les manifests
    const fs = require('fs');
    const path = require('path');
    const manifestsDir = MANIFESTS_DIR;
    
    const apps: string[] = [];
    if (fs.existsSync(manifestsDir)) {
      const appFolders = fs.readdirSync(manifestsDir).filter((f: string) => {
        const stat = fs.statSync(path.join(manifestsDir, f));
        return stat.isDirectory();
      });
      
      console.log('[generateDefaultLauncher] Dossiers trouvés:', appFolders);
      
      for (const folder of appFolders) {
        const manifestPath = path.join(manifestsDir, folder, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            console.log('[generateDefaultLauncher] Manifest lu:', folder, '-> id:', manifest.id);
            if (manifest.id) {
              apps.push(`app-${manifest.id}`);
            }
          } catch (e: any) {
            console.warn(`[generateDefaultLauncher] Erreur lecture manifest ${folder}:`, e.message);
          }
        } else {
          console.warn(`[generateDefaultLauncher] Manifest non trouvé: ${manifestPath}`);
        }
      }
    } else {
      console.warn('[generateDefaultLauncher] Répertoire manifests non trouvé:', manifestsDir);
    }
    
    // Placer les apps dans la zone à gauche du widget Storage (évite les collisions)
    // Zone apps: cols 0..5 (6 colonnes), à partir de row=2, avec wrap sur les lignes suivantes
    const APP_COL_START = 0;
    const APP_COL_END = 5;
    const APP_COLS = APP_COL_END - APP_COL_START + 1;
    let i = 0;

    apps.forEach(appId => {
      const col = APP_COL_START + (i % APP_COLS);
      const row = 2 + Math.floor(i / APP_COLS);
      layout[appId] = { col, row, w: 1, h: 1 };
      anchors[appId] = row * maxCols + col;
      i += 1;
    });
    
    console.log('[generateDefaultLauncher] Généré avec', apps.length, 'apps et', defaultWidgets.length, 'widgets:', apps);
    
    return {
      anchors,
      layout,
      widgets: defaultWidgets,
      apps
    };
  } catch (error: any) {
    console.error('[generateDefaultLauncher] Erreur:', error);
    return {
      anchors,
      layout,
      widgets: defaultWidgets,
      apps: []
    };
  }
}

// GET /api/user/preferences - Récupérer les préférences de l'utilisateur
router.get('/user/preferences', verifyToken, async (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username; // uid est le nom d'utilisateur dans le JWT
    console.log('[userPreferences] GET pour utilisateur:', username);
    const preferences = await withUserPrefsLock(username, async () => {
    let preferences = loadUserPreferences(username);

    if (!preferences) {
      // Créer des préférences par défaut avec le launcher par défaut complet
      const defaultLauncher = await generateDefaultLauncher();
      preferences = {
        zones: {},
        theme: 'default',
        language: 'fr',
        launcher: defaultLauncher,
        backgroundImage: 'preset-default.png'
      };
      console.log('[userPreferences] Création du fichier de préférences par défaut pour:', username, 'avec', defaultLauncher.apps.length, 'apps et', defaultLauncher.widgets.length, 'widgets');
      saveUserPreferences(username, preferences);
    } else if (!preferences.launcher || !preferences.launcher.apps || preferences.launcher.apps.length === 0) {
      // Si le fichier existe mais n'a pas de section launcher OU si apps est vide, générer les valeurs par défaut
      const defaultLauncher = await generateDefaultLauncher();
      preferences.launcher = defaultLauncher;
      // Ajouter le fond d'écran par défaut si absent
      if (!preferences.backgroundImage) {
        preferences.backgroundImage = 'preset-default.png';
      }
      console.log('[userPreferences] Génération du launcher par défaut pour:', username, 'avec', defaultLauncher.apps.length, 'apps et', defaultLauncher.widgets.length, 'widgets');
      saveUserPreferences(username, preferences);
    }

    // Réconciliation: ajouter les nouvelles apps détectées qui manquent dans le launcher
    try {
      const installed = await getInstalledAppIds();
      preferences.launcher = preferences.launcher || { anchors: {}, layout: {}, widgets: [], apps: [] };
      const existingApps = Array.isArray(preferences.launcher.apps) ? preferences.launcher.apps : [];
      const missing = installed.filter(id => !existingApps.includes(id));
      if (missing.length > 0) {
        const layout = preferences.launcher.layout || {};
        const anchors = preferences.launcher.anchors || {};
        
        // Trouver le max anchor existant pour démarrer à la suite
        let maxAnchor = 0;
        for (const a of Object.values(anchors)) {
          if (typeof a === 'number') maxAnchor = Math.max(maxAnchor, (a as number));
        }
        
        console.log(`[userPreferences] 🆕 Placement de ${missing.length} nouvelle(s) app(s):`, missing);
        console.log(`[userPreferences] 📊 Layout existant:`, Object.keys(layout).map(id => {
          const pos = layout[id] as any;
          return `${id}@(${pos?.col},${pos?.row})`;
        }).join(', '));
        
        // Placer chaque nouvelle app dans une position libre SANS TOUCHER aux positions existantes
        missing.forEach((appId) => {
          // Vérifier si l'app a déjà une position (ne devrait pas arriver mais sécurité)
          if (layout[appId]) {
            console.log(`[userPreferences] ℹ️ ${appId} a déjà une position, on la garde`);
            return;
          }
          
          // Trouver une position libre pour cette app (1x1)
          const pos = findFreePosition(layout, 1, 1, 12);
          if (pos) {
            layout[appId] = pos;
            console.log(`[userPreferences] ✅ ${appId} placé à (${pos.col}, ${pos.row})`);
          } else {
            // Fallback: placer à la fin de la grille
            const maxRow = Math.max(0, ...Object.values(layout).map((p: any) => (p.row || 0) + (p.h || 1)));
            layout[appId] = { col: 0, row: maxRow + 1, w: 1, h: 1 };
            console.warn(`[userPreferences] ⚠️ ${appId} placé à (0,${maxRow + 1}) - grille pleine`);
          }
          
          // Créer une ancre basée sur la position UNIQUEMENT pour les nouvelles apps
          if (typeof anchors[appId] !== 'number') {
            const pos = layout[appId] as any;
            const BASE_COLS = 12; // Grille de référence
            const anchorIndex = (pos.row || 0) * BASE_COLS + (pos.col || 0);
            anchors[appId] = anchorIndex;
            console.log(`[userPreferences] 🔗 Ancre créée pour ${appId}: ${anchorIndex}`);
          }
        });
        
        preferences.launcher.layout = layout;
        preferences.launcher.anchors = anchors;
        preferences.launcher.apps = [...existingApps, ...missing];
        console.log(`[userPreferences] 💾 Réconciliation terminée: ${missing.length} app(s) ajoutée(s)`);
        saveUserPreferences(username, preferences);
      }

      // Nettoyage: retirer les apps obsolètes (non installées)
      const obsolete = existingApps.filter(id => !installed.includes(id));
      if (obsolete.length > 0) {
        const layout = preferences.launcher.layout || {};
        const anchors = preferences.launcher.anchors || {};
        obsolete.forEach((appId) => {
          try { delete layout[appId]; } catch (_: any) {}
          try { delete anchors[appId]; } catch (_: any) {}
        });
        // Filtrer la liste des apps
        const cleanedApps = existingApps.filter(id => !obsolete.includes(id));
        preferences.launcher.layout = layout;
        preferences.launcher.anchors = anchors;
        preferences.launcher.apps = cleanedApps;
        console.log(`[userPreferences] Nettoyage: ${obsolete.length} app(s) supprimée(s) des préférences:`, obsolete);
        saveUserPreferences(username, preferences);
      }
    } catch (e: any) {
      console.warn('[userPreferences] Réconciliation des apps échouée:', e?.message);
    }

    return preferences;
    });

    res.json(preferences);
  } catch (error: any) {
    console.error('[userPreferences] Erreur GET:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/user/preferences - Sauvegarder les préférences de l'utilisateur
router.post('/user/preferences', verifyToken, async (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] POST pour utilisateur:', username);
    const preferences = req.body;

    const ok = await withUserPrefsLock(username, () => saveUserPreferences(username, preferences));
    if (ok) {
      res.json({ success: true, message: 'Préférences sauvegardées' });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur POST:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/zones - Mettre à jour uniquement les zones
router.patch('/user/preferences/zones', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH zones:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/launcher - Mettre à jour la disposition du launcher (anchors/layout/widgets/apps)
router.patch('/user/preferences/launcher', verifyToken, async (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH launcher pour utilisateur:', username);

    const launcher = req.body && req.body.launcher;
    if (!launcher || typeof launcher !== 'object') {
      return res.status(400).json({ error: 'launcher requis (object)' });
    }

    // Normaliser les champs du launcher
    const normalized = {
      anchors: launcher.anchors && typeof launcher.anchors === 'object' ? launcher.anchors : {},
      layout: launcher.layout && typeof launcher.layout === 'object' ? launcher.layout : {},
      widgets: launcher.widgets && typeof launcher.widgets === 'object' ? launcher.widgets : {},
      apps: Array.isArray(launcher.apps) ? launcher.apps : []
    };

    // Relire sous verrou (les autres clés restent à jour) puis écrire, sérialisé
    // avec les réconciliations d'install concurrentes.
    const saved = await withUserPrefsLock(username, () => {
      const preferences = loadUserPreferences(username) || {
        zones: {},
        theme: 'default',
        language: 'fr'
      };
      preferences.launcher = normalized;
      return saveUserPreferences(username, preferences) ? preferences : null;
    });

    if (saved) {
      console.log('[userPreferences] Launcher sauvegardé pour', username);
      return res.json({ success: true, launcher: saved.launcher });
    } else {
      return res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH launcher:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences - Merge générique de préférences (incluant éventuellement launcher)
router.patch('/user/preferences', verifyToken, async (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH generic pour utilisateur:', username);

    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Corps JSON requis' });
    }

    const incoming = req.body || {};

    const preferences = await withUserPrefsLock(username, () => {
    const preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };

    // Merge superficiel des clés fournies
    if (incoming.launcher && typeof incoming.launcher === 'object') {
      const l = incoming.launcher;
      preferences.launcher = {
        anchors: l.anchors && typeof l.anchors === 'object' ? l.anchors : (preferences.launcher?.anchors || {}),
        layout: l.layout && typeof l.layout === 'object' ? l.layout : (preferences.launcher?.layout || {}),
        widgets: l.widgets && typeof l.widgets === 'object' ? l.widgets : (preferences.launcher?.widgets || {}),
        apps: Array.isArray(l.apps) ? l.apps : (preferences.launcher?.apps || [])
      };
    }

    // Copier les autres clés simples si fournies
    // Valider la langue si fournie
    if ('language' in incoming) {
      if (incoming.language && ['fr', 'en'].includes(incoming.language)) {
        preferences.language = incoming.language;
      }
    }
    ['zones','theme','backgroundImage','darkMode','weatherCity','autoTheme'].forEach(k => {
      if (k in incoming) preferences[k] = incoming[k];
    });

    return saveUserPreferences(username, preferences) ? preferences : null;
    });

    if (preferences) {
      return res.json({ success: true, preferences });
    } else {
      return res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH generic:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/weather-city - Mettre à jour la ville météo
router.patch('/user/preferences/weather-city', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH weather-city:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/background - Mettre à jour le fond d'écran
router.patch('/user/preferences/background', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH background:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/dark-mode - Mettre à jour le mode sombre
router.patch('/user/preferences/dark-mode', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH dark-mode:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/language - Mettre à jour la langue de l'utilisateur
router.patch('/user/preferences/language', verifyToken, (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] PATCH language pour utilisateur:', username);
    const { language } = req.body;
    
    if (!language || !['fr', 'en'].includes(language)) {
      return res.status(400).json({ error: 'Langue invalide (fr ou en requis)' });
    }
    
    // Charger les préférences existantes
    let preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    
    // Mettre à jour la langue
    preferences.language = language;
    
    if (saveUserPreferences(username, preferences)) {
      console.log('[userPreferences] Langue sauvegardée:', language, 'pour', username);
      res.json({ success: true, message: 'Langue sauvegardée', language });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH language:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /api/user/preferences/opened-apps - Liste des apps déjà ouvertes (pilote la
// pastille bleue « jamais ouverte »). Stockée côté compte pour être cohérente entre
// navigateurs/appareils ; le front garde aussi un cache localStorage.
router.patch('/user/preferences/opened-apps', verifyToken, async (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    const { openedApps } = req.body;

    if (!Array.isArray(openedApps) || !openedApps.every((x: any) => typeof x === 'string')) {
      return res.status(400).json({ error: 'openedApps doit être un tableau de chaînes' });
    }
    // Dédoublonnage + borne de sécurité contre un payload abusif.
    const cleaned = Array.from(new Set(openedApps)).slice(0, 500);

    const saved = await withUserPrefsLock(username, async () => {
      const preferences = loadUserPreferences(username) || {
        zones: {},
        theme: 'default',
        language: 'fr'
      };
      preferences.openedApps = cleaned;
      return saveUserPreferences(username, preferences);
    });

    if (saved) {
      res.json({ success: true, openedApps: cleaned });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur PATCH opened-apps:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/backgrounds/presets - Lister tous les fonds d'écran prédéfinis depuis public/
router.get('/backgrounds/presets', (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur liste fonds prédéfinis:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/user/preferences/backgrounds/list - Lister les fonds personnalisés de l'utilisateur
router.get('/user/preferences/backgrounds/list', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur liste fonds:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/user/preferences/background/upload - Uploader un fond d'écran personnalisé
router.post('/user/preferences/background/upload', verifyToken, upload.single('background'), async (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur upload background:', error);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
});

// GET /api/user/preferences/background/image - Récupérer l'image de fond personnalisée
router.get('/user/preferences/background/image', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur récupération image:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/backgrounds/default - Servir le fond d'écran par défaut
router.get('/backgrounds/default', (req: any, res: any) => {
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
router.get('/backgrounds/presets/:filename', (req: any, res: any) => {
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
router.get('/backgrounds/:filename', (req: any, res: any) => {
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
router.delete('/user/preferences/background/:filename', verifyToken, (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur suppression fond:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/geolocate - Obtenir la position via l'IP du client
router.get('/geolocate', async (req: any, res: any) => {
  try {
    // Récupérer l'IP du client
    let clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.connection.remoteAddress || req.socket.remoteAddress;
    
    // Nettoyer l'IP (enlever le préfixe IPv6 si présent)
    if (clientIp && clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.replace('::ffff:', '');
    }
    
    // Si l'IP est locale, essayer de récupérer l'IP remote
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
      console.log('[userPreferences] IP locale détectée, récupération IP remote...');
      try {
        // Récupérer l'IP remote du serveur
        const ipResp = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
        clientIp = ipResp.data.ip;
        console.log('[userPreferences] IP remote récupérée:', clientIp);
      } catch (ipErr: any) {
        console.warn('[userPreferences] Impossible de récupérer IP remote:', ipErr.message);
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
    } catch (apiErr: any) {
      console.error('[userPreferences] Erreur API géolocalisation:', apiErr.message);
      // Fallback sur Paris
      res.json({
        city: 'Paris',
        latitude: 48.8566,
        longitude: 2.3522,
        country: 'France'
      });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur géolocalisation:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/geocode/:city - Géocoder une ville pour obtenir ses coordonnées
router.get('/geocode/:city', async (req: any, res: any) => {
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
  } catch (error: any) {
    console.error('[userPreferences] Erreur géocodage:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/user/onboarding-status - Vérifier si l'utilisateur a complété l'onboarding
router.get('/user/onboarding-status', verifyToken, (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    const preferences = loadUserPreferences(username);
    
    const hasCompletedOnboarding = preferences?.hasCompletedOnboarding || false;
    
    res.json({ 
      hasCompletedOnboarding,
      isFirstLogin: !hasCompletedOnboarding
    });
  } catch (error: any) {
    console.error('[userPreferences] Erreur onboarding-status:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/user/complete-onboarding - Marquer l'onboarding comme complété
router.post('/user/complete-onboarding', verifyToken, (req: any, res: any) => {
  try {
    const username = req.user.uid || req.user.username;
    console.log('[userPreferences] Marquage onboarding complété pour:', username);
    
    let preferences = loadUserPreferences(username) || {
      zones: {},
      theme: 'default',
      language: 'fr'
    };
    
    preferences.hasCompletedOnboarding = true;
    
    if (saveUserPreferences(username, preferences)) {
      console.log('[userPreferences] Onboarding marqué comme complété pour', username);
      res.json({ success: true, message: 'Onboarding complété' });
    } else {
      res.status(500).json({ error: 'Échec de la sauvegarde' });
    }
  } catch (error: any) {
    console.error('[userPreferences] Erreur complete-onboarding:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Attacher la fonction au router pour pouvoir l'exporter
(router as any).reconcileAllUsersLayout = reconcileAllUsersLayout;

export = router;
