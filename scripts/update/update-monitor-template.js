/**
 * Service de monitoring des mises à jour Ryvie
 * Ce fichier est copié dans /tmp lors d'une mise à jour et reste actif pendant que Ryvie redémarre.
 * Son rôle est de servir une page HTML statique qui gère l'affichage de la progression.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const ENV_FILE = '/tmp/ryvie-update-monitor/.env';
const LOG_FILE = '/data/logs/update-monitor.log';
const HTML_FILE = '/tmp/ryvie-update-monitor/update-monitor.html';

// Fonction de logging robuste
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    console.error(`Erreur ecriture log: ${e.message}`);
  }
}

// Fonction pour échapper les caractères pour l'injection dans HTML
function escapeAttr(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Lire l'URL de retour depuis le fichier .env
let savedReturnUrl = '';
try {
  if (fs.existsSync(ENV_FILE)) {
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    const match = envContent.match(/RETURN_URL=(.+)/);
    if (match) {
      savedReturnUrl = match[1].trim();
      log(`[Monitor] URL de retour chargee depuis .env: ${savedReturnUrl}`);
    }
  }
} catch (e) {
  log(`[Monitor] Erreur lecture .env: ${e.message}`);
}

app.use(cors());
app.use(express.json());

// Servir la page HTML de monitoring en remplaçant le placeholder
app.get('/', (req, res) => {
  try {
    if (fs.existsSync(HTML_FILE)) {
      let htmlContent = fs.readFileSync(HTML_FILE, 'utf8');
      const safeReturnUrl = escapeAttr(savedReturnUrl);
      htmlContent = htmlContent.replace('__RETURN_URL__', safeReturnUrl);
      res.send(htmlContent);
    } else {
      res.status(404).send('Fichier de monitoring introuvable.');
    }
  } catch (error) {
    log(`Erreur en servant le fichier HTML: ${error.message}`);
    res.status(500).send('Erreur interne du serveur de monitoring.');
  }
});

// Endpoint de santé pour le frontend
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Endpoint pour lire le fichier de statut (utilisé par d'anciennes versions, conservé pour compatibilité)
app.get('/status', (req, res) => {
  const statusFile = '/tmp/ryvie-update-status.json';
  if (fs.existsSync(statusFile)) {
    try {
      const statusContent = fs.readFileSync(statusFile, 'utf8');
      res.json(JSON.parse(statusContent));
    } catch (e) {
      res.json({ 
        step: 'error',
        progress: 0,
        message: 'Erreur lecture statut.'
      });
    }
  } else {
    res.json({ 
      step: 'initializing', 
      progress: 5, 
      message: 'Initialisation de la mise à jour...'
    });
  }
});

// Fonction de nettoyage et d'arrêt du service
const performCleanupAndShutdown = (reason) => {
  log(`[Update Monitor] Nettoyage demande (${reason})`);
  
  // Arrêter le serveur pour ne plus accepter de requêtes
  server.close(() => {
    log('[Update Monitor] Serveur arrete.');
    try {
      log("[Update Monitor] Debut du nettoyage des fichiers...");
      const tmpDir = '/tmp/ryvie-update-monitor';
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        log(`[Update Monitor] Dossier temporaire supprime: ${tmpDir}`);
      }
      log("[Update Monitor] Nettoyage termine, arret du processus.");
      process.exit(0);
    } catch (error) {
      log(`[Update Monitor] Erreur nettoyage: ${error.message}`);
      process.exit(1);
    }
  });
};

// Endpoint de nettoyage - arrête le service et supprime les fichiers temporaires
app.post('/cleanup', (req, res) => {
  res.json({ success: true });
  // Laisser un court délai pour que la réponse HTTP soit envoyée
  setTimeout(() => performCleanupAndShutdown('API call'), 50);
});

// Démarrer le serveur
const server = app.listen(PORT, () => {
  log(`[Update Monitor] Service de monitoring demarre sur le port ${PORT}`);
  log(`[Update Monitor] PID du processus: ${process.pid}`);
  log("[Update Monitor] Pret a recevoir des requetes");
});

// Sécurité : arrêt automatique après 10 minutes
setTimeout(() => {
  performCleanupAndShutdown('Timeout de securite');
}, 600000); // 10 minutes

// Gérer l'arrêt propre en appelant la fonction de nettoyage complète
const shutdown = (signal) => {
  performCleanupAndShutdown(signal);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  log(`[Update Monitor] Exception non geree: ${error.message}`);
  log(`[Update Monitor] Stack: ${error.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`[Update Monitor] Promesse rejetee non geree: ${reason}`);
});
