const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { EventEmitter } = require('events');
const { STORE_CATALOG, RYVIE_DIR, MANIFESTS_DIR, APPS_DIR } = require('../config/paths');
const { getLocalIP } = require('../utils/network');
// Importer compareVersions depuis updateCheckService pour un tri cohérent
const { compareVersions } = require('./updateCheckService');

// Configuration
const GITHUB_REPO = process.env.GITHUB_REPO || 'ryvieos/Ryvie-Apps';
const repoUrl = `https://github.com/${GITHUB_REPO}.git`;
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

// Rate limit info in memory
let rateLimitInfo = {
  limit: null,
  remaining: null,
  reset: null,
  lastCheck: null
};

/**
 * Log et met à jour les informations de rate limit GitHub
 * Utilise l'endpoint /rate_limit qui ne consomme pas de requête
 */
function logRateLimit(headers, context = 'API call') {
  if (!headers) return;

  const limit = headers['x-ratelimit-limit'];
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];

  if (limit && remaining && reset) {
    rateLimitInfo = {
      limit: parseInt(limit),
      remaining: parseInt(remaining),
      reset: parseInt(reset),
      lastCheck: new Date().toISOString()
    };

    const resetDate = new Date(parseInt(reset) * 1000);
    const percentUsed = ((limit - remaining) / limit * 100).toFixed(1);

    console.log(`[GitHub Rate Limit] ${context}: ${remaining}/${limit} restantes (${percentUsed}% utilisé) - Reset: ${resetDate.toLocaleTimeString()}`);

    // Avertissement si moins de 20% restant
    if (remaining < limit * 0.2) {
      console.warn(`[GitHub Rate Limit] ⚠️  ATTENTION: Seulement ${remaining} requêtes restantes sur ${limit}!`);
      /*if (!GITHUB_TOKEN) {
        console.warn(`[GitHub Rate Limit] 💡 Ajoutez un GITHUB_TOKEN dans .env pour passer de 60 à 5000 requêtes/heure`);
      }*/
    }

    // Erreur critique si moins de 10 requêtes
    if (remaining < 10) {
      console.error(`[GitHub Rate Limit] 🚨 CRITIQUE: Seulement ${remaining} requêtes restantes! Reset dans ${Math.ceil((resetDate.getTime() - Date.now()) / 60000)} minutes`);
    }
  }
}

/**
 * Récupère les informations actuelles de rate limit
 */
function getRateLimitInfo() {
  return { ...rateLimitInfo, hasToken: !!GITHUB_TOKEN };
}

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
          // Utiliser sourceDir du manifest si disponible, sinon fallback sur entry.name
          const appDir = manifest.sourceDir || path.join(APPS_DIR, entry.name);
          console.log(`[appStore] Vérification de ${normalizedId}: dossier=${appDir}, buildId=${manifest.buildId}`);
          try {
            await fs.access(appDir);
            console.log(`[appStore] ✅ ${normalizedId}: dossier existe`);
          } catch {
            // Le dossier n'existe pas, l'app a été désinstallée manuellement
            console.log(`[appStore] ❌ ${normalizedId} détectée comme désinstallée (dossier absent: ${appDir})`);
            return;
          }
          
          const buildId = typeof manifest.buildId === 'number'
            ? manifest.buildId
            : null;
          if (buildId !== null) {
            installed[normalizedId] = buildId;
            console.log(`[appStore] ✅ ${normalizedId} ajouté avec buildId=${buildId}`);
          } else {
            console.log(`[appStore] ⚠️  ${normalizedId} ignoré (buildId=${manifest.buildId} n'est pas un nombre)`);
          }
        }
      } catch (manifestError: any) {
        if (manifestError.code !== 'ENOENT') {
          console.warn(`[appStore] Impossible de lire ${manifestPath}:`, manifestError.message);
        }
      }
    }));

    console.log(`[appStore] Apps installées détectées:`, Object.keys(installed));
    return installed;
  } catch (error: any) {
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
  } catch (error: any) {
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

// Compare deux buildIds numériques
function compareBuildIds(installedBuildId, latestBuildId) {
  if (installedBuildId === null || latestBuildId === null) {
    return null;
  }
  
  if (latestBuildId > installedBuildId) {
    return 'update-available';
  } else if (latestBuildId === installedBuildId) {
    return 'up-to-date';
  } else {
    return 'ahead';
  }
}

// Ajoute installedBuildId/updateAvailable/installed aux apps et liste celles à mettre à jour
async function enrichAppsWithInstalledVersions(apps) {
  if (!Array.isArray(apps)) {
    return { apps, updates: [] };
  }

  console.log('[appStore] 🔍 Chargement des versions installées...');
  const installedBuildIds = await loadInstalledVersions();
  console.log(`[appStore] 📋 Versions installées trouvées:`, Object.keys(installedBuildIds));
  const updates = [];

  const enriched = apps.map(app => {
    const installedBuildId = installedBuildIds?.[app.id];
    console.log(`[appStore] 📊 App ${app.id}:`);
    console.log(`[appStore]   - installedBuildId: ${installedBuildId}`);
    console.log(`[appStore]   - app.buildId: ${app.buildId}`);
    
    if (installedBuildId === null || installedBuildId === undefined) {
      // App non installée : supprimer les champs installedBuildId, updateAvailable et installed
      const { installedBuildId: _, updateAvailable: __, installed: ___, ...cleanApp } = app;
      console.log(`[appStore]   -> Non installée`);
      return { ...cleanApp, installed: false };
    }

    const status = compareBuildIds(installedBuildId, app.buildId);
    console.log(`[appStore]   - status: ${status}`);
    const enhancedApp = {
      ...app,
      installedBuildId,
      updateAvailable: status === 'update-available',
      installed: true
    };
    console.log(`[appStore]   -> updateAvailable: ${enhancedApp.updateAvailable}`);

    if (status === 'update-available') {
      updates.push({
        id: app.id,
        installedBuildId,
        latestBuildId: app.buildId
      });
    }

    return enhancedApp;
  });

  return { apps: enriched, updates };
}

/**
 * Récupère la dernière version depuis git ls-remote
 * En dev: récupère le dernier tag de pré-release (ex: v1.0.0-dev.1)
 * En prod: récupère le dernier tag stable (ex: v1.0.0)
 */
async function getLatestRelease() {
  try {
    // 1. Détecter le mode actuel (dev ou prod)
    let mode = 'prod';
    try {
      const pm2List = execSync('pm2 list', { encoding: 'utf8' });
      // Vérifier si "dev" est présent dans n'importe quel nom de processus
      if (pm2List.toLowerCase().includes('dev')) {
        mode = 'dev';
      }
    } catch (_) {
      mode = 'prod';
    }
    
    console.log(`[appStore] Mode détecté: ${mode}`);
    
    // 2. Récupérer tous les tags avec git ls-remote
    console.log('[appStore] Récupération des tags via ls-remote...');
    const out = execSync(`git ls-remote --tags --refs ${repoUrl}`, { encoding: 'utf8' });
    const tags = out
      .split('\n')
      .map(l => (l.split('\t')[1] || '').replace('refs/tags/', '').trim())
      .filter(Boolean);
    
    if (tags.length === 0) {
      console.log('[appStore] Aucun tag trouvé, utilisation de main');
      return {
        tag: 'main',
        name: 'main',
        publishedAt: new Date().toISOString(),
        assets: []
      };
    }
    
    console.log(`[appStore] ${tags.length} tags trouvés`);
    
    // 3. Filtrer selon le mode
    let targetTags;
    if (mode === 'dev') {
      // En dev: chercher les tags de pré-release (contenant 'dev' ou se terminant par un suffixe de pré-release)
      targetTags = tags.filter(t => 
        /-dev\.?\d*|alpha|beta|rc/.test(t) || 
        t.toLowerCase().includes('dev')
      );
      console.log(`[appStore] Mode dev: recherche de pré-release (${targetTags.length} trouvées)`);
    } else {
      // En prod: chercher les tags stables (version SemVer standard)
      targetTags = tags.filter(t => 
        /^v?\d+\.\d+\.\d+$/.test(t) && 
        !/-dev|alpha|beta|rc/.test(t)
      );
      console.log(`[appStore] Mode prod: recherche de release stable (${targetTags.length} trouvées)`);
    }
    
    // 4. Trier les tags avec compareVersions pour un ordre correct
    const sorted = targetTags.sort((a, b) => {
      const res = compareVersions(a, b);
      if (res === null) return 0;
      if (res === 'update-available') return -1; // b > a => a avant b
      if (res === 'ahead') return 1; // b < a => a après b
      return 0;
    });
    
    // 5. Prendre le tag le plus récent
    let targetTag = sorted[sorted.length - 1];
    
    // 6. Fallback si rien trouvé
    if (!targetTag) {
      if (mode === 'dev') {
        throw new Error(`Aucun tag de pré-release trouvé en mode dev. Tags disponibles: ${tags.join(', ')}`);
      } else {
        throw new Error(`Aucun tag stable trouvé en mode prod. Tags disponibles: ${tags.join(', ')}`);
      }
    }
    
    console.log(`[appStore] Tag sélectionné: ${targetTag}`);
    
    return {
      tag: targetTag,
      name: targetTag,
      publishedAt: new Date().toISOString(), // git ls-remote ne donne pas la date
      assets: []
    };
  } catch (error: any) {
    console.error('[appStore] Erreur lors de la récupération de la version:', error.message);
    throw error;
  }
}

/**
 * S'assure que le répertoire de données existe
 */
async function ensureDataDirectory() {
  try {
    await fs.mkdir(STORE_CATALOG, { recursive: true });
  } catch (error: any) {
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
  } catch (error: any) {
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
  } catch (error: any) {
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
  } catch (error: any) {
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
  } catch (error: any) {
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
    
    logRateLimit(response.headers, 'fetchAppsFromRelease');
    console.log(`[appStore] apps.json récupéré depuis la release: ${release.tag}`);
    return response.data;
  } catch (error: any) {
    console.error('[appStore] Erreur lors de la récupération de apps.json depuis la release:', error.message);
    
    // Vérifier si c'est une erreur de rate limit GitHub
    if (error.response?.status === 403 && error.response.data?.message?.includes('rate limit')) {
      const resetTime = error.response.headers?.['x-ratelimit-reset'];
      const remaining = error.response.headers?.['x-ratelimit-remaining'] || 0;
      const limit = error.response.headers?.['x-ratelimit-limit'] || 60;
      
      let waitMessage = '';
      if (resetTime) {
        const resetDate = new Date(parseInt(resetTime) * 1000);
        const resetTimeFormatted = resetDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        waitMessage = ` Réinitialisation à ${resetTimeFormatted}.`;
      }
      
      throw new Error(
        `Quota d'installations atteint (${remaining}/${limit} requêtes restantes).${waitMessage} ` +
        `Veuillez patienter avant de réessayer. ` +
        `💡 Astuce: Ajoutez un GITHUB_TOKEN dans votre fichier .env pour augmenter le quota à 5000 requêtes/heure.`
      );
    }
    
    // Propager l'erreur réelle
    throw error;
  }
}

/**
 * Télécharge une app depuis le repo GitHub via raw content (sans clone complet)
 */
async function downloadAppFromRepoArchive(release, appId, existingManifest = null) {
  console.log(`[appStore] 📥 Téléchargement de ${appId} via raw content...`);
  
  // Utiliser sourceDir du manifest existant si disponible (mise à jour)
  // Sinon utiliser le chemin par défaut (nouvelle installation)
  const appDir = existingManifest?.sourceDir || path.join(APPS_DIR, appId);
  console.log(`[appStore] 📂 Dossier de destination: ${appDir}`);
  
  // Déterminer le sous-dossier de destination basé sur dockerComposePath
  let targetSubDir = '';
  if (existingManifest?.dockerComposePath && existingManifest.dockerComposePath.includes('/')) {
    targetSubDir = path.dirname(existingManifest.dockerComposePath);
    console.log(`[appStore] 📁 Sous-dossier cible détecté depuis le manifest: ${targetSubDir}`);
  }
  
  // Créer un sous-volume Btrfs au lieu d'un simple dossier pour permettre les snapshots
  try {
    // Vérifier si le dossier existe déjà
    try {
      await fs.access(appDir);
      console.log(`[appStore] ℹ️  Le dossier ${appDir} existe déjà`);
      // S'assurer que le propriétaire est correct même si le dossier existe
      execSync(`sudo chown ryvie:ryvie "${appDir}"`, { stdio: 'inherit' });
    } catch {
      // Le dossier n'existe pas, créer un sous-volume Btrfs
      console.log(`[appStore] 📦 Création du sous-volume Btrfs: ${appDir}`);
      execSync(`sudo btrfs subvolume create "${appDir}"`, { stdio: 'inherit' });
      execSync(`sudo chown ryvie:ryvie "${appDir}"`);
      console.log(`[appStore] ✅ Sous-volume Btrfs créé`);
    }
  } catch (btrfsError: any) {
    // Si Btrfs échoue, annuler l'installation
    console.error(`[appStore] ❌ Impossible de créer un sous-volume Btrfs:`, btrfsError.message);
    throw new Error(`Impossible de créer un sous-volume Btrfs pour ${appId}: ${btrfsError.message}`);
  }
  
  // Configuration du repo
  const repoOwner = 'ryvieos';
  const repoName = 'Ryvie-Apps';
  const tag = release?.tag || 'main';
  
  console.log(`[appStore] 📋 Téléchargement depuis le tag: ${tag}`);
  
  try {
    // 1. Lister les fichiers via API REST (une seule requête)
    console.log(`[appStore] 🔍 Listing des fichiers de ${appId}...`);
    sendProgressUpdate(appId, 3, 'Récupération de la liste des fichiers...', 'preparation');
    
    const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${appId}`;
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Ryvie-App-Store'
    };
    
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }
    
    // Fonction récursive pour lister tous les fichiers
    const listAllFiles = async (path: string = ''): Promise<string[]> => {
      const url = path ? `${apiUrl}/${path}` : apiUrl;
      const response = await axios.get(url, {
        params: { ref: tag },
        headers,
        timeout: 30000
      });
      
      logRateLimit(response.headers, `listFiles: ${appId}/${path || 'root'}`);
      const items = response.data;
      const files: string[] = [];
      
      for (const item of items) {
        const itemPath = path ? `${path}/${item.name}` : item.name;
        
        if (item.type === 'file') {
          files.push(itemPath);
        } else if (item.type === 'dir') {
          // Récursion pour les sous-dossiers
          const subFiles = await listAllFiles(itemPath);
          files.push(...subFiles);
        }
      }
      
      return files;
    };
    
    const allFiles = await listAllFiles();
    console.log(`[appStore] 📋 ${allFiles.length} fichier(s) trouvé(s)`);
    sendProgressUpdate(appId, 5, `Téléchargement des fichiers...`, 'download');
    
    // 2. Télécharger tous les fichiers via raw content
    let downloadedCount = 0;
    
    for (let i = 0; i < allFiles.length; i++) {
      const filePath = allFiles[i];
      const progressPercent = 5 + (i / allFiles.length) * 60;
      sendProgressUpdate(appId, progressPercent, `Téléchargement: ${filePath}...`, 'download');
      
      try {
        // Construire l'URL raw
        const rawUrl = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${tag}/${appId}/${filePath}`;
        
        // Télécharger le fichier
        const fileResponse = await axios.get(rawUrl, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': 'Ryvie-App-Store' },
          timeout: 300000
        });
        
        // Construire le chemin local (dans le sous-dossier si spécifié)
        const localFilePath = targetSubDir 
          ? path.join(appDir, targetSubDir, filePath)
          : path.join(appDir, filePath);
        
        // Créer le répertoire si nécessaire
        const localDir = path.dirname(localFilePath);
        if (!fsSync.existsSync(localDir)) {
          await fs.mkdir(localDir, { recursive: true });
        }
        
        // Sauvegarder le fichier
        await fs.writeFile(localFilePath, fileResponse.data);
        downloadedCount++;
        
        console.log(`[appStore] ✅ ${filePath} téléchargé`);
      } catch (error: any) {
        console.error(`[appStore] ❌ Erreur lors du téléchargement de ${filePath}:`, error.message);
        if (error.response?.status === 404) {
          console.log(`[appStore] ⚠️ Fichier ${filePath} non trouvé, passage au suivant`);
          continue;
        }
        throw new Error(`Échec du téléchargement de ${filePath}`);
      }
    }
    
    // 3. Vérifier que les fichiers requis sont présents
    sendProgressUpdate(appId, 65, 'Vérification des fichiers requis...', 'verification');
    
    // Déterminer le dossier où chercher les fichiers
    let checkDir = appDir;
    if (existingManifest?.dockerComposePath && existingManifest.dockerComposePath.includes('/')) {
      const subDir = path.dirname(existingManifest.dockerComposePath);
      checkDir = path.join(appDir, subDir);
      console.log(`[appStore] 📂 Vérification dans le sous-dossier: ${subDir}`);
    }
    
    const requiredFiles = ['docker-compose.yml', 'ryvie-app.yml'];
    const missingFiles = [];
    
    for (const requiredFile of requiredFiles) {
      const filePath = path.join(checkDir, requiredFile);
      try {
        await fs.access(filePath);
        console.log(`[appStore] ✅ Fichier requis trouvé: ${requiredFile}`);
      } catch {
        missingFiles.push(requiredFile);
      }
    }
    
    // Vérifier l'icône
    const iconExtensions = ['png', 'svg', 'jpg', 'jpeg'];
    let iconFound = false;
    for (const ext of iconExtensions) {
      try {
        await fs.access(path.join(checkDir, `icon.${ext}`));
        console.log(`[appStore] ✅ Icône trouvée: icon.${ext}`);
        iconFound = true;
        break;
      } catch {}
    }
    if (!iconFound) {
      missingFiles.push('icon.png/svg');
    }
    
    if (missingFiles.length > 0) {
      throw new Error(`Fichiers requis manquants dans ${checkDir}: ${missingFiles.join(', ')}`);
    }
    
    sendProgressUpdate(appId, 65, 'Fichiers vérifiés avec succès', 'verification');
    
    console.log(`[appStore] 🎉 ${appId} téléchargé avec succès (${downloadedCount} fichier(s))`);
    return appDir;
    
  } catch (error: any) {
    // Gestion des erreurs spécifiques à GitHub
    if (error.response?.status === 404) {
      throw new Error(`Application "${appId}" non trouvée dans le repo ${repoOwner}/${repoName}`);
    } else if (error.response?.status === 403) {
      // Vérifier si c'est une erreur de rate limit
      if (error.response.data?.message?.includes('rate limit')) {
        const resetTime = error.response.headers?.['x-ratelimit-reset'];
        const remaining = error.response.headers?.['x-ratelimit-remaining'] || 0;
        const limit = error.response.headers?.['x-ratelimit-limit'] || 60;
        
        let waitMessage = '';
        if (resetTime) {
          const resetDate = new Date(parseInt(resetTime) * 1000);
          const resetTimeFormatted = resetDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
          waitMessage = ` Réinitialisation à ${resetTimeFormatted}.`;
        }
        
        throw new Error(
          `Quota d'installations atteint (${remaining}/${limit} requêtes restantes).${waitMessage} ` +
          `Veuillez patienter avant de réessayer. ` +
          `💡 Astuce: Ajoutez un GITHUB_TOKEN dans votre fichier .env pour augmenter le quota à 5000 requêtes/heure.`
        );
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
    } catch (cleanupError: any) {
      console.error(`[appStore] ⚠️  Erreur lors du nettoyage:`, cleanupError.message);
    }
    
    throw new Error(`Échec du téléchargement de ${appId}: ${error.message}`);
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
  } catch (error: any) {
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
  let existingManifest = null; // Manifest de l'installation existante
  
  try {
    console.log(`[Update] Début de la mise à jour/installation de ${appId} depuis l'App Store...`);
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    
    // Initialisation - envoyer la première mise à jour
    sendProgressUpdate(appId, 0, 'Préparation de l\'installation...', 'init');
    await new Promise(resolve => setTimeout(resolve, 500)); // Petit délai pour que le client reçoive
    
    sendProgressUpdate(appId, 2, 'Vérification des prérequis...', 'init');
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Vérifier si l'app est déjà installée en lisant le manifest existant
    const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      existingManifest = JSON.parse(manifestContent);
      console.log(`[Update] ✅ Manifest existant trouvé pour ${appId}`);
      console.log(`[Update] 📂 sourceDir: ${existingManifest.sourceDir}`);
      console.log(`[Update] 📄 dockerComposePath: ${existingManifest.dockerComposePath}`);
    } catch (manifestError: any) {
      if (manifestError.code === 'ENOENT') {
        console.log(`[Update] ℹ️ Aucun manifest existant, nouvelle installation`);
      } else {
        console.warn(`[Update] ⚠️ Erreur lors de la lecture du manifest:`, manifestError.message);
      }
    }
    
    // 1. Créer un snapshot SEULEMENT si c'est une mise à jour (app déjà installée)
    if (existingManifest) {
      currentStep = 'snapshot-creation';
      console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
      console.log('[Update] 📸 Création du snapshot de sécurité...');
      sendProgressUpdate(appId, 3, 'Création du snapshot de sécurité...', 'snapshot');
      
      try {
        const snapshotOutput = execSync(`sudo /opt/Ryvie/scripts/snapshot-app.sh ${appId}`, { encoding: 'utf8' });
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
      } catch (snapError: any) {
        console.error('[Update] ❌ Impossible de créer le snapshot:', snapError.message);
        throw new Error(`Création du snapshot échouée: ${snapError.message}. Mise à jour annulée pour des raisons de sécurité.`);
      }
    } else {
      console.log('[Update] ℹ️ Nouvelle installation, pas de snapshot nécessaire');
      sendProgressUpdate(appId, 3, 'Nouvelle installation...', 'init');
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
    appDir = await downloadAppFromRepoArchive(latestRelease, appId, existingManifest);
    
    sendProgressUpdate(appId, 68, 'Application téléchargée, configuration en cours...', 'extraction');
    
    console.log(`[Update] ✅ ${appId} téléchargé dans ${appDir}`);

    // 4. Déterminer la méthode d'installation
    console.log('[Update] 🔎 Étape courante: installation-check');
    const installScriptPath = path.join(appDir, 'install.sh');
    const isUpdate = existingManifest !== null;
    let hasInstallScript = false;
    
    try {
      await fs.access(installScriptPath);
      hasInstallScript = true;
      if (isUpdate) {
        console.log('[Update] ℹ️ Script install.sh détecté mais IGNORÉ (mise à jour)');
      } else {
        console.log('[Update] ✅ Script install.sh détecté (nouvelle installation)');
      }
    } catch {
      console.log('[Update] ℹ️ Aucun script install.sh, utilisation de docker-compose');
    }
    
    sendProgressUpdate(appId, 75, 'Lancement de l\'installation...', 'installation');
    
    // IMPORTANT: Pour les mises à jour, TOUJOURS utiliser docker compose --build
    // Le script install.sh est uniquement pour les nouvelles installations
    if (hasInstallScript && !isUpdate) {
      // Utiliser le script install.sh UNIQUEMENT pour les nouvelles installations
      console.log('[Update] 🚀 Exécution du script install.sh (nouvelle installation)...');
      console.log(`[Update] 📂 Dossier de travail: ${appDir}`);
      
      try {
        // Rendre le script exécutable
        execSync(`chmod +x "${installScriptPath}"`, { stdio: 'pipe' });
        
        // Exécuter le script install.sh
        execSync(`sudo bash "${installScriptPath}"`, { 
          cwd: appDir, 
          stdio: 'inherit',
          env: { ...process.env, APP_ID: appId }
        });
        console.log('[Update] ✅ Script install.sh exécuté avec succès');
      } catch (installError: any) {
        console.error('[Update] ❌ Erreur lors de l\'exécution du script install.sh:', installError.message);
        throw new Error(`Échec de l'exécution du script install.sh: ${installError.message}`);
      }
    } else {
      // Utiliser docker-compose pour les mises à jour OU si pas de install.sh
      if (isUpdate) {
        console.log('[Update] 🔎 Étape courante: docker-compose-up (MISE À JOUR)');
      } else {
        console.log('[Update] 🔎 Étape courante: docker-compose-up (nouvelle installation)');
      }
      
      // Utiliser dockerComposePath du manifest existant si disponible
      let composeFile = null;
      
      if (existingManifest?.dockerComposePath) {
        composeFile = existingManifest.dockerComposePath;
        console.log(`[Update] 📄 Utilisation du dockerComposePath du manifest: ${composeFile}`);
        
        // Vérifier que le fichier existe
        try {
          await fs.access(path.join(appDir, composeFile));
          console.log(`[Update] ✅ Fichier docker-compose trouvé: ${composeFile}`);
        } catch {
          console.warn(`[Update] ⚠️ Fichier ${composeFile} non trouvé, recherche automatique...`);
          composeFile = null;
        }
      }
      
      // Si pas de manifest ou fichier non trouvé, détecter automatiquement
      if (!composeFile) {
        const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'];
        for (const file of composeFiles) {
          try {
            await fs.access(path.join(appDir, file));
            composeFile = file;
            break;
          } catch {}
        }
      }

      if (!composeFile) {
        throw new Error(`Aucun fichier docker-compose trouvé`);
      }
      
      // Générer le fichier .env avec LOCAL_IP avant de lancer docker compose
      const envPath = path.join(appDir, '.env');
      const localIP = getLocalIP();
      
      try {
        // Vérifier si un .env existe déjà
        await fs.access(envPath);
        console.log('[Update] ✅ Fichier .env déjà présent');
      } catch {
        // Créer le fichier .env avec LOCAL_IP
        const envContent = `# Fichier .env généré automatiquement par Ryvie
# Ne pas modifier manuellement - sera régénéré lors des mises à jour

# IP locale du serveur
LOCAL_IP=${localIP}
`;
        await fs.writeFile(envPath, envContent);
        console.log(`[Update] ✅ Fichier .env créé avec LOCAL_IP=${localIP}`);
      }
      
      // Nettoyer les containers existants avant de lancer (évite les conflits de noms)
      console.log('[Update] 🧹 Nettoyage des anciens containers...');
      try {
        // Lister tous les containers de cette app (en cours ou arrêtés)
        const containersOutput = execSync(`docker ps -a --filter "name=app-${appId}" --format "{{.Names}}"`, { 
          encoding: 'utf8',
          stdio: 'pipe'
        }).trim();
        
        if (containersOutput) {
          const containers = containersOutput.split('\n').filter(name => name.trim());
          console.log(`[Update] 🗑️ Suppression de ${containers.length} container(s) existant(s)...`);
          
          for (const containerName of containers) {
            try {
              execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
              console.log(`[Update] ✅ Container ${containerName} supprimé`);
            } catch (rmError: any) {
              console.warn(`[Update] ⚠️ Impossible de supprimer ${containerName}:`, rmError.message);
            }
          }
        } else {
          console.log('[Update] ℹ️ Aucun container existant à nettoyer');
        }
      } catch (cleanupError: any) {
        // Non bloquant - l'app n'existe peut-être pas encore
        console.log('[Update] ℹ️ Aucun container existant à nettoyer');
      }
      
      // Lancer docker compose avec rebuild si c'est une mise à jour
      const buildFlag = isUpdate ? '--build' : '';
      
      if (isUpdate) {
        console.log('[Update]   Rebuild et lancement des containers (mise à jour)...');
        sendProgressUpdate(appId, 76, 'Reconstruction des images Docker...', 'build');
      } else {
        console.log('[Update]    Lancement des containers (nouvelle installation)...');
      }
      
      // Déterminer le dossier de travail : si le docker-compose est dans un sous-dossier,
      // utiliser ce sous-dossier comme cwd pour que ${PWD} fonctionne correctement
      const workingDir = composeFile.includes('/') 
        ? path.join(appDir, path.dirname(composeFile))
        : appDir;
      const composeFileName = path.basename(composeFile);
      
      console.log(`[Update] 📂 Dossier de travail: ${workingDir}`);
      console.log(`[Update] 📄 Fichier compose: ${composeFileName}`);
      console.log(`[Update] 🔧 Commande: docker compose -f ${composeFileName} up -d ${buildFlag}`);
      
      try {
        // Ne pas utiliser -p car les container_name sont fixes dans le docker-compose.yml
        // Ajouter --build pour forcer le rebuild lors des mises à jour
        execSync(`docker compose -f ${composeFileName} up -d ${buildFlag}`, { 
          cwd: workingDir, 
          stdio: 'inherit'
        });
        console.log('[Update] ✅ Containers lancés avec succès');
      } catch (composeError: any) {
        console.error('[Update] ❌ Erreur lors du lancement docker compose:', composeError.message);
        console.error('[Update] 📋 Vérification du fichier docker-compose.yml...');
        
        // Afficher le contenu du fichier modifié pour debug
        const modifiedContent = await fs.readFile(path.join(appDir, composeFile), 'utf8');
        console.error('[Update] 📄 Contenu du docker-compose.yml modifié:');
        console.error(modifiedContent.substring(0, 1000)); // Premiers 1000 caractères
        
        throw new Error(`Échec du lancement docker compose: ${composeError.message}`);
      }
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
    
    // Vérification rapide du statut des containers
    currentStep = 'container-status-check';
    console.log(`[Update] 🔎 Vérification du statut des containers pour ${appId}...`);
    
    try {
      const projectLabel = appId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      console.log(`[Update] 🔍 Vérification via label de projet: ${projectLabel}`);
      let containersOutput = execSync(`docker ps -a --filter "label=com.docker.compose.project=${projectLabel}" --format "{{.Names}}:{{.Status}}"`, {
        encoding: 'utf8'
      }).trim();

      // Fallback sur le nom exact si aucun container n'est trouvé via le label
      if (!containersOutput) {
        console.log('[Update] 🔍 Aucun container via label, tentative sur le nom exact...');
        containersOutput = execSync(`docker ps -a --filter "name=${appId}" --format "{{.Names}}:{{.Status}}"`, {
          encoding: 'utf8'
        }).trim();
      }

      // Dernier fallback: nom normalisé (ex: app-rdrive-*)
      if (!containersOutput) {
        const normalizedName = projectLabel;
        console.log(`[Update] 🔍 Tentative finale avec le nom normalisé: ${normalizedName}`);
        containersOutput = execSync(`docker ps -a --filter "name=${normalizedName}" --format "{{.Names}}:{{.Status}}"`, {
          encoding: 'utf8'
        }).trim();
      }
      
      if (!containersOutput) {
        throw new Error(`Aucun container trouvé pour ${appId}`);
      }
      
      const containers = containersOutput.split('\n').filter(line => line.trim());
      let isAContainerUp = false;
      
      for (const containerLine of containers) {
        const [name, status] = containerLine.split(':');
        
        if (status.toLowerCase().includes('up')) {
          isAContainerUp = true;
        } else {
          const exitCodeMatch = status.match(/exited \((\d+)\)/i);
          if (exitCodeMatch && parseInt(exitCodeMatch[1]) > 0) {
            throw new Error(`Container ${name} a crashé avec le code ${exitCodeMatch[1]}`);
          }
        }
      }
      
      if (!isAContainerUp) {
        throw new Error(`Aucun container en cours d'exécution pour ${appId}`);
      }
      
      console.log(`[Update] ✅ Au moins un container est en cours d'exécution`);
      
    } catch (checkError: any) {
      console.error(`[Update] ❌ Détails erreur de vérification container: ${checkError.message}`);
      if (checkError.stdout) {
        console.error('[Update] stdout:', checkError.stdout.toString());
      }
      if (checkError.stderr) {
        console.error('[Update] stderr:', checkError.stderr.toString());
      }
      throw new Error(`Vérification du container échouée: ${checkError.message}`);
    }
    
    sendProgressUpdate(appId, 93, 'Finalisation de l\'installation...', 'finalization');
    
    // 5. Préparer la configuration proxy (génération .env uniquement)
    currentStep = 'reverse-proxy-prepare';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    let proxyConfigData = null;
    try {
      console.log(`[Update] 🔍 Vérification de la configuration proxy pour ${appId}...`);
      const reverseProxyService = require('./reverseProxyService');
      const proxyConfigResult = await reverseProxyService.readAppProxyConfig(appId);
      
      if (proxyConfigResult.success && proxyConfigResult.proxy) {
        console.log(`[Update] 📦 Configuration proxy détectée pour ${appId}`);
        sendProgressUpdate(appId, 94, 'Préparation de la configuration proxy...', 'proxy-prepare');
        
        const fs = require('fs').promises;
        
        // Générer le fichier .env pour l'app avec les variables dynamiques
        console.log(`[Update] 📝 Génération du fichier .env pour ${appId}...`);
        const envResult = await reverseProxyService.generateAppEnvFile(appId, proxyConfigResult.proxy);
        if (envResult.success) {
          console.log(`[Update] ✅ Fichier .env créé: ${envResult.path}`);
        }
        
        // Sauvegarder les infos pour la mise à jour Caddy après 100%
        proxyConfigData = {
          reverseProxyService,
          fs,
          appId
        };
      } else {
        console.log(`[Update] ℹ️ Pas de configuration proxy pour ${appId}`);
      }
    } catch (proxyError: any) {
      console.warn(`[Update] ⚠️ Erreur lors de la préparation du reverse proxy:`, proxyError.message);
      // Non bloquant - on continue l'installation
    }
    
    sendProgressUpdate(appId, 95, 'Finalisation de l\'installation...', 'finalization');
    
    // 5b. Actualiser le catalogue pour mettre à jour les statuts
    currentStep = 'catalog-refresh';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    try {
      console.log('[Update] 🔄 Actualisation du catalogue...');
      const localApps = await loadAppsFromFile();
      if (Array.isArray(localApps)) {
        console.log(`[Update] 📋 ${localApps.length} apps trouvées dans le catalogue`);
        const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(localApps);
        console.log(`[Update] 📋 ${enrichedApps.length} apps après enrichissement`);
        
        // Vérifier le statut de l'app mise à jour
        const updatedApp = enrichedApps.find(app => app.id === appId);
        if (updatedApp) {
          console.log(`[Update] 📊 Statut de ${appId}:`);
          console.log(`[Update]   - installedVersion: ${updatedApp.installedVersion}`);
          console.log(`[Update]   - latestVersion: ${updatedApp.latestVersion}`);
          console.log(`[Update]   - updateAvailable: ${updatedApp.updateAvailable}`);
        }
        
        await saveAppsToFile(enrichedApps);
        console.log('[Update] ✅ Catalogue actualisé');
      }
    } catch (catalogError: any) {
      console.warn('[Update] ⚠️ Impossible d\'actualiser le catalogue:', catalogError.message);
    }
    
    console.log(`[Update] ✅ ${appId} installé/mis à jour avec succès`);
    
    // Invalider le cache des statuts pour forcer une mise à jour immédiate
    try {
      const dockerService = require('./dockerService');
      if (dockerService.clearAppStatusCache) {
        dockerService.clearAppStatusCache();
        console.log('[Update] 🔄 Cache des statuts invalidé');
      }
    } catch (e: any) {
      console.warn('[Update] ⚠️ Impossible d\'invalider le cache:', e.message);
    }
    
    // 5c. Vérifier que l'app est visible avec un statut valide avant de terminer
    currentStep = 'app-status-verification';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    sendProgressUpdate(appId, 97, 'Vérification du statut de l\'application...', 'verification');
    
    let appStatusVerified = false;
    const maxStatusChecks = 10; // 10 tentatives max (20 secondes au total)
    const statusCheckInterval = 2000; // 2 secondes entre chaque tentative
    
    for (let attempt = 1; attempt <= maxStatusChecks; attempt++) {
      try {
        console.log(`[Update] 🔍 Tentative ${attempt}/${maxStatusChecks} de vérification du statut de ${appId}...`);
        
        // Vérifier directement avec docker ps au lieu des manifests
        const { execSync } = require('child_process');
        const appPath = `/data/apps/${appId}`;
        
        try {
          // Utiliser docker compose ps pour vérifier l'état des containers
          const psOutput = execSync('docker compose ps --format json', { 
            cwd: appPath, 
            encoding: 'utf8',
            stdio: 'pipe'
          });
          
          if (psOutput && psOutput.trim()) {
            const containers = psOutput.trim().split('\n').map((line: string) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            }).filter((c: any) => c !== null);
            
            console.log(`[Update] 📊 ${containers.length} container(s) trouvé(s) pour ${appId}`);
            
            // Vérifier si au moins un container est en running ou starting
            const hasValidContainer = containers.some((c: any) => {
              const state = c.State || '';
              console.log(`[Update] 📦 Container ${c.Name}: ${state}`);
              return state === 'running' || state.includes('starting') || state.includes('Up');
            });
            
            if (hasValidContainer) {
              console.log(`[Update] ✅ ${appId} a au moins un container démarré`);
              appStatusVerified = true;
              break;
            } else {
              console.log(`[Update] ⏳ Aucun container de ${appId} n'est encore démarré, attente...`);
            }
          } else {
            console.log(`[Update] ⏳ Aucun container trouvé pour ${appId}, attente...`);
          }
        } catch (dockerError: any) {
          console.log(`[Update] ⏳ Erreur docker ps pour ${appId}: ${dockerError.message}`);
        }
        
        // Attendre avant la prochaine tentative (sauf à la dernière)
        if (attempt < maxStatusChecks) {
          await new Promise(resolve => setTimeout(resolve, statusCheckInterval));
        }
      } catch (statusError: any) {
        console.warn(`[Update] ⚠️ Erreur lors de la vérification du statut (tentative ${attempt}):`, statusError.message);
      }
    }
    
    if (!appStatusVerified) {
      console.warn(`[Update] ⚠️ Impossible de vérifier le statut de ${appId} après ${maxStatusChecks} tentatives`);
      // On continue quand même mais on log un warning
    }
    
    // Déclencher une mise à jour immédiate des statuts via Socket.IO
    try {
      const io = (global as any).io;
      if (io) {
        const dockerService = require('./dockerService');
        const apps = await dockerService.getAppStatus();
        io.emit('apps-status-update', apps);
        io.emit('appsStatusUpdate', apps);
        console.log('[Update] 📡 Statuts diffusés via Socket.IO');
      }
    } catch (e: any) {
      console.warn('[Update] ⚠️ Impossible de diffuser les statuts:', e.message);
    }
    
    // 6. Régénérer le manifest AVANT 100% pour affichage instantané de l'icône
    currentStep = 'manifest-regeneration';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    try {
      console.log(`[Update] Régénération du manifest pour ${appId}...`);
      const manifestScript = path.join(RYVIE_DIR, 'generate-manifests.js');
      // Passer l'appId en paramètre pour ne générer que le manifest de cette app
      execSync(`node ${manifestScript} ${appId}`, { stdio: 'inherit' });
      console.log(`[Update] ✅ Manifest de ${appId} régénéré`);
    } catch (manifestError: any) {
      console.warn(`[Update] ⚠️ Impossible de régénérer le manifest de ${appId}:`, manifestError.message);
    }
    
    // 6b. Provisionner le client SSO si le manifest a sso: true
    currentStep = 'sso-client-provisioning';
    console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
    try {
      const keycloakService = require('./keycloakService');
      if (keycloakService.ensureAppSSOClient) {
        sendProgressUpdate(appId, 99, 'Vérification du client SSO...', 'sso');
        keycloakService.ensureAppSSOClient(appId);
      }
    } catch (ssoError: any) {
      console.warn(`[Update] ⚠️ Erreur lors du provisionnement SSO pour ${appId}:`, ssoError.message);
      // Non bloquant - l'installation est déjà terminée
    }
    
    sendProgressUpdate(appId, 100, 'Installation terminée avec succès !', 'completed');
    
    // 7. Forcer la réconciliation du layout pour placer l'icône AVANT de modifier Caddy
    console.log('[Update] 🔄 Réconciliation du layout utilisateur...');
    try {
      const userPreferencesRouter = require('../routes/userPreferences');
      if (userPreferencesRouter.reconcileAllUsersLayout) {
        await userPreferencesRouter.reconcileAllUsersLayout();
        console.log('[Update] ✅ Réconciliation du layout effectuée');
      } else {
        console.warn('[Update] ⚠️ Fonction reconcileAllUsersLayout non disponible');
      }
    } catch (reconcileError: any) {
      console.warn('[Update] ⚠️ Erreur lors de la réconciliation:', reconcileError.message);
    }
    
    // 8. Attendre 5 secondes pour laisser le temps au frontend d'afficher la notification
    // avant de modifier Caddy (pour éviter rechargement de page)
    console.log('[Update] ⏳ Attente de 10 secondes avant modification de Caddy...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // 8. Mettre à jour Caddy si nécessaire (APRÈS 100% et délai de 5s)
    if (proxyConfigData) {
      currentStep = 'reverse-proxy-update';
      console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
      try {
        const { reverseProxyService, fs, appId: proxyAppId } = proxyConfigData;
        const path = require('path');
        const { execSync } = require('child_process');
        
        console.log(`[Update] 🔧 Mise à jour de la configuration Caddy pour ${proxyAppId}...`);
        
        // Vérifier si les ports ont changé dans docker-compose.yml AVANT de modifier
        console.log(`[Update] 🔍 Vérification des changements de ports Caddy...`);
        const composeContent = await reverseProxyService.generateCaddyDockerCompose();
        const composePath = '/data/config/reverse-proxy/docker-compose.yml';
        
        let needsRecreate = false;
        try {
          const currentCompose = await fs.readFile(composePath, 'utf8');
          
          // Si le docker-compose a changé, il faut recréer le container
          if (currentCompose !== composeContent) {
            console.log(`[Update] 📝 Ports Caddy modifiés, recréation du container nécessaire`);
            needsRecreate = true;
          } else {
            console.log(`[Update] ℹ️ Ports Caddy inchangés, rechargement gracieux possible`);
          }
        } catch (e) {
          console.log(`[Update] ℹ️ Fichier docker-compose.yml non trouvé, création nécessaire`);
          needsRecreate = true;
        }
        
        // Écrire les nouveaux fichiers
        console.log(`[Update] 🔧 Mise à jour docker-compose.yml de Caddy...`);
        await fs.writeFile(composePath, composeContent);
        console.log(`[Update] ✅ docker-compose.yml de Caddy mis à jour`);
        
        console.log(`[Update] 🔧 Mise à jour Caddyfile...`);
        const caddyfileContent = await reverseProxyService.generateFullCaddyfileContent();
        const caddyfilePath = '/data/config/reverse-proxy/Caddyfile';
        await fs.writeFile(caddyfilePath, caddyfileContent);
        console.log(`[Update] ✅ Caddyfile mis à jour avec la config de ${proxyAppId}`);
        
        if (needsRecreate) {
          // Recréer Caddy avec les nouveaux ports (down + up)
          console.log(`[Update] 🔄 Recréation de Caddy avec les nouveaux ports...`);
          try {
            execSync('docker compose down', { cwd: '/data/config/reverse-proxy', stdio: 'pipe' });
            execSync('docker compose up -d', { cwd: '/data/config/reverse-proxy', stdio: 'pipe' });
            console.log(`[Update] ✅ Caddy recréé avec succès`);
          } catch (restartError: any) {
            console.warn(`[Update] ⚠️ Échec de la recréation de Caddy:`, restartError.message);
          }
        } else {
          // Juste recharger la configuration sans interruption
          console.log(`[Update] 🔄 Rechargement gracieux de la configuration Caddy...`);
          try {
            const reloadResult = await reverseProxyService.reloadCaddy();
            if (reloadResult.success) {
              console.log(`[Update] ✅ Configuration Caddy rechargée sans interruption`);
            } else {
              console.warn(`[Update] ⚠️ Échec du rechargement:`, reloadResult.error);
            }
          } catch (reloadError: any) {
            console.warn(`[Update] ⚠️ Échec du rechargement de Caddy:`, reloadError.message);
          }
        }
        
        // Redémarrer l'app pour prendre en compte le nouveau .env
        console.log(`[Update] 🔄 Redémarrage de ${proxyAppId} pour appliquer les variables...`);
        try {
          const appPath = `/data/apps/${proxyAppId}`;
          execSync('docker compose restart', { cwd: appPath, stdio: 'pipe' });
          console.log(`[Update] ✅ ${proxyAppId} redémarré avec succès`);
        } catch (appRestartError: any) {
          console.warn(`[Update] ⚠️ Échec du redémarrage de ${proxyAppId}:`, appRestartError.message);
        }
      } catch (proxyError: any) {
        console.warn(`[Update] ⚠️ Erreur lors de la mise à jour du reverse proxy:`, proxyError.message);
        // Non bloquant - l'installation est déjà terminée
      }
    }
    
    // 9. Mettre à jour le buildId dans apps-versions.json
    console.log('[Update] 📝 Mise à jour du buildId dans apps-versions.json...');
    try {
      let installedVersions = {};
      try {
        const raw = await fs.readFile(APPS_VERSIONS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          installedVersions = parsed;
        }
      } catch (e: any) {
        console.log('[Update] ℹ️ apps-versions.json non trouvé, création...');
      }
      
      // Récupérer le buildId depuis le catalogue
      const localApps = await loadAppsFromFile();
      const appInfo = localApps.find(app => app.id === appId);
      if (appInfo && appInfo.buildId) {
        installedVersions[appId] = appInfo.buildId;
        await fs.writeFile(APPS_VERSIONS_FILE, JSON.stringify(installedVersions, null, 2));
        console.log(`[Update] ✅ BuildId ${appInfo.buildId} sauvegardé pour ${appId}`);
      } else {
        console.warn(`[Update] ⚠️ Impossible de trouver le buildId pour ${appId}`);
      }
    } catch (versionError: any) {
      console.warn('[Update] ⚠️ Erreur lors de la mise à jour du buildId:', versionError.message);
    }
    
    
    // 10. Supprimer le snapshot si tout s'est bien passé
    if (snapshotPath && snapshotPath !== 'none') {
      currentStep = 'snapshot-cleanup';
      console.log(`[Update] 🔎 Étape courante: ${currentStep}`);
      console.log('[Update] 🧹 Suppression du snapshot de sécurité...');
      try {
        execSync(`sudo btrfs subvolume delete "${snapshotPath}"`, { stdio: 'inherit' });
        console.log('[Update] ✅ Snapshot supprimé');
      } catch (delError: any) {
        console.warn('[Update] ⚠️ Impossible de supprimer le snapshot:', delError.message , '. attention cela peut causer des problèmes à votre machine sur le long terme! Veuillez vérifier manuellement le sous-volume si nécessaire.' );
      }
    }
    
    return {
      success: true,
      message: `${appId} installé/mis à jour avec succès depuis l'App Store`,
      appDir
    };
  } catch (error: any) {
    console.error(`[Update] ❌ Erreur à l'étape ${currentStep}:`, error.message);
    if (error.stack) {
      console.error('[Update] Stack trace:', error.stack);
    }
    console.error(`[Update] ❌ Erreur lors de l'installation/mise à jour de ${appId}:`, error.message);
    
    // Envoyer le message d'erreur détaillé au frontend via progressEmitter
    sendProgressUpdate(appId, 0, error.message, 'error');
    
    // Rollback automatique si un snapshot existe (AVANT de nettoyer)
    if (snapshotPath && snapshotPath !== 'none') {
      console.error('[Update] 🔄 Rollback en cours...');
      console.error(`[Update] 📸 Snapshot path: ${snapshotPath}`);
      console.error(`[Update] 📂 App dir: ${appDir}`);
      
      // Si appDir est null (erreur avant création), utiliser le chemin par défaut
      const targetDir = appDir || path.join(APPS_DIR, appId);
      console.error(`[Update] 🎯 Target dir pour rollback: ${targetDir}`);
      
      // Vérifier que le snapshot existe bien
      try {
        const snapshotExists = execSync(`sudo btrfs subvolume show "${snapshotPath}"`, { 
          encoding: 'utf8',
          stdio: 'pipe'
        });
        console.error('[Update] ✅ Snapshot trouvé sur le système de fichiers');
        console.error(`[Update] 📄 Snapshot info: ${snapshotExists.substring(0, 200)}...`);
      } catch (checkError: any) {
        console.error('[Update] ❌ Snapshot non trouvé:', checkError.message);
        // Continuer quand même, le script rollback gérera l'erreur
      }
      
      try {
        console.error(`[Update] 🚀 Exécution du rollback: sudo /opt/Ryvie/scripts/rollback-app.sh "${snapshotPath}" "${targetDir}"`);
        const rollbackOutput = execSync(`sudo /opt/Ryvie/scripts/rollback-app.sh "${snapshotPath}" "${targetDir}"`, { 
          encoding: 'utf8',
          stdio: 'pipe'  // Capturer la sortie pour les logs
        });
        console.error('[Update] 📤 Rollback output:');
        console.error(rollbackOutput);
        console.error('[Update] ✅ Rollback terminé');
        
        // Vérifier que le dossier a bien été restauré
        try {
          const restoredFiles = execSync(`ls -la "${targetDir}"`, { encoding: 'utf8' });
          console.error('[Update] 📁 Fichiers restaurés:');
          console.error(restoredFiles);
        } catch (lsError: any) {
          console.error('[Update] ❌ Impossible de lister les fichiers restaurés:', lsError.message);
        }
        
        // Supprimer le snapshot après rollback réussi
        try {
          console.error(`[Update] 🧹 Suppression du snapshot: ${snapshotPath}`);
          execSync(`sudo btrfs subvolume delete "${snapshotPath}"`, { stdio: 'inherit' });
          console.error('[Update] 🧹 Snapshot supprimé après rollback');
        } catch (delError: any) {
          console.warn('[Update] ⚠️ Impossible de supprimer le snapshot:', delError.message);
        }
        
        return {
          success: false,
          message: `Erreur: ${error.message}. Rollback effectué avec succès.`
        };
      } catch (rollbackError: any) {
        console.error('[Update] ❌ Échec du rollback:', rollbackError.message);
        console.error('[Update] 📤 Rollback stderr:', rollbackError.stderr);
        console.error('[Update] 📤 Rollback stdout:', rollbackError.stdout);
        
        // Si le rollback échoue, nettoyer le dossier partiel seulement s'il existe
        if (targetDir && targetDir !== path.join(APPS_DIR, appId)) {
          console.log(`[Update] 🧹 Nettoyage du dossier ${targetDir} suite à l'échec du rollback...`);
          try {
            execSync(`sudo rm -rf "${targetDir}"`, { stdio: 'inherit' });
            console.log(`[Update] ✅ Dossier ${targetDir} supprimé`);
          } catch (cleanupError: any) {
            console.warn(`[Update] ⚠️ Impossible de supprimer ${targetDir}:`, cleanupError.message);
          }
        }
        
        // SUPPRIMER LE SNAPSHOT DANS TOUS LES CAS (même si rollback échoue)
        console.error(`[Update] 🧹 SUPPRESSION FORCÉE du snapshot: ${snapshotPath}`);
        try {
          execSync(`sudo btrfs subvolume delete "${snapshotPath}"`, { stdio: 'inherit' });
          console.error('[Update] 🧹 Snapshot supprimé de force (sécurité)');
        } catch (delError: any) {
          console.error('[Update] ❌ CRITIQUE: Impossible de supprimer le snapshot:', delError.message);
          console.error('[Update] 🚨 ALERTE: Un snapshot non supprimé peut causer des problèmes de sécurité!');
        }
        
        return {
          success: false,
          message: `Erreur: ${error.message}. Échec du rollback: ${rollbackError.message}.`
        };
      }
    } else {
      console.error('[Update] ❌ Aucun snapshot disponible pour le rollback');
      console.error(`[Update] 📸 snapshotPath: ${snapshotPath}`);
    }
    
    // Nettoyer le dossier de l'app en cas d'échec seulement si pas de snapshot
    if (appDir && !snapshotPath) {
      console.log(`[Update] 🧹 Nettoyage du dossier ${appDir}...`);
      try {
        execSync(`sudo rm -rf "${appDir}"`, { stdio: 'inherit' });
        console.log(`[Update] ✅ Dossier ${appDir} supprimé`);
      } catch (cleanupError: any) {
        console.warn(`[Update] ⚠️ Impossible de supprimer ${appDir}:`, cleanupError.message);
      }
    }
    
    return {
      success: false,
      message: `Erreur lors de l'installation: ${error.message}`
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
  } catch (error: any) {
    console.error('[appStore] ⚠️  Échec de l\'initialisation:', error.message);
    // Continuer même en cas d'erreur (utiliser le cache local si disponible)
  }
}

// Exports pour être utilisés par updateCheckService et updateService
/**
 * Nettoyage complet et immédiat d'une installation annulée
 * - Pour une NOUVELLE INSTALLATION : Supprime tout
 * - Pour une MISE À JOUR : Fait un rollback vers le snapshot
 */
async function forceCleanupCancelledInstall(appId) {
  try {
    console.log(`[ForceCleanup] 🛑 Nettoyage de l'installation annulée de ${appId}...`);
    
    const APPS_DIR = '/data/apps';
    const MANIFESTS_DIR = '/data/config/manifests';
    const appDir = path.join(APPS_DIR, appId);
    const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
    
    // Vérifier si c'est une mise à jour (manifest existant) ou une nouvelle installation
    let isUpdate = false;
    try {
      await fs.access(manifestPath);
      isUpdate = true;
      console.log(`[ForceCleanup] ℹ️ Manifest existant détecté → C'est une MISE À JOUR annulée`);
    } catch {
      console.log(`[ForceCleanup] ℹ️ Aucun manifest → C'est une NOUVELLE INSTALLATION annulée`);
    }
    
    // 1. TUER IMMÉDIATEMENT tous les processus Docker liés à cette app
    console.log(`[ForceCleanup] ⚡ Arrêt forcé de tous les processus Docker pour ${appId}...`);
    try {
      // Tuer tous les processus docker pull/compose pour cette app
      execSync(`pkill -9 -f "docker.*${appId}" 2>/dev/null || true`, { stdio: 'inherit' });
      execSync(`pkill -9 -f "docker.*compose.*${appId}" 2>/dev/null || true`, { stdio: 'inherit' });
      execSync(`pkill -9 -f "docker.*pull.*${appId}" 2>/dev/null || true`, { stdio: 'inherit' });
    } catch (e) {
      // Ignore les erreurs
    }
    
    // 2. Si c'est une MISE À JOUR annulée, chercher et restaurer le snapshot
    if (isUpdate) {
      console.log(`[ForceCleanup] 🔄 MISE À JOUR annulée → Recherche du snapshot pour rollback...`);
      
      // Chercher le snapshot le plus récent pour cette app
      try {
        const snapshotsOutput = execSync(`ls -t /data/snapshots/${appId}-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
        
        if (snapshotsOutput) {
          const snapshotPath = snapshotsOutput;
          console.log(`[ForceCleanup] 📸 Snapshot trouvé: ${snapshotPath}`);
          console.log(`[ForceCleanup] 🔄 Rollback en cours vers l'ancienne version...`);
          
          try {
            // Arrêter les containers avant le rollback
            execSync(`docker compose down 2>/dev/null || true`, { cwd: appDir, stdio: 'inherit' });
            
            // Exécuter le rollback
            const rollbackOutput = execSync(`sudo /opt/Ryvie/scripts/rollback-app.sh "${snapshotPath}" "${appDir}"`, { 
              encoding: 'utf8',
              stdio: 'pipe'
            });
            console.log(`[ForceCleanup] ✅ Rollback terminé`);
            console.log(rollbackOutput);
            
            // Redémarrer les containers avec l'ancienne version
            console.log(`[ForceCleanup] 🚀 Redémarrage des containers avec l'ancienne version...`);
            execSync(`docker compose up -d 2>/dev/null || true`, { cwd: appDir, stdio: 'inherit' });
            
            // Supprimer le snapshot après rollback réussi
            try {
              execSync(`sudo btrfs subvolume delete "${snapshotPath}"`, { stdio: 'inherit' });
              console.log(`[ForceCleanup] 🧹 Snapshot supprimé`);
            } catch (delError: any) {
              console.warn(`[ForceCleanup] ⚠️ Impossible de supprimer le snapshot:`, delError.message);
            }
            
            console.log(`[ForceCleanup] ✅ Mise à jour annulée, ancienne version restaurée`);
            return {
              success: true,
              message: `Mise à jour annulée, ancienne version de ${appId} restaurée`,
              isUpdate: true
            };
          } catch (rollbackError: any) {
            console.error(`[ForceCleanup] ❌ Erreur lors du rollback:`, rollbackError.message);
            // Continuer avec le nettoyage normal en cas d'échec du rollback
          }
        } else {
          console.warn(`[ForceCleanup] ⚠️ Aucun snapshot trouvé pour ${appId}, nettoyage normal`);
        }
      } catch (snapshotError: any) {
        console.warn(`[ForceCleanup] ⚠️ Erreur lors de la recherche du snapshot:`, snapshotError.message);
      }
    }
    
    // 3. Pour une NOUVELLE INSTALLATION ou si le rollback a échoué : Nettoyage complet
    console.log(`[ForceCleanup] 🗑️ Nettoyage complet de ${appId}...`);
    
    // Arrêter tous les containers Docker (par nom de projet)
    console.log(`[ForceCleanup] 🐳 Arrêt des containers Docker...`);
    try {
      execSync(`docker compose -p ${appId} down -v --remove-orphans 2>/dev/null || true`, { stdio: 'inherit' });
    } catch (e) {
      // Ignore
    }
    
    // Si le dossier existe avec un docker-compose.yml, arrêter aussi via le dossier
    try {
      const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'];
      for (const file of composeFiles) {
        const composePath = path.join(appDir, file);
        try {
          await fs.access(composePath);
          console.log(`[ForceCleanup] 📄 Arrêt via ${file}...`);
          execSync(`cd "${appDir}" && docker compose down -v --remove-orphans 2>/dev/null || true`, { stdio: 'inherit' });
          break;
        } catch {}
      }
    } catch (e) {
      // Ignore
    }
    
    // Supprimer tous les volumes Docker liés à cette app
    console.log(`[ForceCleanup] 🗑️ Suppression des volumes Docker...`);
    try {
      const volumesOutput = execSync(`docker volume ls -q --filter "name=${appId}"`, { encoding: 'utf8' }).trim();
      if (volumesOutput) {
        const volumes = volumesOutput.split('\n').filter(vol => vol.trim());
        for (const volume of volumes) {
          try {
            execSync(`docker volume rm ${volume} 2>/dev/null || true`, { stdio: 'inherit' });
          } catch {}
        }
      }
    } catch (e) {
      // Ignore
    }
    
    // Supprimer le dossier de l'application
    console.log(`[ForceCleanup] 🗑️ Suppression du dossier ${appDir}...`);
    try {
      execSync(`sudo rm -rf "${appDir}" 2>/dev/null || true`, { stdio: 'inherit' });
    } catch (e) {
      // Ignore
    }
    
    // Supprimer le manifest
    const manifestDir = path.join(MANIFESTS_DIR, appId);
    console.log(`[ForceCleanup] 🗑️ Suppression du manifest ${manifestDir}...`);
    try {
      execSync(`sudo rm -rf "${manifestDir}" 2>/dev/null || true`, { stdio: 'inherit' });
    } catch (e) {
      // Ignore
    }
    
    // 7. Supprimer l'entrée dans apps-versions.json
    console.log(`[ForceCleanup] 🔄 Nettoyage de apps-versions.json...`);
    try {
      let installedVersions = {};
      try {
        const raw = await fs.readFile(APPS_VERSIONS_FILE, 'utf8');
        installedVersions = JSON.parse(raw);
      } catch {}
      
      if (installedVersions[appId]) {
        delete installedVersions[appId];
        await fs.writeFile(APPS_VERSIONS_FILE, JSON.stringify(installedVersions, null, 2));
      }
    } catch (e) {
      // Ignore
    }
    
    // 8. Régénérer les manifests
    console.log(`[ForceCleanup] 🔄 Régénération des manifests...`);
    try {
      const manifestScript = path.join(RYVIE_DIR, 'generate-manifests.js');
      execSync(`node ${manifestScript}`, { stdio: 'inherit' });
    } catch (e) {
      // Ignore
    }
    
    // 9. Actualiser le catalogue
    console.log(`[ForceCleanup] 🔄 Actualisation du catalogue...`);
    try {
      const localApps = await loadAppsFromFile();
      if (Array.isArray(localApps)) {
        const { apps: enrichedApps } = await enrichAppsWithInstalledVersions(localApps);
        await saveAppsToFile(enrichedApps);
      }
    } catch (e) {
      // Ignore
    }
    
    // 10. Diffuser les nouveaux statuts via Socket.IO
    try {
      const dockerService = require('./dockerService');
      if (dockerService.clearAppStatusCache) {
        dockerService.clearAppStatusCache();
      }
      
      const io = (global as any).io;
      if (io) {
        const apps = await dockerService.getAppStatus();
        io.emit('apps-status-update', apps);
        io.emit('appsStatusUpdate', apps);
      }
    } catch (e) {
      // Ignore
    }
    
    console.log(`[ForceCleanup] ✅ Nettoyage complet de ${appId} terminé`);
    
    return {
      success: true,
      message: `Installation de ${appId} annulée et nettoyée complètement`
    };
    
  } catch (error: any) {
    console.error(`[ForceCleanup] ❌ Erreur lors du nettoyage de ${appId}:`, error.message);
    return {
      success: false,
      message: `Erreur lors du nettoyage: ${error.message}`
    };
  }
}

/**
 * Désinstalle proprement une application
 */
async function uninstallApp(appId) {
  try {
    console.log(`[Uninstall] Début de la désinstallation de ${appId}...`);
    
    // 1. Lire le manifest pour obtenir le sourceDir
    const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
    let appDir = null;
    
    let manifest: any = null;
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      manifest = JSON.parse(manifestContent);
      appDir = manifest.sourceDir;
      console.log(`[Uninstall] Dossier de l'app depuis le manifest: ${appDir}`);
    } catch (manifestError: any) {
      console.warn(`[Uninstall] ⚠️ Impossible de lire le manifest de ${appId}:`, manifestError.message);
      return {
        success: false,
        message: `L'application ${appId} n'est pas installée ou le manifest est introuvable`
      };
    }
    
    // 2. Vérifier que le dossier existe
    try {
      await fs.access(appDir);
      console.log(`[Uninstall] Dossier de l'app vérifié: ${appDir}`);
    } catch {
      console.warn(`[Uninstall] ⚠️ Dossier ${appDir} introuvable`);
      return {
        success: false,
        message: `Le dossier de l'application ${appId} n'existe pas: ${appDir}`
      };
    }
    
    // 2b. Déterminer le fichier docker-compose à utiliser
    // Priorité : dockerComposePath du manifest > labels Docker > recherche à la racine
    console.log('[Uninstall] 🔍 Récupération des images Docker de l\'application...');
    let appImages = [];
    let composeFile = null;
    let composeDir = null;
    
    // Essayer d'abord le dockerComposePath du manifest
    if (manifest?.dockerComposePath) {
      const fullComposePath = path.join(appDir, manifest.dockerComposePath);
      try {
        await fs.access(fullComposePath);
        composeFile = path.basename(fullComposePath);
        composeDir = path.dirname(fullComposePath);
        console.log(`[Uninstall] ✅ docker-compose depuis le manifest: ${manifest.dockerComposePath}`);
      } catch {
        console.warn(`[Uninstall] ⚠️ dockerComposePath du manifest introuvable: ${fullComposePath}`);
      }
    }
    
    // Fallback : chercher via les labels Docker du conteneur
    if (!composeFile) {
      try {
        const containerName = execSync(
          `docker ps -a --filter "name=app-${appId}" --format "{{.Names}}" | head -1`,
          { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
        ).trim();
        if (containerName) {
          const configFiles = execSync(
            `docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "${containerName}"`,
            { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
          ).trim();
          if (configFiles && configFiles !== '<no value>') {
            try {
              await fs.access(configFiles);
              composeFile = path.basename(configFiles);
              composeDir = path.dirname(configFiles);
              console.log(`[Uninstall] ✅ docker-compose depuis les labels Docker: ${configFiles}`);
            } catch {}
          }
        }
      } catch {}
    }
    
    // Fallback final : chercher à la racine de appDir
    if (!composeFile) {
      const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'];
      for (const file of composeFiles) {
        try {
          await fs.access(path.join(appDir, file));
          composeFile = file;
          composeDir = appDir;
          break;
        } catch {}
      }
    }
    
    if (composeFile) {
      try {
        // Récupérer les images utilisées par l'app
        const imagesOutput = execSync(`docker compose -f ${composeFile} images -q`, { 
          cwd: composeDir, 
          encoding: 'utf8'
        }).trim();
        
        if (imagesOutput) {
          appImages = imagesOutput.split('\n').filter(img => img.trim());
          console.log(`[Uninstall] 📦 ${appImages.length} image(s) trouvée(s):`, appImages);
        }
      } catch (imagesError: any) {
        console.warn('[Uninstall] ⚠️ Impossible de récupérer les images:', imagesError.message);
      }
      
      // 3. Arrêter et supprimer les containers avec docker compose down
      console.log('[Uninstall] 🛑 Arrêt et suppression des containers...');
      try {
        execSync(`docker compose -f ${composeFile} down -v`, { 
          cwd: composeDir, 
          stdio: 'inherit'
        });
        console.log('[Uninstall] ✅ Containers et volumes arrêtés et supprimés');
      } catch (dockerError: any) {
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
          console.log(`[Uninstall]   ${volumes.length} volume(s) trouvé(s):`, volumes);
          
          for (const volume of volumes) {
            try {
              execSync(`docker volume rm ${volume}`, { stdio: 'inherit' });
              console.log(`[Uninstall] ✅ Volume ${volume} supprimé`);
            } catch (volError: any) {
              console.warn(`[Uninstall] ⚠️ Impossible de supprimer le volume ${volume}:`, volError.message);
            }
          }
        } else {
          console.log('[Uninstall] ℹ️ Aucun volume spécifique trouvé');
        }
      } catch (volumeError: any) {
        console.warn('[Uninstall] ⚠️ Erreur lors de la récupération des volumes:', volumeError.message);
      }
      
      // 5. Supprimer les images Docker de l'application
      if (appImages.length > 0) {
        console.log('[Uninstall] 🗑️ Suppression des images Docker...');
        for (const imageId of appImages) {
          try {
            execSync(`docker rmi ${imageId}`, { stdio: 'inherit' });
            console.log(`[Uninstall] ✅ Image ${imageId} supprimée`);
          } catch (rmiError: any) {
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
    } catch (rmError: any) {
      console.error('[Uninstall] ❌ Erreur lors de la suppression du dossier:', rmError.message);
      throw new Error(`Impossible de supprimer le dossier de l'application: ${rmError.message}`);
    }
    
    // 5c. Supprimer le client SSO si l'app en avait un (AVANT suppression du manifest)
    try {
      const keycloakService = require('./keycloakService');
      if (keycloakService.removeAppSSOClient) {
        keycloakService.removeAppSSOClient(appId);
      }
    } catch (ssoError: any) {
      console.warn(`[Uninstall] ⚠️ Erreur lors de la suppression du client SSO pour ${appId}:`, ssoError.message);
      // Non bloquant
    }
    
    // 6. Supprimer le manifest
    const manifestDir = path.join(MANIFESTS_DIR, appId);
    console.log(`[Uninstall] 📄 Suppression du manifest ${manifestDir}...`);
    try {
      execSync(`sudo rm -rf "${manifestDir}"`, { stdio: 'inherit' });
      console.log('[Uninstall] ✅ Manifest supprimé');
    } catch (manifestError: any) {
      console.warn('[Uninstall] ⚠️ Erreur lors de la suppression du manifest:', manifestError.message);
      // Non bloquant
    }
    
    // 7. Régénérer les manifests pour mettre à jour la liste
    console.log('[Uninstall] 🔄 Régénération des manifests...');
    try {
      const manifestScript = path.join(RYVIE_DIR, 'generate-manifests.js');
      execSync(`node ${manifestScript}`, { stdio: 'inherit' });
      console.log('[Uninstall] ✅ Manifests régénérés');
    } catch (manifestError: any) {
      console.warn('[Uninstall] ⚠️ Impossible de régénérer les manifests:', manifestError.message);
    }
    
    // 8. Supprimer l'entrée dans apps-versions.json
    console.log('[Uninstall] 🔄 Mise à jour de apps-versions.json...');
    try {
      let installedVersions = {};
      try {
        const raw = await fs.readFile(APPS_VERSIONS_FILE, 'utf8');
        installedVersions = JSON.parse(raw);
      } catch (readError: any) {
        console.log('[Uninstall] apps-versions.json introuvable ou vide');
      }
      
      // Supprimer l'entrée de l'app
      if (installedVersions[appId]) {
        delete installedVersions[appId];
        await fs.writeFile(APPS_VERSIONS_FILE, JSON.stringify(installedVersions, null, 2));
        console.log('[Uninstall] ✅ apps-versions.json mis à jour');
      }
    } catch (versionError: any) {
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
    } catch (catalogError: any) {
      console.warn('[Uninstall] ⚠️ Impossible d\'actualiser le catalogue:', catalogError.message);
    }
    
    console.log(`[Uninstall] ✅ ${appId} désinstallé avec succès`);
    
    // Invalider le cache et diffuser les nouveaux statuts via Socket.IO
    try {
      const dockerService = require('./dockerService');
      if (dockerService.clearAppStatusCache) {
        dockerService.clearAppStatusCache();
      }
      
      const io = (global as any).io;
      if (io) {
        const apps = await dockerService.getAppStatus();
        io.emit('apps-status-update', apps);
        io.emit('appsStatusUpdate', apps);
        console.log('[Uninstall] 📡 Statuts diffusés via Socket.IO');
      }
    } catch (e: any) {
      console.warn('[Uninstall] ⚠️ Impossible de diffuser les statuts:', e.message);
    }
    
    // Envoyer un message au processus principal pour émettre la notification Socket.IO
    // MAINTENANT que tout est désinstallé (containers, images, manifest, catalogue)
    if (process.send) {
      console.log('[Uninstall] 📤 Envoi du message au processus principal pour émettre la notification...');
      process.send({ type: 'emit-uninstalled', appId: appId });
      console.log('[Uninstall] ✅ Message envoyé');
    } else {
      console.warn('[Uninstall] ⚠️ process.send non disponible');
    }
    
    // Attendre 5 secondes pour que le frontend reçoive la notification et mette à jour le layout
    console.log('[Uninstall] ⏳ Attente de 5 secondes pour la notification frontend...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 10. Réconciliation du layout pour nettoyer l'icône désinstallée
    console.log('[Uninstall] 🔄 Réconciliation du layout utilisateur...');
    try {
      const userPreferencesRouter = require('../routes/userPreferences');
      if (userPreferencesRouter.reconcileAllUsersLayout) {
        await userPreferencesRouter.reconcileAllUsersLayout();
        console.log('[Uninstall] ✅ Réconciliation du layout effectuée');
      } else {
        console.warn('[Uninstall] ⚠️ Fonction reconcileAllUsersLayout non disponible');
      }
    } catch (reconcileError: any) {
      console.warn('[Uninstall] ⚠️ Erreur lors de la réconciliation:', reconcileError.message);
    }
    


    
    // 11. Nettoyer la configuration Caddy en dernier (après notification frontend)
    console.log('[Uninstall] 🔍 Nettoyage de la configuration proxy...');
    try {
      const reverseProxyService = require('./reverseProxyService');
      
      // Régénérer le Caddyfile sans l'app désinstallée
      console.log('[Uninstall] 🔧 Mise à jour du Caddyfile...');
      const caddyfileContent = await reverseProxyService.generateFullCaddyfileContent();
      const caddyfilePath = '/data/config/reverse-proxy/Caddyfile';
      await fs.writeFile(caddyfilePath, caddyfileContent);
      console.log('[Uninstall] ✅ Caddyfile mis à jour');
      
      // Régénérer le docker-compose.yml de Caddy sans les ports de l'app
      console.log('[Uninstall] 🔧 Mise à jour docker-compose.yml de Caddy...');
      const composeContent = await reverseProxyService.generateCaddyDockerCompose();
      const composePath = '/data/config/reverse-proxy/docker-compose.yml';
      
      // Vérifier si les ports ont changé
      let needsRecreate = false;
      try {
        const currentCompose = await fs.readFile(composePath, 'utf8');
        if (currentCompose !== composeContent) {
          console.log('[Uninstall] 📝 Ports Caddy modifiés, recréation nécessaire');
          needsRecreate = true;
        }
      } catch (e) {
        needsRecreate = true;
      }
      
      await fs.writeFile(composePath, composeContent);
      console.log('[Uninstall] ✅ docker-compose.yml de Caddy mis à jour');
      
      // Recharger ou recréer Caddy selon les changements
      if (needsRecreate) {
        console.log('[Uninstall] 🔄 Recréation de Caddy avec les nouveaux ports...');
        try {
          execSync('docker compose down', { cwd: '/data/config/reverse-proxy', stdio: 'pipe' });
          execSync('docker compose up -d', { cwd: '/data/config/reverse-proxy', stdio: 'pipe' });
          console.log('[Uninstall] ✅ Caddy recréé avec succès');
        } catch (caddyError: any) {
          console.warn('[Uninstall] ⚠️ Échec de la recréation de Caddy:', caddyError.message);
        }
      } else {
        console.log('[Uninstall] 🔄 Rechargement gracieux de Caddy...');
        try {
          const reloadResult = await reverseProxyService.reloadCaddy();
          if (reloadResult.success) {
            console.log('[Uninstall] ✅ Configuration Caddy rechargée sans interruption');
          }
        } catch (reloadError: any) {
          console.warn('[Uninstall] ⚠️ Échec du rechargement de Caddy:', reloadError.message);
        }
      }
    } catch (proxyError: any) {
      console.warn('[Uninstall] ⚠️ Erreur lors du nettoyage du reverse proxy:', proxyError.message);
      // Non bloquant - on continue la désinstallation
    }
    
    return {
      success: true,
      message: `${appId} a été désinstallé avec succès`
    };
    
  } catch (error: any) {
    console.error(`[Uninstall] ❌ Erreur lors de la désinstallation de ${appId}:`, error.message);
    return {
      success: false,
      message: `Erreur lors de la désinstallation: ${error.message}`
    };
  }
}

export = {
  initialize,
  getApps,
  getAppById,
  clearCache,
  getStoreHealth,
  getRateLimitInfo,
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
  forceCleanupCancelledInstall,
  // Export pour les mises à jour de progression
  progressEmitter
};
