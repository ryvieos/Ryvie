const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { APPS_DIR, RYVIE_DIR } = require('../config/paths');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TEMP_DIR = path.join(RYVIE_DIR, '.update-staging');

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
    
    // 1. Récupérer la dernière release depuis GitHub
    console.log('[Update] 📥 Récupération de la dernière release...');
    const headers: any = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Ryvie-Update-System'
    };
    
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }
    
    const releaseResponse = await axios.get(
      'https://api.github.com/repos/maisonnavejul/Ryvie/releases/latest',
      { headers, timeout: 60000 }
    );
    
    const release = releaseResponse.data;
    const targetVersion = release.tag_name;
    
    console.log(`[Update] Dernière version disponible: ${targetVersion}`);
    
    // 2. Vérifier si déjà à jour
    const currentVersion = getCurrentRyvieVersion();
    console.log(`[Update] Version actuelle: ${currentVersion}`);
    
    if (currentVersion === targetVersion) {
      return {
        success: true,
        message: `Ryvie est déjà à jour (${currentVersion})`,
        needsRestart: false
      };
    }
    
    // 3. Détecter le mode actuel (dev ou prod)
    let mode = 'prod';
    try {
      const pm2List = execSync('pm2 list', { encoding: 'utf8' });
      if (pm2List.includes('ryvie-backend-dev')) {
        mode = 'dev';
      }
    } catch (_) {
      mode = 'prod';
    }
    
    console.log(`[Update] Mode détecté: ${mode}`);
    
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
      needsRestart: true,
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
    
    // 1. Créer un snapshot avant la mise à jour
    console.log('[Update] 📸 Création du snapshot de sécurité...');
    try {
      const snapshotOutput = execSync('sudo /opt/Ryvie/scripts/snapshot.sh', { encoding: 'utf8' });
      console.log(snapshotOutput);
      
      // Extraire le chemin du snapshot
      const match = snapshotOutput.match(/SNAPSHOT_PATH=(.+)/);
      if (match) {
        snapshotPath = match[1].trim();
        console.log(`[Update] Snapshot créé: ${snapshotPath}`);
      }
    } catch (snapError: any) {
      console.error('[Update] ⚠️ Impossible de créer le snapshot:', snapError.message);
      console.log('[Update] Continuation sans snapshot...');
    }
    
    // 2. Fetch tags puis git pull
    console.log(`[Update] Récupération des tags distants pour ${appName}...`);
    execSync('git fetch --tags origin', {
      cwd: appPath,
      stdio: 'inherit'
    });
    
    console.log(`[Update] Git pull dans ${appPath}...`);
    execSync('git pull', {
      cwd: appPath,
      stdio: 'inherit'
    });

    const installScriptPath = path.join(appPath, 'install.sh');
    const hasInstallScript = fs.existsSync(installScriptPath);

    if (hasInstallScript) {
      console.log(`[Update] install.sh détecté pour ${appName}, exécution du script...`);
      try {
        execSync(`chmod +x "${installScriptPath}"`, { stdio: 'pipe' });
        execSync(`bash "${installScriptPath}"`, {
          cwd: appPath,
          stdio: 'inherit',
          env: { ...process.env, APP_ID: appName }
        });
        console.log('[Update] ✅ Script install.sh exécuté avec succès');
      } catch (scriptError: any) {
        throw new Error(`Échec du script d'installation: ${scriptError.message}`);
      }
    } else {
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
        return {
          success: false,
          message: `Aucun fichier docker-compose trouvé pour ${appName}`
        };
      }
      
      // Docker compose up -d --build
      console.log(`[Update] Docker compose up -d --build pour ${appName}...`);
      execSync(`docker compose -f ${composeFile} up -d --build`, {
        cwd: appPath,
        stdio: 'inherit'
      });
      
      // Attendre 5 secondes que le container démarre
      console.log(`[Update] Attente du démarrage du container (5 secondes)...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Vérifier le statut du container
      console.log(`[Update] Vérification du statut du container ${appName}...`);
      
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
        throw new Error(`Vérification du container échouée: ${checkError.message}`);
      }
    }
    
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
    
    return {
      success: true,
      message: `${appName} mis à jour avec succès`
    };
  } catch (error: any) {
    console.error(`[Update] ❌ Erreur lors de la mise à jour de ${appName}:`, error.message);
    
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
 * Met à jour le catalogue d'apps du store
 */
async function updateStoreCatalog() {
  const appStoreService = require('./appStoreService');
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
    
    // Récupérer la dernière release
    const latestRelease = await appStoreService.getLatestRelease();
    
    // Télécharger apps.json depuis la release
    const data = await appStoreService.fetchAppsFromRelease(latestRelease);
    
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
    appStoreService.metadata.releaseTag = latestRelease.tag;
    appStoreService.metadata.lastCheck = Date.now();
    await appStoreService.saveMetadata();
    
    console.log(`[Update] ✅ Catalogue mis à jour vers ${latestRelease.tag}`);
    
    return {
      success: true,
      message: `Catalogue mis à jour vers ${latestRelease.tag}`,
      version: latestRelease.tag,
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
  updateStoreCatalog
};
