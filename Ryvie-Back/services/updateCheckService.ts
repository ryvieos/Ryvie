const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { APPS_DIR, RYVIE_DIR } = require('../config/paths');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * Récupère le dernier tag (tous branches) d'un repo GitHub
 */
async function getLatestGitHubTag(owner, repo) {
  try {
    const headers = {};
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }
    headers['Accept'] = 'application/vnd.github+json';

    const response = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/tags`,
      { headers, timeout: 10000 }
    );

    if (response.data && response.data.length > 0) {
      return response.data[0].name; // Le premier tag est le plus récent
    }
    return null;
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log(`[updateCheck] Repo ${owner}/${repo} non trouvé ou pas de releases`);
      return null;
    }
    console.error(`[updateCheck] Erreur lors de la récupération du tag pour ${owner}/${repo}:`, error.message);
    return null;
  }
}

/**
 * Récupère la branche Git courante d'un répertoire local
 */
function getCurrentBranch(dir) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir,
      encoding: 'utf8'
    }).trim();
    return branch;
  } catch (e: any) {
    console.log(`[updateCheck] Impossible de déterminer la branche pour ${dir}`);
    return 'main';
  }
}

/**
 * Récupère la dernière release GitHub pour une branche donnée via target_commitish.
 * Fallback: si aucune release sur la branche, retourne la dernière release publique.
 */
async function getLatestGitHubReleaseForBranch(owner, repo, branch) {
  try {
    const headers = {};
    if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    headers['Accept'] = 'application/vnd.github+json';

    // Récupérer les releases (paginer jusqu'à 100 suffisant pour la plupart des cas)
    const resp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
      { headers, timeout: 10000 }
    );

    const releases = Array.isArray(resp.data) ? resp.data : [];
    // Filtrer par branche cible (target_commitish peut être 'main', 'master' ou autre)
    const branchReleases = releases.filter(r => (r?.target_commitish || '').toLowerCase() === (branch || '').toLowerCase());
    const latestOnBranch = branchReleases.find(r => !r.prerelease); // privilégier non-prerelease
    const latest = latestOnBranch || releases.find(r => !r.prerelease) || releases[0];

    if (!latest) return null;
    return latest.tag_name || latest.name || null;
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log(`[updateCheck] Releases introuvables pour ${owner}/${repo}`);
      return null;
    }
    console.error(`[updateCheck] Erreur releases ${owner}/${repo}:`, error.message);
    return null;
  }
}

/**
 * Récupère la version actuelle de Ryvie depuis Git
 */
function getCurrentRyvieVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      cwd: RYVIE_DIR,
      encoding: 'utf8'
    }).trim();
    return tag;
  } catch (error: any) {
    console.log('[updateCheck] Impossible de récupérer le tag Git actuel pour Ryvie');
    return null;
  }
}

/**
 * Compare deux versions (supporte v0.0.1 et 0.0.1)
 */
function compareVersions(current, latest) {
  if (!current || !latest) return null;
  
  // Normaliser les versions (enlever le 'v' au début)
  const cleanCurrent = current.replace(/^v/, '');
  const cleanLatest = latest.replace(/^v/, '');
  
  if (cleanCurrent === cleanLatest) return 'up-to-date';
  
  // Comparer les versions
  const currentParts = cleanCurrent.split('.').map(Number);
  const latestParts = cleanLatest.split('.').map(Number);
  
  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const curr = currentParts[i] || 0;
    const lat = latestParts[i] || 0;
    
    if (lat > curr) return 'update-available';
    if (lat < curr) return 'ahead';
  }
  
  return 'up-to-date';
}

/**
 * Récupère le dernier tag local (par version) atteint par HEAD dans un repo
 * Utilise --merged HEAD pour ne prendre que les tags accessibles depuis la branche courante
 */
function getLocalLatestTag(dir) {
  try {
    // git tag --merged HEAD --list 'v*' pour ne récupérer que les tags v* merged
    const out = execSync("git tag --merged HEAD --list 'v*'", { cwd: dir, encoding: 'utf8' });
    const tags = out.split('\n').map(t => t.trim()).filter(Boolean);
    if (tags.length === 0) return null;
    
    // Filtrer uniquement les tags SemVer valides (v0.0.1 ou 0.0.1, avec pré-release optionnel)
    const versionTags = tags.filter(t => /^v?\d+(\.\d+){1,3}(-[0-9A-Za-z.+-]+)?$/.test(t));
    if (versionTags.length === 0) return null;
    
    // Trier par version
    const sorted = versionTags.sort((a, b) => {
      const res = compareVersions(a, b);
      if (res === null) return 0;
      if (res === 'update-available') return -1; // b > a
      if (res === 'ahead') return 1; // b < a
      return 0;
    });
    return sorted[sorted.length - 1] || null;
  } catch (_: any) {
    return null;
  }
}

/**
 * Récupère le dernier tag distant (origin) en triant par version
 */
function getRemoteLatestTag(dir) {
  try {
    const out = execSync('git ls-remote --tags --refs origin', { cwd: dir, encoding: 'utf8' });
    const tags = out
      .split('\n')
      .map(l => (l.split('\t')[1] || '').replace('refs/tags/', '').trim())
      .filter(Boolean);
    if (tags.length === 0) return null;
    
    // Filtrer uniquement les tags SemVer valides (avec pré-release optionnel)
    const versionTags = tags.filter(t => /^v?\d+(\.\d+){1,3}(-[0-9A-Za-z.+-]+)?$/.test(t));
    if (versionTags.length === 0) return null;
    
    // Trier avec compareVersions
    const sorted = versionTags.sort((a, b) => {
      const res = compareVersions(a, b);
      if (res === null) return 0; // si invalide, ne change pas l'ordre
      // compareVersions renvoie 'update-available' si b > a (latest > current)
      if (res === 'update-available') return -1; // b > a => a avant b
      if (res === 'ahead') return 1; // b < a => a après b
      return 0;
    });
    return sorted[sorted.length - 1] || null;
  } catch (_: any) {
    return null;
  }
}

/**
 * Vérifie les mises à jour pour Ryvie (basé sur tags Git locaux/distants)
 */
async function checkRyvieUpdate() {
  const currentBranch = getCurrentBranch(RYVIE_DIR);
  
  // Fetch tags pour s'assurer d'avoir les derniers tags distants
  try {
    execSync('git fetch --tags origin', { cwd: RYVIE_DIR, stdio: 'pipe' });
  } catch (e: any) {
    console.log('[updateCheck] Impossible de fetch les tags pour Ryvie:', e.message);
  }
  
  const localTag = getLocalLatestTag(RYVIE_DIR);
  const remoteTag = getRemoteLatestTag(RYVIE_DIR);

  // Fallback GitHub API si pas de remote tag récupéré (ex: pas de remote, erreurs réseau)
  let latestVersion = remoteTag;
  if (!latestVersion) {
    const fromRelease = await getLatestGitHubReleaseForBranch('maisonnavejul', 'Ryvie', currentBranch);
    latestVersion = fromRelease || await getLatestGitHubTag('maisonnavejul', 'Ryvie');
  }

  const status = compareVersions(localTag, latestVersion);
  
  return {
    name: 'Ryvie',
    repo: 'maisonnavejul/Ryvie',
    branch: currentBranch,
    currentVersion: localTag,
    latestVersion,
    updateAvailable: status === 'update-available',
    status
  };
}

/**
 * Récupère les infos du manifest d'une app
 */
function getAppManifest(appDir) {
  try {
    const manifestPath = path.join(appDir, 'ryvie-app.yml');
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    
    const content = fs.readFileSync(manifestPath, 'utf8');
    const lines = content.split('\n');
    const manifest: any = {};
    
    for (const line of lines) {
      if (line.includes('repository:')) {
        manifest.repository = line.split('repository:')[1].trim().replace(/['"]/g, '');
      }
      if (line.includes('id:')) {
        manifest.id = line.split('id:')[1].trim().replace(/['"]/g, '');
      }
      if (line.includes('name:')) {
        manifest.name = line.split('name:')[1].trim().replace(/['"]/g, '');
      }
    }
    
    return manifest;
  } catch (error: any) {
    console.error(`[updateCheck] Erreur lors de la lecture du manifest dans ${appDir}:`, error.message);
    return null;
  }
}

/**
 * Récupère la version Git actuelle d'une app
 */
function getAppCurrentVersion(appDir) {
  try {
    const tag = execSync('git describe --tags --abbrev=0', {
      cwd: appDir,
      encoding: 'utf8'
    }).trim();
    return tag;
  } catch (error: any) {
    // Pas de tag Git, essayer de lire depuis le manifest ou autre
    return null;
  }
}

/**
 * Vérifie les mises à jour pour toutes les apps
 */
async function checkAppsUpdates() {
  const updates = [];
  
  if (!fs.existsSync(APPS_DIR)) {
    console.log('[updateCheck] Dossier /data/apps inexistant');
    return updates;
  }
  
  const apps = fs.readdirSync(APPS_DIR).filter(item => {
    const appPath = path.join(APPS_DIR, item);
    return fs.statSync(appPath).isDirectory();
  });
  
  for (const appFolder of apps) {
    const appPath = path.join(APPS_DIR, appFolder);
    const manifest = getAppManifest(appPath);
    
    if (!manifest || !manifest.repository) {
      console.log(`[updateCheck] Pas de repository pour ${appFolder}, skip`);
      continue;
    }
    
    // Extraire owner/repo depuis l'URL GitHub
    const repoMatch = manifest.repository.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (!repoMatch) {
      console.log(`[updateCheck] Format de repository invalide pour ${appFolder}: ${manifest.repository}`);
      continue;
    }
    
    const owner = repoMatch[1];
    const repo = repoMatch[2];
    
    // Fetch tags pour avoir les derniers tags
    try {
      execSync('git fetch --tags origin', { cwd: appPath, stdio: 'pipe' });
    } catch (e: any) {
      console.log(`[updateCheck] Impossible de fetch les tags pour ${appFolder}:`, e.message);
    }
    
    const currentVersion = getAppCurrentVersion(appPath);
    const appBranch = getCurrentBranch(appPath);
    const fromRelease = await getLatestGitHubReleaseForBranch(owner, repo, appBranch);
    const latestVersion = fromRelease || await getLatestGitHubTag(owner, repo);
    
    if (!latestVersion) {
      console.log(`[updateCheck] Pas de release pour ${appFolder}, skip`);
      continue;
    }
    
    const status = compareVersions(currentVersion, latestVersion);
    
    updates.push({
      name: manifest.name || appFolder,
      repo: `${owner}/${repo}`,
      branch: appBranch,
      currentVersion,
      latestVersion,
      updateAvailable: status === 'update-available',
      status
    });
  }
  
  return updates;
}

/**
 * Vérifie toutes les mises à jour (Ryvie + apps)
 */
async function checkAllUpdates() {
  const ryvieUpdate = await checkRyvieUpdate();
  const appsUpdates = await checkAppsUpdates();
  
  return {
    ryvie: ryvieUpdate,
    apps: appsUpdates,
    hasUpdates: ryvieUpdate.updateAvailable || appsUpdates.some(app => app.updateAvailable)
  };
}


/**
 * Vérifie les mises à jour du catalogue d'apps du store
 */
async function checkStoreCatalogUpdate() {
  const appStoreService = require('./appStoreService');
  
  try {
    console.log('[updateCheck] Vérification de nouvelle release du catalogue...');
    const latestRelease = await appStoreService.getLatestRelease();
    
    // Charger les métadonnées locales
    const localMetadata = await appStoreService.loadMetadata();
    
    const currentTag = localMetadata.releaseTag;
    const latestTag = latestRelease.tag;
    
    const updateAvailable = currentTag !== latestTag;
    
    if (updateAvailable) {
      console.log(`[updateCheck] Nouvelle release du catalogue détectée: ${currentTag || 'aucune'} → ${latestTag}`);
    } else {
      console.log(`[updateCheck] Catalogue déjà à jour (${latestTag})`);
    }
    
    return {
      name: 'App Store Catalog',
      repo: process.env.GITHUB_REPO || 'ryvieos/Ryvie-Apps',
      currentVersion: currentTag,
      latestVersion: latestTag,
      updateAvailable,
      status: updateAvailable ? 'update-available' : 'up-to-date'
    };
  } catch (error: any) {
    console.error('[updateCheck] Erreur lors de la vérification du catalogue:', error.message);
    return {
      name: 'App Store Catalog',
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      status: 'error',
      error: error.message
    };
  }
}


export = {
  checkAllUpdates,
  checkRyvieUpdate,
  checkAppsUpdates,
  checkStoreCatalogUpdate
};

