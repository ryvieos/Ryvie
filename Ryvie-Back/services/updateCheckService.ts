const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { APPS_DIR, RYVIE_DIR } = require('../config/paths');
const { detectMode } = require('../utils/detectMode');
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
 * Fallback: si aucune release sur la branche, retourne la dernière release remote.
 */
async function getLatestGitHubReleaseForBranch(owner, repo, branch) {
  try {
    const headers = {};
    if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    headers['Accept'] = 'application/vnd.github+json';

    // Récupérer la dernière release
    const resp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=1`, // page=1 à modif si on applique des release egalement à la branche dev
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
 * Récupère la version actuelle de Ryvie depuis package.json
 */
function getCurrentRyvieVersion() {
  try {
    const packageJsonPath = path.join(RYVIE_DIR, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const version = packageJson.version || null;
    // Ajouter le préfixe 'v' si absent pour cohérence avec les tags GitHub
    return version ? (version.startsWith('v') ? version : `v${version}`) : null;
  } catch (error: any) {
    console.log('[updateCheck] Impossible de lire la version depuis package.json');
    return null;
  }
}

// Compare deux versions (supporte v0.0.1 et 0.0.1, ainsi que les pré-versions)
function compareVersions(current, latest) {
  if (!current || !latest) return null;
  
  // Normaliser les versions (enlever le 'v' au début)
  const cleanCurrent = current.replace(/^v/, '');
  const cleanLatest = latest.replace(/^v/, '');
  
  if (cleanCurrent === cleanLatest) return 'up-to-date';
  
  // Extraire les parties de version principales et les pré-versions
  const parseVersion = (version) => {
    // Séparer la version principale de la pré-version
    const mainMatch = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!mainMatch) return { major: 0, minor: 0, patch: 0, prerelease: '' };
    
    const prerelease = version.substring(mainMatch[0].length);
    return {
      major: parseInt(mainMatch[1]),
      minor: parseInt(mainMatch[2]),
      patch: parseInt(mainMatch[3]),
      prerelease: prerelease.replace(/^[_-]/, '') // Enlever le premier _ ou -
    };
  };
  
  const curr = parseVersion(cleanCurrent);
  const lat = parseVersion(cleanLatest);
  
  // Comparer les versions principales d'abord
  if (lat.major > curr.major) return 'update-available';
  if (lat.major < curr.major) return 'ahead';
  
  if (lat.minor > curr.minor) return 'update-available';
  if (lat.minor < curr.minor) return 'ahead';
  
  if (lat.patch > curr.patch) return 'update-available';
  if (lat.patch < curr.patch) return 'ahead';
  
  // Si les versions principales sont identiques, comparer les pré-versions
  // Une version sans pré-version est plus récente qu'une version avec pré-version
  if (!curr.prerelease && lat.prerelease) return 'update-available';
  if (curr.prerelease && !lat.prerelease) return 'ahead';
  
  // Si les deux ont des pré-versions, les comparer
  if (curr.prerelease && lat.prerelease) {
    // Gérer les pré-versions numériques (ex: dev.4, dev.2)
    const currPreMatch = curr.prerelease.match(/(\d+)$/);
    const latPreMatch = lat.prerelease.match(/(\d+)$/);
    
    if (currPreMatch && latPreMatch) {
      const currPreNum = parseInt(currPreMatch[1]);
      const latPreNum = parseInt(latPreMatch[1]);
      
      if (latPreNum > currPreNum) return 'update-available';
      if (latPreNum < currPreNum) return 'ahead';
    }
    
    // Comparaison lexicographique en dernier recours
    if (lat.prerelease > curr.prerelease) return 'update-available';
    if (lat.prerelease < curr.prerelease) return 'ahead';
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
  } catch (error: any) {
    console.error('[updateCheck] Erreur lors de la récupération du tag distant:', error.message);
    return null;
  }
}

/**
 * Récupère le dernier tag du catalogue App Store via ls-remote (sans API REST)
 * En dev: récupère le dernier tag de pré-release
 * En prod: récupère le dernier tag stable
 */
function getLatestCatalogTag() {
  try {
    // 1. Détecter le mode actuel (dev ou prod)
    const mode = detectMode();
    console.log(`[updateCheck] Mode détecté: ${mode}`);
    
    const repoUrl = 'https://github.com/ryvieos/Ryvie-Apps.git';
    console.log('[updateCheck] Récupération des tags du catalogue via ls-remote...');
    
    const out = execSync(`git ls-remote --tags --refs ${repoUrl}`, { encoding: 'utf8' });
    const tags = out
      .split('\n')
      .map(l => (l.split('\t')[1] || '').replace('refs/tags/', '').trim())
      .filter(Boolean);
    
    if (tags.length === 0) {
      console.log('[updateCheck] Aucun tag trouvé pour le catalogue');
      return null;
    }
    
    console.log(`[updateCheck] ${tags.length} tags trouvés`);
    
    // 2. Filtrer selon le mode
    let targetTags;
    if (mode === 'dev') {
      // En dev: chercher les tags de pré-release (contenant 'dev' ou se terminant par un suffixe de pré-release)
      targetTags = tags.filter(t => 
        /-dev\.?\d*|alpha|beta|rc/.test(t) || 
        t.toLowerCase().includes('dev')
      );
      console.log(`[updateCheck] Mode dev: recherche de pré-release (${targetTags.length} trouvées)`);
    } else {
      // En prod: chercher les tags stables (version SemVer standard)
      targetTags = tags.filter(t => 
        /^v?\d+\.\d+\.\d+$/.test(t) && 
        !/-dev|alpha|beta|rc/.test(t)
      );
      console.log(`[updateCheck] Mode prod: recherche de release stable (${targetTags.length} trouvées)`);
    }
    
    // 3. Fallback si rien trouvé
    if (targetTags.length === 0) {
      if (mode === 'dev') {
        console.log(`[updateCheck] Aucun tag de pré-release trouvé en dev, retourne null`);
        return null;
      } else {
        console.log(`[updateCheck] Aucun tag stable trouvé en prod, retourne null`);
        return null;
      }
    }
    
    // 4. Trier les tags valides avec compareVersions
    const sorted = targetTags.sort((a, b) => {
      const res = compareVersions(a, b);
      if (res === null) return 0;
      if (res === 'update-available') return -1; // b > a => a avant b
      if (res === 'ahead') return 1; // b < a => a après b
      return 0;
    });
    
    const latestTag = sorted[sorted.length - 1] || null;
    console.log(`[updateCheck] Dernier tag du catalogue (${mode}): ${latestTag}`);
    
    // Log pour indiquer la branche qui serait utilisée
    const branchForMode = mode === 'dev' ? 'dev' : 'main';
    console.log(`[updateCheck] Branche utilisée pour le mode ${mode}: ${branchForMode}`);
    
    return latestTag;
  } catch (error: any) {
    console.error('[updateCheck] Erreur lors de la récupération du tag du catalogue:', error.message);
    return null;
  }
}

/**
 * Récupère le dernier tag d'un repo GitHub via git ls-remote (sans API, sans token)
 * mode = 'prod' : tags stables (sans "dev"), ex: v0.1.0-alpha
 * mode = 'dev'  : tags prerelease (avec "dev"), ex: v0.1.0-alpha-dev.4
 */
function getLatestGitHubTagViaGit(owner, repo, mode) {
  try {
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const out = execSync(`git ls-remote --tags --refs ${repoUrl}`, { encoding: 'utf8', timeout: 15000 });
    const tags = out
      .split('\n')
      .map(l => (l.split('\t')[1] || '').replace('refs/tags/', '').trim())
      .filter(Boolean);

    if (tags.length === 0) {
      console.log(`[updateCheck] Aucun tag trouvé pour ${owner}/${repo}`);
      return null;
    }

    // Filtrer selon le mode: "dev" dans le tag = prerelease, sinon = stable
    const filtered = mode === 'dev'
      ? tags.filter(t => /dev/.test(t))
      : tags.filter(t => !/dev/.test(t));

    if (filtered.length === 0) {
      console.log(`[updateCheck] Aucun tag ${mode === 'dev' ? 'prerelease' : 'stable'} trouvé pour ${owner}/${repo}`);
      return null;
    }

    // Trier avec compareVersions pour trouver le plus récent
    const sorted = filtered.sort((a, b) => {
      const res = compareVersions(a, b);
      if (res === null) return 0;
      if (res === 'update-available') return -1;
      if (res === 'ahead') return 1;
      return 0;
    });

    const latest = sorted[sorted.length - 1] || null;
    console.log(`[updateCheck] Dernier tag ${mode} pour ${owner}/${repo}: ${latest}`);
    return latest;
  } catch (error: any) {
    console.error(`[updateCheck] Erreur ls-remote pour ${owner}/${repo}:`, error.message);
    return null;
  }
}

/**
 * Vérifie les mises à jour pour Ryvie
 */
async function checkRyvieUpdate() {
  const currentBranch = getCurrentBranch(RYVIE_DIR);

  // Détecter le mode (dev ou prod)
  const mode = detectMode();

  // Version locale: source de vérité = package.json
  const currentVersion = getCurrentRyvieVersion();

  // Version distante: dernier tag via git ls-remote (sans API, sans token)
  const latestVersion = getLatestGitHubTagViaGit('ryvieos', 'Ryvie', mode);

  const status = compareVersions(currentVersion, latestVersion);
  
  return {
    name: 'Ryvie',
    repo: 'ryvieos/Ryvie',
    branch: currentBranch,
    currentVersion,
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
    
    // Parser le manifest
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
    // Pas de tag Git
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
    // Utiliser ls-remote au lieu de l'API REST GitHub
    const latestTag = getLatestCatalogTag();
    
    if (!latestTag) {
      console.log('[updateCheck] Impossible de récupérer le dernier tag du catalogue');
      return {
        name: 'App Store Catalog',
        repo: process.env.GITHUB_REPO || 'ryvieos/Ryvie-Apps',
        currentVersion: null,
        latestVersion: null,
        updateAvailable: false,
        status: 'error',
        error: 'Impossible de récupérer les tags du catalogue'
      };
    }
    
    // Charger les métadonnées locales
    const localMetadata = await appStoreService.loadMetadata();
    
    const currentTag = localMetadata.releaseTag;
    
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
  checkStoreCatalogUpdate,
  getLatestGitHubTagViaGit
};

