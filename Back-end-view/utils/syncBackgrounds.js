const fs = require('fs');
const path = require('path');

const SOURCE_DIR = '/opt/Ryvie/Ryvie-Front/public/images/backgrounds';
const DEST_DIR = '/data/images/backgrounds';

/**
 * Synchronise les fonds d'écran depuis public/ vers /data/images/backgrounds/
 * Copie uniquement les nouveaux fichiers ou ceux qui ont été modifiés
 */
function syncBackgrounds() {
  console.log('[SyncBackgrounds] Synchronisation des fonds d\'écran...');
  
  // S'assurer que les répertoires existent
  if (!fs.existsSync(SOURCE_DIR)) {
    console.log('[SyncBackgrounds] ⚠️  Dossier source non trouvé:', SOURCE_DIR);
    return;
  }
  
  if (!fs.existsSync(DEST_DIR)) {
    fs.mkdirSync(DEST_DIR, { recursive: true });
    console.log('[SyncBackgrounds] ✅ Dossier destination créé:', DEST_DIR);
  }
  
  try {
    // Lire les fichiers du dossier source
    const sourceFiles = fs.readdirSync(SOURCE_DIR);
    let copiedCount = 0;
    let skippedCount = 0;
    
    sourceFiles.forEach(file => {
      // Filtrer uniquement les images
      if (!/\.(jpg|jpeg|png|webp)$/i.test(file)) {
        return;
      }
      
      const sourcePath = path.join(SOURCE_DIR, file);
      const destPath = path.join(DEST_DIR, file);
      
      // Vérifier si le fichier existe déjà dans la destination
      if (fs.existsSync(destPath)) {
        // Comparer les dates de modification
        const sourceStats = fs.statSync(sourcePath);
        const destStats = fs.statSync(destPath);
        
        if (sourceStats.mtime > destStats.mtime) {
          // Le fichier source est plus récent, on le copie
          fs.copyFileSync(sourcePath, destPath);
          console.log(`[SyncBackgrounds] 🔄 Mis à jour: ${file}`);
          copiedCount++;
        } else {
          skippedCount++;
        }
      } else {
        // Le fichier n'existe pas dans la destination, on le copie
        fs.copyFileSync(sourcePath, destPath);
        console.log(`[SyncBackgrounds] ➕ Ajouté: ${file}`);
        copiedCount++;
      }
    });
    
    console.log(`[SyncBackgrounds] ✅ Synchronisation terminée: ${copiedCount} fichier(s) copié(s), ${skippedCount} fichier(s) déjà à jour`);
  } catch (error) {
    console.error('[SyncBackgrounds] ❌ Erreur lors de la synchronisation:', error);
  }
}

/**
 * Surveille le dossier source et synchronise automatiquement les changements
 */
function watchBackgrounds() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.log('[SyncBackgrounds] ⚠️  Impossible de surveiller, dossier source non trouvé');
    return;
  }
  
  console.log('[SyncBackgrounds] 👁️  Surveillance des changements activée');
  
  fs.watch(SOURCE_DIR, (eventType, filename) => {
    if (filename && /\.(jpg|jpeg|png|webp)$/i.test(filename)) {
      console.log(`[SyncBackgrounds] 🔔 Changement détecté: ${filename}`);
      
      // Attendre un peu pour s'assurer que le fichier est complètement écrit
      setTimeout(() => {
        const sourcePath = path.join(SOURCE_DIR, filename);
        const destPath = path.join(DEST_DIR, filename);
        
        if (fs.existsSync(sourcePath)) {
          try {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`[SyncBackgrounds] ✅ Synchronisé: ${filename}`);
          } catch (error) {
            console.error(`[SyncBackgrounds] ❌ Erreur copie ${filename}:`, error.message);
          }
        }
      }, 500);
    }
  });
}

module.exports = {
  syncBackgrounds,
  watchBackgrounds
};
