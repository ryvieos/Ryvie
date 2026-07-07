const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { APPS_DIR, RYVIE_DIR } = require('../../config/paths');
const { detectMode } = require('../../utils/detectMode');
const { getLatestGitHubTagViaGit } = require('./updateCheckService');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TEMP_DIR = path.join(RYVIE_DIR, '.update-staging');

// Système d'événements pour les mises à jour de progression
const updateProgressEmitter = new EventEmitter();

// Fonction pour envoyer des mises à jour de progression
function sendUpdateProgress(appName, progress, message, stage = 'update') {
  const update = {
    appName,
    progress: Math.round(progress),
    message,
    stage,
    timestamp: new Date().toISOString()
  };
  
  console.log(`[UpdateProgress] ${appName}: ${progress}% - ${message}`);
  updateProgressEmitter.emit('progress', update);
}

/**
 * Récupère la version actuelle de Ryvie
 */
function getCurrentRyvieVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(RYVIE_DIR, 'package.json'), 'utf8'));
    return packageJson.version || 'unknown';
  } catch (error: any) {
    console.warn('[Update] Impossible de lire la version actuelle:', error.message);
    return 'unknown';
  }
}

/**
 * Télécharge un fichier depuis une URL
 */
async function downloadFile(url, destination) {
  const headers: any = {
    'User-Agent': 'Ryvie-Update-System'
  };
  
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  }
  
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    headers,
    timeout: 300000
  });
  
  const writer = fs.createWriteStream(destination);
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

/**
 * Calcule le SHA256 d'un fichier
 */
function calculateSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Vérifie l'intégrité d'un fichier téléchargé
 */
async function verifyFileIntegrity(filePath, expectedSHA256) {
  const actualSHA256 = await calculateSHA256(filePath);
  
  if (actualSHA256 !== expectedSHA256) {
    throw new Error(`Checksum mismatch: expected ${expectedSHA256}, got ${actualSHA256}`);
  }
  
  console.log('[Update] ✅ Checksum vérifié');
  return true;
}

/**
 * Met à jour Ryvie via GitHub releases
 */
async function updateRyvie() {
  try {
    console.log('[Update] Début de la mise à jour de Ryvie...');
    
    // 1. Détecter le mode (dev ou prod)
    const mode = detectMode();
    console.log(`[Update] Mode détecté: ${mode}`);
 
    // 2. Récupérer le dernier tag via git ls-remote (sans API, sans token)
    console.log('[Update] 📥 Récupération de la dernière version...');
    const targetVersion = getLatestGitHubTagViaGit('ryvieos', 'Ryvie', mode);
 
    if (!targetVersion) {
      throw new Error('Impossible de récupérer la dernière version depuis GitHub');
    }
    
    console.log(`[Update] Dernière version disponible: ${targetVersion}`);
    
    // 2. Vérifier si déjà à jour
    const currentVersion = getCurrentRyvieVersion();
    console.log(`[Update] Version actuelle: ${currentVersion}`);
    
    const isDevVersion = /dev/i.test(currentVersion || '');
    const modeMismatch = (mode === 'prod' && isDevVersion) || (mode === 'dev' && !isDevVersion);
 
    if (!modeMismatch && (currentVersion === targetVersion || `v${currentVersion}` === targetVersion)) {
      return {
        success: true,
        message: `Ryvie est déjà à jour (${currentVersion})`,
        needsRestart: false
      };
    }
    
    if (modeMismatch) {
      console.log(`[Update] Mode switch détecté: version=${currentVersion} (${isDevVersion ? 'dev' : 'prod'}) → mode=${mode}, target=${targetVersion}`);
    }
    
    // 4. Lancer le script externe en arrière-plan détaché
    const updateScript = path.join(RYVIE_DIR, 'scripts/update-and-restart.sh');
    
    if (!fs.existsSync(updateScript)) {
      throw new Error('Script update-and-restart.sh introuvable');
    }
    
    console.log(`[Update] 🚀 Lancement du script externe d'update...`);
    console.log(`[Update] Commande: ${updateScript} ${targetVersion} --mode ${mode}`);
    
    // Lancer en background détaché avec nohup
    // Le script gère: snapshot, download, extract, permissions, build, deploy, rollback si erreur
    execSync(
      `nohup "${updateScript}" "${targetVersion}" --mode ${mode} > /dev/null 2>&1 &`,
      { 
        cwd: RYVIE_DIR,
        detached: true,
        stdio: 'ignore'
      }
    );
    
    console.log('[Update] ✅ Script externe lancé');
    console.log('[Update] Le backend va redémarrer dans quelques secondes...');
    
    return {
      success: true,
      message: `Mise à jour vers ${targetVersion} en cours. Le système va redémarrer...`,
      needsRestart: false, // Le script externe gère le redémarrage
      externalScript: true,
      version: targetVersion
    };
    
  } catch (error: any) {
    console.error('[Update] ❌ Erreur lors du lancement de la mise à jour:', error.message);
    
    return {
      success: false,
      message: `Erreur: ${error.message}`
    };
  }
}

/**
 * Met à jour une application (git pull + docker compose up -d --build)
 */
async function updateApp(appName) {
  let snapshotPath = null;
  
  try {
    const appPath = path.join(APPS_DIR, appName);
    
    if (!fs.existsSync(appPath)) {
      return {
        success: false,
        message: `Application ${appName} introuvable`
      };
    }
    
    console.log(`[Update] Début de la mise à jour de ${appName}...`);
    
    // Initialisation - envoyer la première mise à jour
    sendUpdateProgress(appName, 0, 'Préparation de la mise à jour...', 'init');
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // 1. Créer un snapshot avant la mise à jour
    console.log('[Update] 📸 Création du snapshot de sécurité...');
    sendUpdateProgress(appName, 5, 'Création du snapshot de sécurité...', 'snapshot');
    try {
      const snapshotOutput = execSync('sudo /opt/Ryvie/scripts/snapshot.sh', { encoding: 'utf8' });
      console.log(snapshotOutput);
      
      // Extraire le chemin du snapshot
      const match = snapshotOutput.match(/SNAPSHOT_PATH=(.+)/);
      if (match) {
        snapshotPath = match[1].trim();
        console.log(`[Update] Snapshot créé: ${snapshotPath}`);
        sendUpdateProgress(appName, 10, 'Snapshot de sécurité créé', 'snapshot');
      }
    } catch (snapError: any) {
      console.error('[Update] ⚠️ Impossible de créer le snapshot:', snapError.message);
      console.log('[Update] Continuation sans snapshot...');
      sendUpdateProgress(appName, 10, 'Continuation sans snapshot...', 'snapshot');
    }
    
    // 2. Fetch tags puis git pull
    console.log(`[Update] Récupération des tags distants pour ${appName}...`);
    sendUpdateProgress(appName, 15, 'Récupération des mises à jour depuis GitHub...', 'download');
    execSync('git fetch --tags origin', {
      cwd: appPath,
      stdio: 'inherit'
    });
    
    console.log(`[Update] Git pull dans ${appPath}...`);
    sendUpdateProgress(appName, 25, 'Téléchargement des fichiers mis à jour...', 'download');
    execSync('git pull', {
      cwd: appPath,
      stdio: 'inherit'
    });
    sendUpdateProgress(appName, 40, 'Fichiers téléchargés avec succès', 'download');

    // Lors d'une mise à jour, toujours utiliser docker compose (ne jamais utiliser install.sh)
    console.log(`[Update] 🔄 Mise à jour via docker compose (install.sh ignoré si présent)...`);
    sendUpdateProgress(appName, 45, 'Préparation de la reconstruction...', 'build');
    
    // Trouver le docker-compose.yml
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'];
    let composeFile = null;
    
    for (const file of composeFiles) {
      const filePath = path.join(appPath, file);
      if (fs.existsSync(filePath)) {
        composeFile = file;
        break;
      }
    }
    
    if (!composeFile) {
      sendUpdateProgress(appName, 0, 'Aucun fichier docker-compose trouvé', 'error');
      return {
        success: false,
        message: `Aucun fichier docker-compose trouvé pour ${appName}`
      };
    }
    
    // Docker compose up -d --build
    console.log(`[Update] Docker compose up -d --build pour ${appName}...`);
    sendUpdateProgress(appName, 50, 'Reconstruction des containers...', 'build');
    execSync(`docker compose -f ${composeFile} up -d --build`, {
      cwd: appPath,
      stdio: 'inherit'
    });
    sendUpdateProgress(appName, 75, 'Containers reconstruits, démarrage...', 'starting');
    
    // Attendre 5 secondes que le container démarre
    console.log(`[Update] Attente du démarrage du container (5 secondes)...`);
    sendUpdateProgress(appName, 80, 'Attente du démarrage des containers...', 'starting');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Vérifier le statut du container
    console.log(`[Update] Vérification du statut du container ${appName}...`);
    sendUpdateProgress(appName, 85, 'Vérification du statut des containers...', 'verification');
    
    try {
      // Récupérer le statut du container
      const statusOutput = execSync(`docker ps -a --filter "name=${appName}" --format "{{.Status}}"`, { 
        encoding: 'utf8' 
      }).trim();
      
      console.log(`[Update] Container ${appName} - Status: ${statusOutput}`);
      
      // Vérifier si le container est exited (erreur)
      if (statusOutput.toLowerCase().includes('exited')) {
        throw new Error(`Le container ${appName} s'est arrêté (exited) pendant la mise à jour`);
      }
      
      // Vérifier le health status si disponible
      try {
        const healthOutput = execSync(
          `docker inspect --format='{{.State.Health.Status}}' $(docker ps -aq --filter "name=${appName}")`, 
          { encoding: 'utf8' }
        ).trim();
        
        console.log(`[Update] Container ${appName} - Health: ${healthOutput}`);
        
        if (healthOutput === 'unhealthy') {
          throw new Error(`Le container ${appName} est en état unhealthy`);
        }
        
        if (healthOutput === 'healthy') {
          console.log(`[Update] ✅ Container ${appName} est healthy`);
        } else if (healthOutput === 'starting') {
          console.log(`[Update] ⏳ Container ${appName} est en cours de démarrage`);
        }
      } catch (healthError: any) {
        // Pas de healthcheck configuré, on vérifie juste que le container est Up
        if (!statusOutput.toLowerCase().includes('up')) {
          throw new Error(`Le container ${appName} n'est pas démarré`);
        }
        console.log(`[Update] ℹ️ Container ${appName} sans healthcheck, statut: Up`);
      }
      
    } catch (checkError: any) {
      sendUpdateProgress(appName, 0, `Vérification échouée: ${checkError.message}`, 'error');
      throw new Error(`Vérification du container échouée: ${checkError.message}`);
    }
    
    sendUpdateProgress(appName, 95, 'Finalisation de la mise à jour...', 'finalization');
    console.log(`[Update] ✅ ${appName} mis à jour avec succès`);
    
    // 3. Supprimer le snapshot si tout s'est bien passé
    if (snapshotPath) {
      console.log('[Update] 🧹 Suppression du snapshot de sécurité...');
      try {
        execSync(`sudo btrfs subvolume delete "${snapshotPath}"/* 2>/dev/null || true`, { stdio: 'inherit' });
        execSync(`sudo rmdir "${snapshotPath}" 2>/dev/null || true`, { stdio: 'inherit' });
        console.log('[Update] ✅ Snapshot supprimé');
      } catch (delError: any) {
        console.warn('[Update] ⚠️ Impossible de supprimer le snapshot:', delError.message);
      }
    }
    
    sendUpdateProgress(appName, 100, 'Mise à jour terminée avec succès !', 'completed');
    
    return {
      success: true,
      message: `${appName} mis à jour avec succès`
    };
  } catch (error: any) {
    console.error(`[Update] ❌ Erreur lors de la mise à jour de ${appName}:`, error.message);
    
    // Envoyer le message d'erreur au frontend
    sendUpdateProgress(appName, 0, error.message, 'error');
    
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
        } catch (delError: any) {
          console.warn('[Update] ⚠️ Impossible de supprimer le snapshot:', delError.message);
        }
        
        return {
          success: false,
          message: `Erreur: ${error.message}. Rollback effectué avec succès.`
        };
      } catch (rollbackError: any) {
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
 * Télécharge apps.json depuis raw.githubusercontent.com (sans API REST)
 */
async function fetchAppsFromRaw(tag) {
  const axios = require('axios');
  const GITHUB_REPO = process.env.GITHUB_REPO || 'ryvieos/Ryvie-Apps';
  
  try {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/apps.json`;
    console.log(`[Update] Téléchargement de apps.json depuis: ${url}`);
    
    const response = await axios.get(url, {
      timeout: 300000,
      headers: {
        'User-Agent': 'Ryvie-App-Store'
      }
    });
    
    if (!Array.isArray(response.data)) {
      throw new Error('apps.json invalide: doit être un tableau');
    }
    
    console.log(`[Update] ✅ apps.json récupéré (${response.data.length} apps)`);
    return response.data;
  } catch (error: any) {
    console.error('[Update] Erreur lors du téléchargement de apps.json:', error.message);
    
    if (error.response?.status === 404) {
      throw new Error(`apps.json non trouvé pour le tag ${tag}`);
    }
    
    throw error;
  }
}

/**
 * Met à jour le catalogue d'apps du store
 */
async function updateStoreCatalog() {
  const appStoreService = require('../apps/appStoreService');
  const { checkStoreCatalogUpdate } = require('./updateCheckService');
  
  try {
    console.log('[Update] Vérification du catalogue...');
    
    // Vérifier si le fichier local existe
    const localApps = await appStoreService.loadAppsFromFile();
    const catalogMissing = !localApps || !Array.isArray(localApps);
    
    // D'abord, vérifier si une mise à jour est nécessaire
    const checkResult = await checkStoreCatalogUpdate();
    
    if (!checkResult.updateAvailable && !catalogMissing) {
      console.log(`[Update] ✅ Catalogue déjà à jour (${checkResult.currentVersion})`);

      let detectedUpdates = [];
      try {
        console.log('[Update] 🔄 Actualisation des statuts d\'installation...');
        const enrichment = await appStoreService.enrichAppsWithInstalledVersions(localApps);
        // Sauvegarder les apps enrichies pour actualiser les statuts
        await appStoreService.saveAppsToFile(enrichment.apps);
        detectedUpdates = enrichment.updates;
        console.log(`[Update] ✅ Statuts actualisés: ${enrichment.apps.filter(a => a.installedVersion).length} apps installées, ${detectedUpdates.length} mise(s) à jour disponible(s)`);
      } catch (enrichError: any) {
        console.warn('[Update] ⚠️ Impossible de rafraîchir les informations d\'installation:', enrichError.message);
      }

      return {
        success: true,
        message: `Catalogue déjà à jour (${checkResult.currentVersion})`,
        version: checkResult.currentVersion,
        updated: false,
        updates: detectedUpdates
      };
    }
    
    if (catalogMissing) {
      console.log('[Update] 📥 Catalogue local absent, téléchargement depuis GitHub...');
    }
    
    console.log(`[Update] Mise à jour du catalogue: ${checkResult.currentVersion || 'aucune'} → ${checkResult.latestVersion}`);
    
    // Le tag est déjà disponible dans checkResult, pas besoin d'appeler à nouveau
    const finalTag = checkResult.latestVersion;
    
    if (!finalTag) {
      throw new Error('Impossible de récupérer le tag du catalogue');
    }
    
    // Télécharger apps.json depuis raw.githubusercontent.com (sans API REST)
    const data = await fetchAppsFromRaw(finalTag);
    
    // Sauvegarder le catalogue pur depuis GitHub (sans enrichissement)
    // L'enrichissement se fera automatiquement en mémoire lors de l'appel à getApps()
    await appStoreService.saveAppsToFile(data);
    
    // Vérifier les apps installées pour le log
    let detectedUpdates = [];
    try {
      console.log('[Update] 🔄 Vérification des apps installées...');
      if (Array.isArray(data)) {
        const enrichment = await appStoreService.enrichAppsWithInstalledVersions(data);
        detectedUpdates = enrichment.updates;
        const installedCount = enrichment.apps.filter(a => a.installedBuildId !== null && a.installedBuildId !== undefined).length;
        console.log(`[Update] ✅ ${installedCount} apps installées, ${detectedUpdates.length} mise(s) à jour disponible(s)`);
      }
    } catch (enrichError: any) {
      console.warn('[Update] ⚠️ Impossible de vérifier les apps installées:', enrichError.message);
    }
    
    // Mettre à jour les métadonnées
    appStoreService.metadata.releaseTag = finalTag;
    appStoreService.metadata.lastCheck = Date.now();
    await appStoreService.saveMetadata();
    
    console.log(`[Update] ✅ Catalogue mis à jour vers ${finalTag}`);
    
    return {
      success: true,
      message: `Catalogue mis à jour vers ${finalTag}`,
      version: finalTag,
      appsCount: Array.isArray(data) ? data.length : 0,
      updated: true,
      updates: detectedUpdates
    };
  } catch (error: any) {
    console.error('[Update] ❌ Erreur lors de la mise à jour du catalogue:', error.message);
    
    return {
      success: false,
      message: `Erreur: ${error.message}`,
      updated: false
    };
  }
}


export = {
  updateRyvie,
  updateApp,
  updateStoreCatalog,
  updateProgressEmitter
};
