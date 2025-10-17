const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RYVIE_DIR = '/opt/Ryvie';
const APPS_DIR = '/data/apps';

/**
 * Récupère le dernier tag d'un repo GitHub
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
  } catch (error) {
    if (error.response?.status === 404) {
      console.log(`[updateCheck] Repo ${owner}/${repo} non trouvé ou pas de releases`);
      return null;
    }
    console.error(`[updateCheck] Erreur lors de la récupération du tag pour ${owner}/${repo}:`, error.message);
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
  } catch (error) {
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
 * Vérifie les mises à jour pour Ryvie
 */
async function checkRyvieUpdate() {
  const currentVersion = getCurrentRyvieVersion();
  const latestVersion = await getLatestGitHubTag('maisonnavejul', 'Ryvie');
  
  const status = compareVersions(currentVersion, latestVersion);
  
  return {
    name: 'Ryvie',
    repo: 'maisonnavejul/Ryvie',
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
    const manifest = {};
    
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
  } catch (error) {
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
  } catch (error) {
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
    
    const currentVersion = getAppCurrentVersion(appPath);
    const latestVersion = await getLatestGitHubTag(owner, repo);
    
    if (!latestVersion) {
      console.log(`[updateCheck] Pas de release pour ${appFolder}, skip`);
      continue;
    }
    
    const status = compareVersions(currentVersion, latestVersion);
    
    updates.push({
      name: manifest.name || appFolder,
      repo: `${owner}/${repo}`,
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

module.exports = {
  checkAllUpdates,
  checkRyvieUpdate,
  checkAppsUpdates
};
