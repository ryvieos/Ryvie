const fs = require('fs');
const path = require('path');
const { NETBIRD_FILE } = require('../config/paths');

/**
 * Synchronise le fichier netbird-data.json depuis /data/config/netbird vers le frontend
 */
function syncNetbirdConfig() {
  const sourceFile = NETBIRD_FILE;
  const targetFile = path.join(__dirname, '../../Ryvie-Front/src/config/netbird-data.json');
  
  try {
    // Vérifier si le fichier source existe
    if (!fs.existsSync(sourceFile)) {
      console.log('ℹ️  Fichier netbird-data.json source non trouvé, skip synchronisation');
      return;
    }
    
    // Créer le dossier de destination si nécessaire
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    // Copier le fichier
    fs.copyFileSync(sourceFile, targetFile);
    console.log('✅ Configuration Netbird synchronisée avec succès');
    console.log(`   Source: ${sourceFile}`);
    console.log(`   Destination: ${targetFile}`);
  } catch (error) {
    console.error('⚠️  Erreur lors de la synchronisation de netbird-data.json:', error.message);
  }
}

module.exports = { syncNetbirdConfig };
