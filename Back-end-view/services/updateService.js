const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RYVIE_DIR = '/opt/Ryvie';
const APPS_DIR = '/data/apps';

/**
 * Met à jour Ryvie (git pull + pm2 reload)
 */
async function updateRyvie() {
  let snapshotPath = null;
  
  try {
    console.log('[Update] Début de la mise à jour de Ryvie...');
    
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
    } catch (snapError) {
      console.error('[Update] ⚠️ Impossible de créer le snapshot:', snapError.message);
      console.log('[Update] Continuation sans snapshot...');
    }
    
    // 2. Fetch tags puis git pull
    console.log('[Update] Récupération des tags distants...');
    execSync('git fetch --tags origin', {
      cwd: RYVIE_DIR,
      stdio: 'inherit'
    });
    
    console.log('[Update] Git pull dans /opt/Ryvie...');
    execSync('git pull', {
      cwd: RYVIE_DIR,
      stdio: 'inherit'
    });
    
    console.log('[Update] ✅ Code mis à jour avec succès');
    return {
      success: true,
      message: 'Code mis à jour. Redémarrage en cours...',
      needsRestart: true,
      snapshotPath
    };
  } catch (error) {
    console.error('[Update] ❌ Erreur lors de la mise à jour de Ryvie:', error.message);
    
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
    } catch (snapError) {
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
      } catch (healthError) {
        // Pas de healthcheck configuré, on vérifie juste que le container est Up
        if (!statusOutput.toLowerCase().includes('up')) {
          throw new Error(`Le container ${appName} n'est pas démarré`);
        }
        console.log(`[Update] ℹ️ Container ${appName} sans healthcheck, statut: Up`);
      }
      
    } catch (checkError) {
      throw new Error(`Vérification du container échouée: ${checkError.message}`);
    }
    
    console.log(`[Update] ✅ ${appName} mis à jour avec succès`);
    
    // 3. Supprimer le snapshot si tout s'est bien passé
    if (snapshotPath) {
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
      message: `${appName} mis à jour avec succès`
    };
  } catch (error) {
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

module.exports = {
  updateRyvie,
  updateApp
};
