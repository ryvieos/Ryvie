/**
 * Worker pour la désinstallation d'applications
 * S'exécute dans un processus séparé pour ne pas bloquer le serveur principal
 */

export {}; // Make this file a module to avoid global scope conflicts

const appStoreService = require('../services/appStoreService');

const { uninstallApp } = appStoreService;

// Récupérer l'appId depuis les arguments
const appId = process.argv[2];

if (!appId) {
  console.error('[UninstallWorker] Erreur: appId manquant');
  process.exit(1);
}

console.log(`[UninstallWorker] Démarrage de la désinstallation de ${appId}...`);

// Gérer l'annulation via SIGTERM
process.on('SIGTERM', () => {
  console.log(`[UninstallWorker] 🛑 SIGTERM reçu, arrêt de la désinstallation de ${appId}`);
  process.exit(2); // Code 2 = annulé
});

// Timeout de 5 minutes (300000 ms)
const TIMEOUT_MS = 5 * 60 * 1000;
const timeoutId = setTimeout(() => {
  console.error(`[UninstallWorker] ⏱️ Timeout: Désinstallation de ${appId} annulée après 5 minutes`);
  process.exit(1);
}, TIMEOUT_MS);

// Lancer la désinstallation
uninstallApp(appId)
  .then(result => {
    clearTimeout(timeoutId);
    if (result.success) {
      console.log(`[UninstallWorker] ✅ Désinstallation de ${appId} terminée avec succès`);
      process.exit(0);
    } else {
      console.error(`[UninstallWorker] ❌ Échec de la désinstallation de ${appId}:`, result.message || result.error);
      process.exit(1);
    }
  })
  .catch(error => {
    clearTimeout(timeoutId);
    console.error(`[UninstallWorker] ❌ Erreur lors de la désinstallation de ${appId}:`, error);
    process.exit(1);
  });
