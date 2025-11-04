const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { STORE_CATALOG } = require('../config/paths');

// Configuration
const GITHUB_REPO = process.env.GITHUB_REPO || 'Loghin01/ryvie-apps';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Local files
const APPS_FILE = path.join(STORE_CATALOG, 'apps.json');
const METADATA_FILE = path.join(STORE_CATALOG, 'metadata.json');

// Metadata in memory
let metadata = {
  releaseTag: null,
  lastCheck: null
};

/**
 * Récupère la dernière release depuis GitHub
 */
async function getLatestRelease() {
  try {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Ryvie-App-Store'
    };
    
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }
    
    const response = await axios.get(GITHUB_API_URL, {
      timeout: 10000,
      headers
    });
    
    return {
      tag: response.data.tag_name,
      name: response.data.name,
      publishedAt: response.data.published_at,
      assets: response.data.assets
    };
  } catch (error) {
    console.error('[appStore] Erreur lors de la récupération de la dernière release:', error.message);
    throw new Error('Échec de la récupération de la release depuis GitHub');
  }
}

/**
 * S'assure que le répertoire de données existe
 */
async function ensureDataDirectory() {
  try {
    await fs.mkdir(STORE_CATALOG, { recursive: true });
  } catch (error) {
    console.error('[appStore] Erreur lors de la création du répertoire de données:', error.message);
  }
}

/**
 * Charge les apps depuis le fichier local
 */
async function loadAppsFromFile() {
  try {
    const data = await fs.readFile(APPS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[appStore] Aucun fichier apps.json local trouvé');
      return null;
    }
    console.error('[appStore] Erreur lors de la lecture de apps.json:', error.message);
    return null;
  }
}

/**
 * Sauvegarde les apps dans le fichier local
 */
async function saveAppsToFile(data) {
  try {
    await ensureDataDirectory();
    await fs.writeFile(APPS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('[appStore] apps.json sauvegardé sur disque');
  } catch (error) {
    console.error('[appStore] Erreur lors de la sauvegarde de apps.json:', error.message);
    throw error;
  }
}

/**
 * Charge les métadonnées depuis le fichier
 */
async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { releaseTag: null, lastCheck: null };
    }
    console.error('[appStore] Erreur lors de la lecture des métadonnées:', error.message);
    return { releaseTag: null, lastCheck: null };
  }
}

/**
 * Sauvegarde les métadonnées dans le fichier
 */
async function saveMetadata() {
  try {
    await ensureDataDirectory();
    await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  } catch (error) {
    console.error('[appStore] Erreur lors de la sauvegarde des métadonnées:', error.message);
  }
}

/**
 * Récupère apps.json depuis les assets d'une release
 */
async function fetchAppsFromRelease(release) {
  try {
    const appsAsset = release.assets.find(asset => asset.name === 'apps.json');
    
    if (!appsAsset) {
      throw new Error('apps.json non trouvé dans les assets de la release');
    }
    
    const headers = {
      'Accept': 'application/octet-stream',
      'User-Agent': 'Ryvie-App-Store'
    };
    
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }
    
    const response = await axios.get(appsAsset.url, {
      timeout: 10000,
      headers
    });
    
    console.log(`[appStore] apps.json récupéré depuis la release: ${release.tag}`);
    return response.data;
  } catch (error) {
    console.error('[appStore] Erreur lors de la récupération de apps.json depuis la release:', error.message);
    throw new Error('Échec de la récupération de apps.json depuis la release');
  }
}

/**
 * Récupère les apps depuis le fichier local
 */
async function getApps() {
  return await loadAppsFromFile();
}

/**
 * Récupère une app par son ID
 */
async function getAppById(appId) {
  const apps = await loadAppsFromFile();
  
  if (!Array.isArray(apps)) {
    return null;
  }
  
  return apps.find(app => app.id === appId) || null;
}

/**
 * Efface le cache local
 */
async function clearCache() {
  try {
    await fs.unlink(APPS_FILE).catch(() => {});
    await fs.unlink(METADATA_FILE).catch(() => {});
    
    metadata.releaseTag = null;
    metadata.lastCheck = null;
    
    console.log('[appStore] Cache local effacé');
    return true;
  } catch (error) {
    console.error('[appStore] Erreur lors de l\'effacement du cache:', error.message);
    throw error;
  }
}

/**
 * Récupère les informations de santé du store
 */
async function getStoreHealth() {
  const now = Date.now();
  const hasLocalFile = await loadAppsFromFile() !== null;
  
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    githubRepo: GITHUB_REPO,
    storage: {
      type: 'file',
      hasData: hasLocalFile,
      dataFile: APPS_FILE,
      releaseTag: metadata.releaseTag,
      lastCheck: metadata.lastCheck ? new Date(metadata.lastCheck).toISOString() : null,
      timeSinceLastCheck: metadata.lastCheck ? Math.floor((now - metadata.lastCheck) / 1000 / 60) : null
    }
  };
}

/**
 * Initialise le service au démarrage
 */
async function initialize() {
  console.log('[appStore] Initialisation du service...');
  console.log(`[appStore] GitHub Repo: ${GITHUB_REPO}`);
  console.log(`[appStore] Répertoire de données: ${STORE_CATALOG }`);
  
  // Charger les métadonnées
  const loadedMetadata = await loadMetadata();
  Object.assign(metadata, loadedMetadata);
  if (metadata.releaseTag) {
    console.log(`[appStore] Release actuelle: ${metadata.releaseTag}`);
  }
  
  // Vérifier et mettre à jour le catalogue au démarrage
  try {
    const { updateStoreCatalog } = require('./updateService');
    const result = await updateStoreCatalog();
    
    if (result.success && result.updated) {
      console.log(`[appStore] ✅ Catalogue initialisé avec ${result.appsCount} apps`);
    } else if (result.success && !result.updated) {
      const apps = await loadAppsFromFile();
      const count = Array.isArray(apps) ? apps.length : 0;
      console.log(`[appStore] ✅ Catalogue déjà à jour avec ${count} apps`);
    } else {
      console.error('[appStore] ⚠️  Erreur lors de l\'initialisation:', result.message);
    }
  } catch (error) {
    console.error('[appStore] ⚠️  Échec de l\'initialisation:', error.message);
    // Continuer même en cas d'erreur (utiliser le cache local si disponible)
  }
}

// Exports pour être utilisés par updateCheckService et updateService
module.exports = {
  initialize,
  getApps,
  getAppById,
  clearCache,
  getStoreHealth,
  // Exports pour les services de check/update
  getLatestRelease,
  fetchAppsFromRelease,
  loadAppsFromFile,
  saveAppsToFile,
  loadMetadata,
  saveMetadata,
  metadata,
  APPS_FILE,
  METADATA_FILE,
  STORE_CATALOG 
};