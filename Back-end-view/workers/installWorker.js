/**
 * Worker pour l'installation d'applications
 * S'exécute dans un processus séparé pour ne pas bloquer le serveur principal
 */

const { updateAppFromStore } = require('../services/appStoreService');

// Récupérer l'appId depuis les arguments
const appId = process.argv[2];

if (!appId) {
  console.error('[InstallWorker] Erreur: appId manquant');
  process.exit(1);
}

console.log(`[InstallWorker] Démarrage de l'installation de ${appId}...`);

// Lancer l'installation
updateAppFromStore(appId)
  .then(result => {
    if (result.success) {
      console.log(`[InstallWorker] ✅ Installation de ${appId} terminée avec succès`);
      process.exit(0);
    } else {
      console.error(`[InstallWorker] ❌ Échec de l'installation de ${appId}:`, result.error);
      process.exit(1);
    }
  })
  .catch(error => {
    console.error(`[InstallWorker] ❌ Erreur lors de l'installation de ${appId}:`, error);
    process.exit(1);
  });
