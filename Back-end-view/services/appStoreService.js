const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { EventEmitter } = require('events');
const { STORE_CATALOG, RYVIE_DIR, MANIFESTS_DIR, APPS_DIR } = require('../config/paths');

// Configuration
const GITHUB_REPO = process.env.GITHUB_REPO || 'ryvieos/Ryvie-Apps';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Local files
const APPS_FILE = path.join(STORE_CATALOG, 'apps.json');
const METADATA_FILE = path.join(STORE_CATALOG, 'metadata.json');
// Snapshot des versions installées généré côté manifests (utilisé pour détecter les mises à jour)
const APPS_VERSIONS_FILE = path.join(RYVIE_DIR, 'Ryvie-Front/src/config/apps-versions.json');

// Metadata in memory
let metadata = {
  releaseTag: null,
  lastCheck: null
};

// Système d'événements pour les mises à jour de progression
const progressEmitter = new EventEmitter();

// Fonction pour envoyer des mises à jour de progression
function sendProgressUpdate(appId, progress, message, stage = 'download') {
  const update = {
    appId,
    progress: Math.round(progress),
    message,
    stage,
    timestamp: new Date().toISOString()
  };
  
  console.log(`[Progress] ${appId}: ${progress}% - ${message}`);
  progressEmitter.emit('progress', update);
}

async function loadInstalledVersionsFromManifests() {
  try {
    const entries = await fs.readdir(MANIFESTS_DIR, { withFileTypes: true });
    const installed = {};

    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory()) return;
      const manifestPath = path.join(MANIFESTS_DIR, entry.name, 'manifest.json');
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);
        if (manifest?.id) {
          const normalizedId = String(manifest.id).trim();
          if (!normalizedId) return;
          
          // Vérifier que le dossier de l'app existe dans /data/apps/
          const appDir = path.join(APPS_DIR, entry.name);
          try {
            await fs.access(appDir);
          } catch {
            // Le dossier n'existe pas, l'app a été désinstallée manuellement
            console.log(`[appStore] App ${normalizedId} détectée comme désinstallée (dossier absent)`);
            return;
          }
          
          const version = typeof manifest.version === 'string' && manifest.version.trim() !== ''
            ? manifest.version.trim()
            : null;
          if (version) {
            installed[normalizedId] = version;
          }
        }
      } catch (manifestError) {
        if (manifestError.code !== 'ENOENT') {
          console.warn(`[appStore] Impossible de lire ${manifestPath}:`, manifestError.message);
        }
      }
    }));

    return installed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[appStore] Impossible de lister les manifests installés:', error.message);
    }
    return {};
  }
}

// Lit le snapshot local des versions installées (retourne {} si absent)
async function loadInstalledVersions() {
  let installed = {};

  try {
    const raw = await fs.readFile(APPS_VERSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      installed = parsed;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[appStore] Impossible de lire apps-versions.json:', error.message);
    }
  }

  if (!installed || Object.keys(installed).length === 0) {
    const fallback = await loadInstalledVersionsFromManifests();
    if (Object.keys(fallback).length > 0) {
      installed = fallback;
    }
  }

  return installed || {};
}

// Uniformise les chaînes de version pour faciliter la comparaison
function normalizeVersion(version) {
  if (!version || typeof version !== 'string') return null;
  return version.trim().replace(/^v/i, '');
}

function extractNumericParts(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  return normalized
    .split('.')
    .map(part => {
      const match = part.match(/\d+/);
      return match ? parseInt(match[0], 10) : 0;
    });
}

// Compare deux versions SemVer (avec préfixe optionnel v) et indique l'état
function compareAppVersions(installed, latest) {
  const normalizedInstalled = normalizeVersion(installed);
  const normalizedLatest = normalizeVersion(latest);
  if (!normalizedInstalled || !normalizedLatest) {
    return null;
  }

  if (normalizedInstalled === normalizedLatest) {
    return 'up-to-date';
  }

  const installedParts = extractNumericParts(installed) || [];
  const latestParts = extractNumericParts(latest) || [];
  const maxLen = Math.max(installedParts.length, latestParts.length);

  for (let i = 0; i < maxLen; i++) {
    const current = installedParts[i] || 0;
    const next = latestParts[i] || 0;

    if (next > current) return 'update-available';
    if (next < current) return 'ahead';
  }

  return 'up-to-date';
}

// Ajoute installedVersion/updateAvailable aux apps et liste celles à mettre à jour
async function enrichAppsWithInstalledVersions(apps) {
  if (!Array.isArray(apps)) {
    return { apps, updates: [] };
  }

  const installedVersions = await loadInstalledVersions();
  const updates = [];

  const enriched = apps.map(app => {
    const installedVersion = installedVersions?.[app.id];
    if (!installedVersion) {
      // App non installée : supprimer les champs installedVersion et updateAvailable s'ils existent
      const { installedVersion: _, updateAvailable: __, ...cleanApp } = app;
      return cleanApp;
    }

    const status = compareAppVersions(installedVersion, app.version);
    const enhancedApp = {
      ...app,
      installedVersion,
      updateAvailable: status === 'update-available'
    };

    if (status === 'update-available') {
      updates.push({
        id: app.id,
        installedVersion,
        latestVersion: app.version
      });
    }

    return enhancedApp;
  });

  return { apps: enriched, updates };
}

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
      timeout: 300000,
      headers
    });
    console.log('GITHUB_API_URL:', GITHUB_API_URL);
    
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
      timeout: 300000,
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
 * Télécharge une app depuis le repo GitHub via l'API
 */
async function downloadAppFromRepoArchive(release, appId) {
  console.log(`[appStore] 📥 Téléchargement de ${appId} via GitHub API...`);
  
  const appDir = path.join(APPS_DIR, appId);
  await fs.mkdir(appDir, { recursive: true });
  
  // Configuration du repo
  const repoOwner = 'ryvieos';
  const repoName = 'Ryvie-Apps';
  const branch = 'main';
  
  // URL de base de l'API GitHub pour le dossier de l'app
  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${appId}`;
  
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Ryvie-App-Store'
  };
  
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  }
  
  try {
    // 1. Récupérer la liste des fichiers du dossier de l'app
    console.log(`[appStore] 🔍 Récupération de la liste des fichiers pour ${appId}...`);
    sendProgressUpdate(appId, 3, 'Récupération de la liste des fichiers...', 'preparation');
    
    const response = await axios.get(apiUrl, {
      params: { ref: branch },
      headers,
      timeout: 300000
    });
    
    const allItems = response.data;
    
    if (!Array.isArray(allItems) || allItems.length === 0) {
      throw new Error(`Le dossier ${appId} est vide ou n'existe pas dans le repo`);
    }
    
    // Séparer les fichiers des dossiers
    const files = allItems.filter(item => item.type === 'file');
    const directories = allItems.filter(item => item.type === 'dir');
    
    console.log(`[appStore] 📋 ${files.length} fichier(s) et ${directories.length} dossier(s) trouvé(s)`);
    
    // 2. Calculer la taille totale estimée (en utilisant les tailles GitHub)
    const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    console.log(`[appStore] 📏 Taille totale estimée: ${(totalSize / 1024).toFixed(2)} Ko`);
    
    sendProgressUpdate(appId, 5, `Préparation du téléchargement (${files.length} fichiers)...`, 'preparation');
    
    // 3. S'assurer que le dossier de destination existe
    await fs.mkdir(appDir, { recursive: true });
    
    // 4. Télécharger chaque fichier avec mise à jour de progression
    let downloadedSize = 0;
    let downloadedCount = 0;
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = file.name;
      const filePath = path.join(appDir, fileName);
      
      const progressPercent = 5 + (i / files.length) * 55; // 5% -> 60%
      sendProgressUpdate(appId, progressPercent, `Téléchargement: ${fileName}...`, 'download');
      
      try {
        // Télécharger le contenu du fichier
        const fileResponse = await axios.get(file.download_url, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Ryvie-App-Store' },
          timeout: 300000
        });
        
        // Sauvegarder le fichier
        await fs.writeFile(filePath, fileResponse.data);
        
        // Mettre à jour la progression
        downloadedSize += fileResponse.data.length;
        downloadedCount++;
        
        const actualProgress = 5 + (downloadedSize / totalSize) * 55; // 5% -> 60%
        sendProgressUpdate(appId, Math.min(60, actualProgress), 
          `${fileName} téléchargé (${(fileResponse.data.length / 1024).toFixed(2)} Ko)`, 'download');
        
        console.log(`[appStore] ✅ ${fileName} téléchargé (${(fileResponse.data.length / 1024).toFixed(2)} Ko)`);
        
      } catch (fileError) {
        console.error(`[appStore] ❌ Erreur lors du téléchargement de ${fileName}:`, fileError.message);
        throw new Error(`Échec du téléchargement de ${fileName}`);
      }
    }
    
    // 5. Télécharger le fichier .env s'il existe (optionnel mais critique)
    sendProgressUpdate(appId, 60, 'Vérification du fichier .env...', 'download');
    console.log(`[appStore] 🔍 Recherche du fichier .env pour ${appId}...`);
    
    try {
      const envFileUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/${appId}/.env`;
      const envResponse = await axios.get(envFileUrl, {
        headers: { 'User-Agent': 'Ryvie-App-Store' },
        timeout: 10000,
        validateStatus: (status) => status === 200 || status === 404
      });
      
      if (envResponse.status === 200 && envResponse.data) {
        const envFilePath = path.join(appDir, '.env');
        await fs.writeFile(envFilePath, envResponse.data);
        console.log(`[appStore] ✅ Fichier .env téléchargé et sauvegardé`);
        sendProgressUpdate(appId, 61, 'Fichier .env téléchargé', 'download');
      } else {
        console.log(`[appStore] ℹ️ Aucun fichier .env trouvé (optionnel)`);
      }
    } catch (envError) {
      // Le fichier .env est optionnel, on ne bloque pas l'installation
      if (envError.response?.status === 404) {
        console.log(`[appStore] ℹ️ Aucun fichier .env disponible pour ${appId} (optionnel)`);
      } else {
        console.warn(`[appStore] ⚠️ Erreur lors du téléchargement du .env:`, envError.message);
      }
    }
    
    // 6. Télécharger les sous-dossiers récursivement
    for (const dir of directories) {
      sendProgressUpdate(appId, 62, `Téléchargement du dossier: ${dir.name}...`, 'download');
      await downloadDirectoryRecursive(dir.url, path.join(appDir, dir.name), branch, headers);
    }
    
    // 7. Vérifier que les fichiers requis sont présents
    sendProgressUpdate(appId, 63, 'Vérification des fichiers requis...', 'verification');
    const requiredFiles = ['docker-compose.yml', 'ryvie-app.yml', 'icon.png'];
    const missingFiles = [];
    
    for (const requiredFile of requiredFiles) {
      const filePath = path.join(appDir, requiredFile);
      try {
        await fs.access(filePath);
        console.log(`[appStore] ✅ Fichier requis trouvé: ${requiredFile}`);
      } catch {
        missingFiles.push(requiredFile);
      }
    }
    
    if (missingFiles.length > 0) {
      throw new Error(`Fichiers requis manquants: ${missingFiles.join(', ')}`);
    }
    
    sendProgressUpdate(appId, 65, 'Fichiers vérifiés avec succès', 'verification');
    
    // Définir les permissions correctes sur le dossier (775 = drwxrwxr-x)
    try {
      execSync(`chmod -R 775 "${appDir}"`, { stdio: 'inherit' });
      console.log(`[appStore] ✅ Permissions configurées (775) pour ${appDir}`);
    } catch (chmodError) {
      console.warn(`[appStore] ⚠️ Impossible de définir les permissions:`, chmodError.message);
      // Non bloquant
    }
    
    console.log(`[appStore] 🎉 ${appId} téléchargé avec succès (${downloadedCount} fichier(s))`);
    return appDir;
    
  } catch (error) {
    // Gestion des erreurs spécifiques à GitHub
    if (error.response?.status === 404) {
      throw new Error(`Application "${appId}" non trouvée dans le repo ${repoOwner}/${repoName}`);
    } else if (error.response?.status === 403) {
      const rateLimitRemaining = error.response.headers['x-ratelimit-remaining'];
      if (rateLimitRemaining === '0') {
        throw new Error(`Limite de rate GitHub atteinte. Ajoutez un GITHUB_TOKEN pour augmenter la limite.`);
      }
      throw new Error(`Accès refusé par GitHub: ${error.response.data?.message || 'Erreur 403'}`);
    } else if (error.response?.status === 401) {
      throw new Error(`Token GitHub invalide ou expiré`);
    }
    
    console.error(`[appStore] ❌ Erreur lors du téléchargement de ${appId}:`, error.message);
    
    // Nettoyer le dossier en cas d'erreur
    try {
      await fs.rm(appDir, { recursive: true, force: true });
      console.log(`[appStore] 🧹 Dossier ${appDir} nettoyé après erreur`);
    } catch (cleanupError) {
      console.error(`[appStore] ⚠️  Erreur lors du nettoyage:`, cleanupError.message);
    }
    
    throw new Error(`Échec du téléchargement de ${appId}: ${error.message}`);
  }
}

/**
 * Télécharge récursivement un sous-dossier depuis GitHub
 * (Utilisé si votre app contient des sous-dossiers)
 */
async function downloadDirectoryRecursive(apiUrl, destinationPath, branch, headers) {
  try {
    const response = await axios.get(apiUrl, {
      params: { ref: branch },
      headers,
      timeout: 30000
    });
    
    const items = response.data;
    
    // Créer le dossier de destination
    await fs.mkdir(destinationPath, { recursive: true });
    
    // Télécharger chaque élément
    for (const item of items) {
      const itemPath = path.join(destinationPath, item.name);
      
      if (item.type === 'file') {
        console.log(`[appStore] ⬇️  Téléchargement: ${item.name}...`);
        const fileResponse = await axios.get(item.download_url, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Ryvie-App-Store' },
          timeout: 300000
        });
        await fs.writeFile(itemPath, fileResponse.data);
        console.log(`[appStore] ✅ ${item.name} téléchargé`);
        
      } else if (item.type === 'dir') {
        // Récursion pour les sous-dossiers
        await downloadDirectoryRecursive(item.url, itemPath, branch, headers);
      }
    }
    
    // Vérifier et télécharger le fichier .env s'il existe dans ce dossier (optionnel)
    // L'API GitHub Contents peut ne pas retourner les fichiers cachés dans certains cas
    const folderPathInRepo = destinationPath.split('/data/apps/')[1]; // Extraire le chemin relatif
    if (folderPathInRepo) {
      try {
        const envFileUrl = `https://raw.githubusercontent.com/ryvieos/Ryvie-Apps/main/${folderPathInRepo}/.env`;
        const envResponse = await axios.get(envFileUrl, {
          headers: { 'User-Agent': 'Ryvie-App-Store' },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 404
        });
        
        if (envResponse.status === 200 && envResponse.data) {
          const envFilePath = path.join(destinationPath, '.env');
          await fs.writeFile(envFilePath, envResponse.data);
          console.log(`[appStore] ✅ Fichier .env téléchargé dans ${folderPathInRepo}`);
        }
      } catch (envError) {
        // Le fichier .env est optionnel, on ne bloque pas
        if (envError.response?.status !== 404) {
          console.warn(`[appStore] ⚠️ Erreur lors du téléchargement du .env dans ${folderPathInRepo}:`, envError.message);
        }
      }
    }
    
    // Définir les permissions sur le dossier téléchargé
    try {
      execSync(`chmod -R 775 "${destinationPath}"`, { stdio: 'pipe' });
    } catch (chmodError) {
      console.warn(`[appStore] ⚠️ Impossible de définir les permissions sur ${destinationPath}`);
    }
    
  } catch (error) {
    console.error(`[appStore] ❌ Erreur lors du téléchargement récursif:`, error.message);
    throw error;
  }
}

/**
 * Enrichit les apps avec l'icône extraite de la galerie
 */
function enrichAppsWithIcons(apps) {
  if (!Array.isArray(apps)) return apps;
  
  return apps.map(app => {
    if (!app.gallery || !Array.isArray(app.gallery)) {
      return { ...app, icon: null, previews: [] };
    }
    
    // L'icône est l'image dont le nom contient 'icon'
    const icon = app.gallery.find(url => url.toLowerCase().includes('icon')) || null;
    // Les previews sont toutes les autres images
    const previews = app.gallery.filter(url => !url.toLowerCase().includes('icon'));
    
    return {
      ...app,
      icon,
      previews
    };
  });
}

/**
 * Récupère les apps depuis le fichier local
 */
async function getApps() {
  const apps = await loadAppsFromFile();
  if (!Array.isArray(apps)) {
    return [];
  }

  const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(apps);
  return enrichAppsWithIcons(enrichedApps);
}

/**
 * Récupère une app par son ID
 */
async function getAppById(appId) {
  const apps = await loadAppsFromFile();
  
  if (!Array.isArray(apps)) {
    return null;
  }
  
  const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(apps);
  const target = enrichedApps.find(app => app.id === appId);
  if (!target) {
    return null;
  }
  
  const enriched = enrichAppsWithIcons([target]);
  return enriched[0] || null;
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
 * Met à jour une application depuis l'App Store (téléchargement + docker compose)
 */
async function updateAppFromStore(appId) {
  let snapshotPath = null;
  let currentStep = 'initialisation';
  let appDir = null; // Pour nettoyer en cas d'échec
  
  try {
    console.log(`[Update] Début de la mise à jour/installation de ${appId} depuis l'App Store...`);
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    
    // Initialisation - envoyer la première mise à jour
    sendProgressUpdate(appId, 0, 'Préparation de l\'installation...', 'init');
    await new Promise(resolve => setTimeout(resolve, 500)); // Petit délai pour que le client reçoive
    
    sendProgressUpdate(appId, 2, 'Vérification des prérequis...', 'init');
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 1. Créer un snapshot avant la mise à jour (obligatoire pour la sécurité)
    currentStep = 'snapshot-creation';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    console.log('[Update] 📸 Création du snapshot de sécurité...');
    sendProgressUpdate(appId, 3, 'Création du snapshot de sécurité...', 'snapshot');
    
    try {
      const snapshotOutput = execSync('sudo /opt/Ryvie/scripts/snapshot.sh', { encoding: 'utf8' });
      console.log(`[Update] Snapshot output: ${snapshotOutput.substring(0, 100)}...`);
      
      // Extraire le chemin du snapshot
      const match = snapshotOutput.match(/SNAPSHOT_PATH=(.+)/);
      console.log(`[Update] Snapshot path match:`, match);
      
      if (match) {
        snapshotPath = match[1].trim();
        console.log(`[Update] Snapshot créé: ${snapshotPath}`);
        sendProgressUpdate(appId, 4, 'Snapshot de sécurité créé', 'snapshot');
      } else {
        console.error('[Update] ❌ Impossible d\'extraire le chemin du snapshot depuis la sortie');
        throw new Error('Impossible d\'extraire le chemin du snapshot depuis la sortie');
      }
    } catch (snapError) {
      console.error('[Update] ❌ Impossible de créer le snapshot:', snapError.message);
      throw new Error(`Création du snapshot échouée: ${snapError.message}. Mise à jour annulée pour des raisons de sécurité.`);
    }

    // 2. Récupérer la dernière release depuis GitHub
    currentStep = 'github-release-fetch';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    console.log('[Update] 🌐 Récupération de la dernière release depuis GitHub...');
    sendProgressUpdate(appId, 5, 'Connexion au dépôt GitHub...', 'download');
    
    const latestRelease = await getLatestRelease();
    sendProgressUpdate(appId, 6, 'Informations de version récupérées', 'download');
    console.log(`[Update] ✅ Release récupérée: ${latestRelease.tag} (${latestRelease.name})`);
    console.log(`[Update] 📦 Nombre d'assets: ${latestRelease.assets?.length || 0}`);
    if (latestRelease.assets?.length) {
      console.log('[Update] 📄 Liste des assets:', latestRelease.assets.map(asset => `${asset.name} (${asset.browser_download_url || 'pas d\'URL'})`));
    }
    
    // 3. Télécharger et extraire l'app depuis la release
    currentStep = 'app-archive-download';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    console.log(`[Update] 📥 Téléchargement de ${appId}...`);
    appDir = await downloadAppFromRepoArchive(latestRelease, appId);
    
    sendProgressUpdate(appId, 68, 'Application téléchargée, configuration en cours...', 'extraction');
    
    console.log(`[Update] ✅ ${appId} téléchargé dans ${appDir}`);
    
    // Définir les permissions correctes sur le dossier (775 = drwxrwxr-x)
    console.log('[Update] 🔧 Configuration des permissions...');
    try {
      execSync(`chmod -R 775 "${appDir}"`, { stdio: 'inherit' });
      console.log('[Update] ✅ Permissions configurées (775)');
    } catch (chmodError) {
      console.warn('[Update] ⚠️ Impossible de définir les permissions:', chmodError.message);
      // Non bloquant, on continue
    }
    
    // 4. Trouver et exécuter docker-compose
    console.log('[Update] 🔎 Étape courante: docker-compose-up');
    
    // Détecter le fichier docker-compose
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'];
    let composeFile = null;

    for (const file of composeFiles) {
      try {
        await fs.access(path.join(appDir, file));
        composeFile = file;
        break;
      } catch {}
    }

    if (!composeFile) {
      throw new Error(`Aucun fichier docker-compose trouvé`);
    }
    const composeFilePath = path.join(appDir, composeFile);
    let content = await fs.readFile(composeFilePath, 'utf8');

    // Supprimer app_proxy AVANT le lancement (si présent - spécifique à l'infrastructure Ryvie)
    console.log('[Update] 🔧 Vérification du docker-compose.yml...');
    sendProgressUpdate(appId, 70, 'Configuration des services...', 'configuration');
    
    if (content.includes('app_proxy:')) {
      console.log('[Update] 🔧 Suppression du service app_proxy...');
      // Supprimer le service app_proxy uniquement dans la section services
      content = content.replace(/(services:\s*\n(?:.*\n)*?)(\s{2}app_proxy:[\s\S]*?)(?=\n\s{2}\w+:|\nnetworks:|\nvolumes:|\n$)/g, '$1');
      await fs.writeFile(composeFilePath, content);
      console.log('[Update] ✅ Service app_proxy supprimé');
    } else {
      console.log('[Update] ✅ Fichier docker-compose.yml prêt (aucune modification nécessaire)');
    }
    
    // Vérifier la présence du fichier .env
    const envPath = path.join(appDir, '.env');
    try {
      await fs.access(envPath);
      console.log('[Update] ✅ Fichier .env présent');
    } catch {
      console.log('[Update] ⚠️ Aucun fichier .env (peut être normal pour certaines apps)');
    }

    sendProgressUpdate(appId, 75, 'Lancement des containers...', 'installation');
    
    // Nettoyer les containers arrêtés de cette app avant de lancer (évite les conflits de namespaces)
    console.log('[Update] 🧹 Nettoyage des anciens containers...');
    try {
      execSync(`docker compose -f ${composeFile} down 2>/dev/null || true`, { 
        cwd: appDir, 
        stdio: 'pipe'
      });
    } catch (cleanupError) {
      // Non bloquant - l'app n'existe peut-être pas encore
      console.log('[Update] ℹ️ Aucun container existant à nettoyer');
    }
    
    // Lancer docker compose
    console.log('[Update] 🚀 Lancement des containers...');
    console.log(`[Update] 📂 Dossier de travail: ${appDir}`);
    console.log(`[Update] 📄 Fichier compose: ${composeFile}`);
    
    try {
      execSync(`docker compose -f ${composeFile} up -d`, { 
        cwd: appDir, 
        stdio: 'inherit'
      });
      console.log('[Update] ✅ Containers lancés avec succès');
    } catch (composeError) {
      console.error('[Update] ❌ Erreur lors du lancement docker compose:', composeError.message);
      console.error('[Update] 📋 Vérification du fichier docker-compose.yml...');
      
      // Afficher le contenu du fichier modifié pour debug
      const modifiedContent = await fs.readFile(composeFilePath, 'utf8');
      console.error('[Update] 📄 Contenu du docker-compose.yml modifié:');
      console.error(modifiedContent.substring(0, 1000)); // Premiers 1000 caractères
      
      throw new Error(`Échec du lancement docker compose: ${composeError.message}`);
    }
    
    // Attendre que les containers démarrent avec progression
    currentStep = 'container-start-delay';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    console.log(`[Update] ⏳ Attente du démarrage des containers (20 secondes)...`);
    
    // Progression pendant l'attente : 75% -> 90% sur 20 secondes
    const waitSteps = 10;
    const waitInterval = 20000 / waitSteps; // 2 secondes par step
    for (let i = 0; i < waitSteps; i++) {
      await new Promise(resolve => setTimeout(resolve, waitInterval));
      const progress = 75 + ((i + 1) / waitSteps) * 15; // 75% -> 90%
      sendProgressUpdate(appId, progress, `Démarrage des containers (${Math.round((i + 1) / waitSteps * 100)}%)...`, 'installation');
    }
    
    sendProgressUpdate(appId, 92, 'Vérification du statut des containers...', 'verification');
    
    // Vérifier le statut du container
    currentStep = 'container-status-check';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    console.log(`[Update] Vérification du statut des containers pour ${appId}...`);
    
    try {
      // Récupérer tous les containers liés à l'app avec leur nom et statut
      const containersOutput = execSync(`docker ps -a --filter "name=${appId}" --format "{{.Names}}:{{.Status}}"`, { 
        encoding: 'utf8' 
      }).trim();
      
      console.log(`[Update] Containers trouvés:\n${containersOutput}`);
      
      // Parser les containers
      const containers = containersOutput.split('\n').filter(line => line.trim());
      
      // Filtrer les containers auxiliaires (caddy, proxy, etc.) qui peuvent être arrêtés
      const mainContainers = containers.filter(line => {
        const name = line.split(':')[0].toLowerCase();
        return !name.includes('caddy') && !name.includes('proxy') && !name.includes('nginx');
      });
      
      console.log(`[Update] Containers principaux à vérifier: ${mainContainers.length}`);
      
      // Vérifier si au moins un container principal est exited (erreur critique)
      let hasExitedMain = false;
      let hasRunningMain = false;
      
      for (const containerLine of mainContainers) {
        const [name, status] = containerLine.split(':');
        console.log(`[Update] - ${name}: ${status}`);
        
        if (status.toLowerCase().includes('exited')) {
          hasExitedMain = true;
          console.warn(`[Update] ⚠️ Container principal ${name} est arrêté`);
        } else if (status.toLowerCase().includes('up')) {
          hasRunningMain = true;
        }
      }
      
      // Erreur seulement si tous les containers principaux sont arrêtés
      if (hasExitedMain && !hasRunningMain && mainContainers.length > 0) {
        throw new Error(`Les containers principaux de ${appId} se sont arrêtés pendant l'installation`);
      }
      
      if (!hasRunningMain && mainContainers.length > 0) {
        throw new Error(`Aucun container principal de ${appId} n'est démarré`);
      }
      
      // Vérifier le health status si disponible
      try {
        const healthOutput = execSync(
          `docker inspect --format='{{.State.Health.Status}}' $(docker ps -aq --filter "name=${appId}")`, 
          { encoding: 'utf8' }
        ).trim();
        
        console.log(`[Update] Container ${appId} - Health: ${healthOutput}`);
        
        if (healthOutput === 'unhealthy') {
          throw new Error(`Le container ${appId} est en état unhealthy`);
        }
        
        if (healthOutput === 'healthy') {
          console.log(`[Update] ✅ Container ${appId} est healthy`);
        } else if (healthOutput === 'starting') {
          console.log(`[Update] ⏳ Container ${appId} est en cours de démarrage`);
        }
      } catch (healthError) {
        // Pas de healthcheck configuré, on vérifie juste qu'au moins un container principal est Up
        if (!hasRunningMain) {
          console.warn(`[Update] ⚠️ Aucun healthcheck disponible et aucun container principal en cours d'exécution`);
        } else {
          console.log(`[Update] ℹ️ Containers sans healthcheck, au moins un container principal est Up`);
        }
      }
      
    } catch (checkError) {
      console.error(`[Update] ❌ Détails erreur de vérification container: ${checkError.message}`);
      if (checkError.stdout) {
        console.error('[Update] stdout:', checkError.stdout.toString());
      }
      if (checkError.stderr) {
        console.error('[Update] stderr:', checkError.stderr.toString());
      }
      throw new Error(`Vérification du container échouée: ${checkError.message}`);
    }
    
    sendProgressUpdate(appId, 95, 'Finalisation de l\'installation...', 'finalization');
    
    // 5. Régénérer les manifests (si nécessaire)
    currentStep = 'manifest-regeneration';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    try {
      console.log('[Update] Régénération des manifests...');
      const manifestScript = path.join(RYVIE_DIR, 'generate-manifests.js');
      execSync(`node ${manifestScript}`, { stdio: 'inherit' });
      console.log('[Update] ✅ Manifests régénérés');
    } catch (manifestError) {
      console.warn('[Update] ⚠️ Impossible de régénérer les manifests:', manifestError.message);
    }
    
    // 5b. Actualiser le catalogue pour mettre à jour les statuts
    currentStep = 'catalog-refresh';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    try {
      console.log('[Update] 🔄 Actualisation du catalogue...');
      const localApps = await loadAppsFromFile();
      if (Array.isArray(localApps)) {
        const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(localApps);
        await saveAppsToFile(enrichedApps);
        console.log('[Update] ✅ Catalogue actualisé');
      }
    } catch (catalogError) {
      console.warn('[Update] ⚠️ Impossible d\'actualiser le catalogue:', catalogError.message);
    }
    
    console.log(`[Update] ✅ ${appId} installé/mis à jour avec succès`);
    
    sendProgressUpdate(appId, 100, 'Installation terminée avec succès !', 'completed');
    
    // 6. Supprimer le snapshot si tout s'est bien passé
    if (snapshotPath) {
      currentStep = 'snapshot-cleanup';
      console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
      console.log('[Update] 🧹 Suppression du snapshot de sécurité...');
      try {
        execSync(`sudo btrfs subvolume delete "${snapshotPath}"/* 2>/dev/null || true`, { stdio: 'inherit' });
        execSync(`sudo rmdir "${snapshotPath}" 2>/dev/null || true`, { stdio: 'inherit' });
        console.log('[Update] ✅ Snapshot supprimé');
      } catch (delError) {
        console.warn('[Update] ⚠️ Impossible de supprimer le snapshot:', delError.message);
      }
    }
    
    return {
      success: true,
      message: `${appId} installé/mis à jour avec succès depuis l'App Store`,
      appDir
    };
  } catch (error) {
    console.error(`[Update] ❌ Erreur à l'étape ${currentStep}:`, error.message);
    if (error.stack) {
      console.error('[Update] Stack trace:', error.stack);
    }
    console.error(`[Update] ❌ Erreur lors de l'installation/mise à jour de ${appId}:`, error.message);
    
    // Nettoyer le dossier de l'app en cas d'échec
    if (appDir) {
      console.log(`[Update] 🧹 Nettoyage du dossier ${appDir}...`);
      try {
        // Utiliser sudo rm car les fichiers Docker peuvent appartenir à root
        execSync(`sudo rm -rf "${appDir}"`, { stdio: 'inherit' });
        console.log(`[Update] ✅ Dossier ${appDir} supprimé`);
      } catch (cleanupError) {
        console.warn(`[Update] ⚠️ Impossible de supprimer ${appDir}:`, cleanupError.message);
      }
    }
    
    // Rollback si un snapshot existe
    if (snapshotPath) {
      console.error('[Update] 🔄 Rollback en cours...');
      try {
        const rollbackOutput = execSync(`sudo /opt/Ryvie/scripts/rollback.sh --set "${snapshotPath}"`, { encoding: 'utf8' });
        console.log(rollbackOutput);
        console.log('[Update] ✅ Rollback terminé');
        
        // Supprimer le snapshot après rollback réussi
        try {
          execSync(`sudo btrfs subvolume delete "${snapshotPath}"/* 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`sudo rmdir "${snapshotPath}" 2>/dev/null || true`, { stdio: 'inherit' });
          console.log('[Update] 🧹 Snapshot supprimé après rollback');
        } catch (delError) {
          console.warn('[Update] ⚠️ Impossible de supprimer le snapshot:', delError.message);
        }
        
        return {
          success: false,
          message: `Erreur: ${error.message}. Rollback effectué avec succès.`
        };
      } catch (rollbackError) {
        console.error('[Update] ❌ Erreur lors du rollback:', rollbackError.message);
        return {
          success: false,
          message: `Erreur: ${error.message}. Rollback échoué: ${rollbackError.message}`
        };
      }
    }
    
    return {
      success: false,
      message: `Erreur: ${error.message}`
    };
  }
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
    
    // Forcer la régénération des versions installées pour nettoyer les apps fantômes
    console.log('[appStore] 🔄 Vérification des apps installées...');
    const localApps = await loadAppsFromFile();
    if (Array.isArray(localApps)) {
      const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(localApps);
      await saveAppsToFile(enrichedApps);
      const installedCount = enrichedApps.filter(app => app.installedVersion).length;
      console.log(`[appStore] ✅ ${installedCount} apps installées détectées`);
    }
  } catch (error) {
    console.error('[appStore] ⚠️  Échec de l\'initialisation:', error.message);
    // Continuer même en cas d'erreur (utiliser le cache local si disponible)
  }
}

// Exports pour être utilisés par updateCheckService et updateService
/**
 * Désinstalle proprement une application
 */
async function uninstallApp(appId) {
  try {
    console.log(`[Uninstall] Début de la désinstallation de ${appId}...`);
    
    // 1. Arrêter et supprimer les containers Docker
    const appDir = path.join(APPS_DIR, appId);
    
    try {
      await fs.access(appDir);
      console.log(`[Uninstall] Dossier de l'app trouvé: ${appDir}`);
    } catch {
      console.warn(`[Uninstall] ⚠️ Dossier ${appDir} introuvable, l'app n'est peut-être pas installée`);
      return {
        success: false,
        message: `L'application ${appId} n'est pas installée`
      };
    }
    
    // 2. Récupérer les images utilisées par l'application avant de tout supprimer
    console.log('[Uninstall] 🔍 Récupération des images Docker de l\'application...');
    let appImages = [];
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'];
    let composeFile = null;
    
    for (const file of composeFiles) {
      try {
        await fs.access(path.join(appDir, file));
        composeFile = file;
        break;
      } catch {}
    }
    
    if (composeFile) {
      try {
        // Récupérer les images utilisées par l'app
        const imagesOutput = execSync(`docker compose -f ${composeFile} images -q`, { 
          cwd: appDir, 
          encoding: 'utf8'
        }).trim();
        
        if (imagesOutput) {
          appImages = imagesOutput.split('\n').filter(img => img.trim());
          console.log(`[Uninstall] 📦 ${appImages.length} image(s) trouvée(s):`, appImages);
        }
      } catch (imagesError) {
        console.warn('[Uninstall] ⚠️ Impossible de récupérer les images:', imagesError.message);
      }
      
      // 3. Arrêter et supprimer les containers avec docker compose down
      console.log('[Uninstall] 🛑 Arrêt et suppression des containers...');
      try {
        execSync(`docker compose -f ${composeFile} down -v`, { 
          cwd: appDir, 
          stdio: 'inherit'
        });
        console.log('[Uninstall] ✅ Containers et volumes arrêtés et supprimés');
      } catch (dockerError) {
        console.warn('[Uninstall] ⚠️ Erreur lors de l\'arrêt des containers:', dockerError.message);
        // On continue quand même pour nettoyer les fichiers
      }
      
      // 4. Supprimer les volumes spécifiques à l'application
      console.log('[Uninstall] 🗑️ Suppression des volumes de l\'application...');
      try {
        // Récupérer les volumes créés par cette app (préfixés par le nom du dossier)
        const volumesOutput = execSync(`docker volume ls -q --filter "name=${appId}"`, { 
          encoding: 'utf8' 
        }).trim();
        
        if (volumesOutput) {
          const volumes = volumesOutput.split('\n').filter(vol => vol.trim());
          console.log(`[Uninstall] � ${volumes.length} volume(s) trouvé(s):`, volumes);
          
          for (const volume of volumes) {
            try {
              execSync(`docker volume rm ${volume}`, { stdio: 'inherit' });
              console.log(`[Uninstall] ✅ Volume ${volume} supprimé`);
            } catch (volError) {
              console.warn(`[Uninstall] ⚠️ Impossible de supprimer le volume ${volume}:`, volError.message);
            }
          }
        } else {
          console.log('[Uninstall] ℹ️ Aucun volume spécifique trouvé');
        }
      } catch (volumeError) {
        console.warn('[Uninstall] ⚠️ Erreur lors de la récupération des volumes:', volumeError.message);
      }
      
      // 5. Supprimer les images Docker de l'application
      if (appImages.length > 0) {
        console.log('[Uninstall] 🗑️ Suppression des images Docker...');
        for (const imageId of appImages) {
          try {
            execSync(`docker rmi ${imageId}`, { stdio: 'inherit' });
            console.log(`[Uninstall] ✅ Image ${imageId} supprimée`);
          } catch (rmiError) {
            console.warn(`[Uninstall] ⚠️ Impossible de supprimer l'image ${imageId}:`, rmiError.message);
            // L'image peut être utilisée par un autre container, on continue
          }
        }
      } else {
        console.log('[Uninstall] ℹ️ Aucune image spécifique trouvée');
      }
    } else {
      console.warn('[Uninstall] ⚠️ Aucun fichier docker-compose trouvé');
    }
    
    // 5b. Supprimer le dossier de l'application (avec sudo pour les fichiers Docker)
    console.log(`[Uninstall] 🗑️ Suppression du dossier ${appDir}...`);
    try {
      // Utiliser sudo rm car les fichiers Docker peuvent appartenir à root
      execSync(`sudo rm -rf "${appDir}"`, { stdio: 'inherit' });
      console.log('[Uninstall] ✅ Dossier de l\'application supprimé');
    } catch (rmError) {
      console.error('[Uninstall] ❌ Erreur lors de la suppression du dossier:', rmError.message);
      throw new Error(`Impossible de supprimer le dossier de l'application: ${rmError.message}`);
    }
    
    // 6. Supprimer le manifest
    const manifestDir = path.join(MANIFESTS_DIR, appId);
    console.log(`[Uninstall] 📄 Suppression du manifest ${manifestDir}...`);
    try {
      execSync(`sudo rm -rf "${manifestDir}"`, { stdio: 'inherit' });
      console.log('[Uninstall] ✅ Manifest supprimé');
    } catch (manifestError) {
      console.warn('[Uninstall] ⚠️ Erreur lors de la suppression du manifest:', manifestError.message);
      // Non bloquant
    }
    
    // 7. Régénérer les manifests pour mettre à jour la liste
    console.log('[Uninstall] 🔄 Régénération des manifests...');
    try {
      const manifestScript = path.join(RYVIE_DIR, 'generate-manifests.js');
      execSync(`node ${manifestScript}`, { stdio: 'inherit' });
      console.log('[Uninstall] ✅ Manifests régénérés');
    } catch (manifestError) {
      console.warn('[Uninstall] ⚠️ Impossible de régénérer les manifests:', manifestError.message);
    }
    
    // 8. Supprimer l'entrée dans apps-versions.json
    console.log('[Uninstall] 🔄 Mise à jour de apps-versions.json...');
    try {
      let installedVersions = {};
      try {
        const raw = await fs.readFile(APPS_VERSIONS_FILE, 'utf8');
        installedVersions = JSON.parse(raw);
      } catch (readError) {
        console.log('[Uninstall] apps-versions.json introuvable ou vide');
      }
      
      // Supprimer l'entrée de l'app
      if (installedVersions[appId]) {
        delete installedVersions[appId];
        await fs.writeFile(APPS_VERSIONS_FILE, JSON.stringify(installedVersions, null, 2));
        console.log('[Uninstall] ✅ apps-versions.json mis à jour');
      }
    } catch (versionError) {
      console.warn('[Uninstall] ⚠️ Impossible de mettre à jour apps-versions.json:', versionError.message);
    }
    
    // 9. Actualiser le catalogue pour mettre à jour les statuts
    console.log('[Uninstall] 🔄 Actualisation du catalogue...');
    try {
      const localApps = await loadAppsFromFile();
      if (Array.isArray(localApps)) {
        const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(localApps);
        await saveAppsToFile(enrichedApps);
        console.log('[Uninstall] ✅ Catalogue actualisé');
      }
    } catch (catalogError) {
      console.warn('[Uninstall] ⚠️ Impossible d\'actualiser le catalogue:', catalogError.message);
    }
    
    console.log(`[Uninstall] ✅ ${appId} désinstallé avec succès`);
    
    return {
      success: true,
      message: `${appId} a été désinstallé avec succès`
    };
    
  } catch (error) {
    console.error(`[Uninstall] ❌ Erreur lors de la désinstallation de ${appId}:`, error.message);
    return {
      success: false,
      message: `Erreur lors de la désinstallation: ${error.message}`
    };
  }
}

module.exports = {
  initialize,
  getApps,
  getAppById,
  clearCache,
  getStoreHealth,
  // Exports pour les services de check/update
  getLatestRelease,
  fetchAppsFromRelease,
  downloadAppFromRepoArchive,
  loadAppsFromFile,
  saveAppsToFile,
  loadMetadata,
  saveMetadata,
  metadata,
  APPS_FILE,
  METADATA_FILE,
  STORE_CATALOG,
  enrichAppsWithInstalledVersions,
  updateAppFromStore,
  uninstallApp,
  // Export pour les mises à jour de progression
  progressEmitter
};