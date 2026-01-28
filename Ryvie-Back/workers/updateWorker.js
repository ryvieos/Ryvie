/**
 * Worker pour gérer les mises à jour d'applications en arrière-plan
 * Ce worker exécute la mise à jour dans un processus séparé pour ne pas bloquer le serveur
 */

const { updateApp } = require('../services/updateService');

// Récupérer l'appName depuis les arguments
const appName = process.argv[2];

if (!appName) {
  console.error('[UpdateWorker] Erreur: appName manquant');
  process.exit(1);
}

console.log(`[UpdateWorker] Démarrage de la mise à jour de ${appName}...`);

// Fonction pour envoyer des logs au processus parent
function sendLog(message) {
  if (process.send) {
    process.send({ type: 'log', message });
  }
}

// Fonction pour envoyer la progression au processus parent
function sendProgress(data) {
  if (process.send) {
    process.send({ type: 'progress', data });
  }
}

// Écouter les événements de progression depuis updateService
const { updateProgressEmitter } = require('../services/updateService');

updateProgressEmitter.on('progress', (update) => {
  if (update.appName === appName) {
    sendProgress(update);
  }
});

// Lancer la mise à jour
(async () => {
  try {
    sendLog(`Début de la mise à jour de ${appName}`);
    
    const result = await updateApp(appName);
    
    if (result.success) {
      sendLog(`✅ Mise à jour de ${appName} terminée avec succès`);
      process.exit(0);
    } else {
      sendLog(`❌ Échec de la mise à jour: ${result.message}`);
      process.exit(1);
    }
  } catch (error) {
    sendLog(`❌ Erreur lors de la mise à jour: ${error.message}`);
    console.error('[UpdateWorker] Erreur:', error);
    process.exit(1);
  }
})();
