const fs = require('fs');
const path = require('path');
const { NETBIRD_FILE, FRONTEND_CONFIG_DIR } = require('../config/paths');

/**
 * Synchronise le fichier netbird-data.json depuis /data/config/netbird
 * vers /data/config/frontend-view (servi au frontend via l'API backend)
 */
function syncNetbirdConfig() {
  const sourceFile = NETBIRD_FILE;
  const targetFile = path.join(FRONTEND_CONFIG_DIR, 'netbird-data.json');
  
  try {
    // Vérifier si le fichier source existe
    if (!fs.existsSync(sourceFile)) {
      console.log('ℹ️  Fichier netbird-data.json source non trouvé, skip synchronisation');
      return;
    }
    
    // Créer le dossier de destination si nécessaire
    if (!fs.existsSync(FRONTEND_CONFIG_DIR)) {
      fs.mkdirSync(FRONTEND_CONFIG_DIR, { recursive: true });
    }
    
    // Copier vers /data/config/frontend-view
    fs.copyFileSync(sourceFile, targetFile);
    console.log('✅ Configuration Netbird synchronisée avec succès');
    console.log(`   Source: ${sourceFile}`);
    console.log(`   Destination: ${targetFile}`);
  } catch (error: any) {
    console.error('⚠️  Erreur lors de la synchronisation de netbird-data.json:', error.message);
  }
}

export = { syncNetbirdConfig };
