const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RYVIE_DIR = '/opt/Ryvie';
const APPS_DIR = '/data/apps';

/**
 * Met à jour Ryvie (git pull + pm2 reload)
 */
async function updateRyvie() {
  try {
    console.log('[Update] Début de la mise à jour de Ryvie...');
    
    // Git pull
    console.log('[Update] Git pull dans /opt/Ryvie...');
    execSync('git pull', {
      cwd: RYVIE_DIR,
      stdio: 'inherit'
    });
    
    console.log('[Update] ✅ Code mis à jour avec succès');
    return {
      success: true,
      message: 'Code mis à jour. Redémarrage en cours...',
      needsRestart: true
    };
  } catch (error) {
    console.error('[Update] ❌ Erreur lors de la mise à jour de Ryvie:', error.message);
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
  try {
    const appPath = path.join(APPS_DIR, appName);
    
    if (!fs.existsSync(appPath)) {
      return {
        success: false,
        message: `Application ${appName} introuvable`
      };
    }
    
    console.log(`[Update] Début de la mise à jour de ${appName}...`);
    
    // Git pull
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
    return {
      success: true,
      message: `${appName} mis à jour avec succès`
    };
  } catch (error) {
    console.error(`[Update] ❌ Erreur lors de la mise à jour de ${appName}:`, error.message);
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
