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
    
    // PM2 reload all
    console.log('[Update] Redémarrage PM2...');
    execSync('pm2 reload all', {
      stdio: 'inherit'
    });
    
    console.log('[Update] ✅ Ryvie mis à jour avec succès');
    return {
      success: true,
      message: 'Ryvie mis à jour avec succès'
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
