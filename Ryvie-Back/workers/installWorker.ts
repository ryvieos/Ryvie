/**
 * Worker pour l'installation d'applications
 * S'exécute dans un processus séparé pour ne pas bloquer le serveur principal
 */

const appStoreService = require('../services/appStoreService');

// Wrapper pour intercepter les événements de progression
const originalProgressEmitter = appStoreService.progressEmitter;
originalProgressEmitter.on('progress', (update) => {
  if (process.send) {
    process.send({ type: 'progress', data: update });
  }
});

const { updateAppFromStore } = appStoreService;

// Récupérer l'appId depuis les arguments
const appId = process.argv[2];

if (!appId) {
  console.error('[InstallWorker] Erreur: appId manquant');
  process.exit(1);
}

console.log(`[InstallWorker] Démarrage de l'installation de ${appId}...`);

// Timeout de 10 minutes (600000 ms)
const TIMEOUT_MS = 10 * 60 * 1000;
const timeoutId = setTimeout(() => {
  console.error(`[InstallWorker] ⏱️ Timeout: Installation de ${appId} annulée après 10 minutes`);
  process.exit(1);
}, TIMEOUT_MS);

// Lancer l'installation
updateAppFromStore(appId)
  .then(result => {
    clearTimeout(timeoutId);
    if (result.success) {
      console.log(`[InstallWorker] ✅ Installation de ${appId} terminée avec succès`);
      process.exit(0);
    } else {
      console.error(`[InstallWorker] ❌ Échec de l'installation de ${appId}:`, result.error);
      process.exit(1);
    }
  })
  .catch(error => {
    clearTimeout(timeoutId);
    console.error(`[InstallWorker] ❌ Erreur lors de l'installation de ${appId}:`, error);
    process.exit(1);
  });
