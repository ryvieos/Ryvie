/**
 * Service de monitoring des mises à jour Ryvie
 * Ce fichier est copié dans /tmp lors d'une mise à jour
 * Il reste actif pendant que Ryvie redémarre
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3005;
const STATUS_FILE = '/tmp/ryvie-update-status.json';
const ENV_FILE = '/tmp/ryvie-update-monitor/.env';
const LOG_FILE = '/data/logs/update-monitor.log';

// Fonction pour logger dans le fichier /data/logs/update-monitor.log
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message); // Aussi afficher dans stdout
  try {
    fs.appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    console.error('Erreur écriture log:', e.message);
  }
}

// Lire l'URL de retour depuis le fichier .env
let savedReturnUrl = null;
try {
  if (fs.existsSync(ENV_FILE)) {
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    const match = envContent.match(/RETURN_URL=(.+)/);
    if (match) {
      savedReturnUrl = match[1].trim();
      log('[Monitor] URL de retour chargée depuis .env: ' + savedReturnUrl);
    }
  }
} catch (e) {
  log('[Monitor] Erreur lecture .env: ' + e.message);
}

app.use(cors());
app.use(express.json());

// Servir la page HTML de monitoring
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mise à jour en cours - Ryvie</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f5f5f7;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #333;
    }

    .update-container {
      background: white;
      border-radius: 16px;
      padding: 48px;
      max-width: 520px;
      width: 90%;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      text-align: center;
    }

    .spinner {
      width: 64px;
      height: 64px;
      border: 4px solid #e5e7eb;
      border-top: 4px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #1a202c;
    }

    .message {
      font-size: 14px;
      color: #718096;
      margin-bottom: 24px;
      line-height: 1.6;
      min-height: 40px;
    }

    .version {
      display: inline-block;
      background: #f7fafc;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      color: #4a5568;
      margin-bottom: 24px;
    }

    .progress-container {
      width: 100%;
      height: 8px;
      background: #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    .progress-bar {
      height: 100%;
      background: #667eea;
      border-radius: 4px;
      transition: width 0.3s ease;
      width: 5%;
    }

    .progress-text {
      font-size: 13px;
      color: #718096;
      font-weight: 500;
    }

    .success-icon {
      display: none;
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      background: #48bb78;
      border-radius: 50%;
      position: relative;
    }

    .success-icon::after {
      content: '✓';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 32px;
      font-weight: bold;
    }

    .error-icon {
      display: none;
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      background: #f56565;
      border-radius: 50%;
      position: relative;
    }

    .error-icon::after {
      content: '✕';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 32px;
      font-weight: bold;
    }

    .step-indicator {
      font-size: 12px;
      color: #a0aec0;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="update-container">
    <div class="spinner" id="spinner"></div>
    <div class="success-icon" id="successIcon"></div>
    <div class="error-icon" id="errorIcon"></div>
    
    <h1>Mise à jour en cours</h1>
    <div class="message" id="message">Initialisation de la mise à jour...</div>
    <div class="version" id="version">Version cible: latest</div>
    
    <div class="progress-container">
      <div class="progress-bar" id="progressBar"></div>
    </div>
    <div class="progress-text" id="progressText">5%</div>
    <div class="step-indicator" id="stepIndicator"></div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const targetVersion = urlParams.get('version') || 'latest';
    const accessMode = urlParams.get('mode') || 'private';
    const returnUrl = urlParams.get('return') || '/#/home';
    const originParam = urlParams.get('origin') || '';
    
    console.log('[Monitor Client] Version cible:', targetVersion);
    console.log('[Monitor Client] Mode acces:', accessMode);
    console.log('[Monitor Client] URL de retour (param):', returnUrl);
    console.log('[Monitor Client] Origin (param):', originParam);
    
    document.getElementById('version').textContent = 'Version cible: ' + targetVersion;

    const UPDATE_DURATION = 180000; // 3 minutes en millisecondes
    const startTime = Date.now();
    let redirected = false;

    function updateProgress(progress, message, step) {
      document.getElementById('progressBar').style.width = progress + '%';
      document.getElementById('progressText').textContent = progress + '%';
      document.getElementById('message').textContent = message;
      if (step) {
        document.getElementById('stepIndicator').textContent = step;
      }
    }

    function getRedirectOrigin() {
      // Priorité:
      // 1) param origin (ex: http://rev.local:3000)
      // 2) origin sauvegardée dans .env (injectée côté serveur)
      // 3) origin actuelle de la page (ryvie.local:3005)
      const saved = ${JSON.stringify(savedReturnUrl || '')};

      if (originParam && /^https?:\/\//.test(originParam)) return originParam;
      if (saved && /^https?:\/\//.test(saved)) return saved;
      return window.location.origin;
    }

    // Timer simple de 3 minutes avec progression fluide
    function startUpdateTimer() {
      console.log('[Monitor] Démarrage du timer de mise à jour (3 minutes)');
      
      // Mettre à jour la progression toutes les 500ms
      const updateInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(99, Math.floor((elapsed / UPDATE_DURATION) * 100));
        
        // Messages selon la progression
        let message = 'Mise à jour en cours...';
        let step = 'Installation';
        
        if (progress < 20) {
          message = 'Téléchargement des fichiers...';
          step = 'Téléchargement';
        } else if (progress < 40) {
          message = 'Installation des composants...';
          step = 'Installation';
        } else if (progress < 60) {
          message = 'Configuration du système...';
          step = 'Configuration';
        } else if (progress < 80) {
          message = 'Redémarrage des services...';
          step = 'Redémarrage';
        } else if (progress < 95) {
          message = 'Finalisation de la mise à jour...';
          step = 'Finalisation';
        } else {
          message = 'Presque terminé...';
          step = 'Finalisation';
        }
        
        updateProgress(progress, message, step);
        
        // Si on a atteint ou dépassé 3 minutes
        if (elapsed >= UPDATE_DURATION && !redirected) {
          clearInterval(updateInterval);
          
          console.log('[Monitor] Mise à jour terminée, redirection imminente');
          document.getElementById('spinner').style.display = 'none';
          document.getElementById('successIcon').style.display = 'block';
          updateProgress(100, 'Mise à jour terminée. Attendez quelques secondes...', 'Terminé');
          
          // Rediriger après 2 secondes
          setTimeout(() => {
            const redirectOrigin = getRedirectOrigin();
            const finalUrl = redirectOrigin + returnUrl;
            console.log('[Monitor] Redirection vers:', finalUrl);
            redirected = true;
            window.location.href = finalUrl;
            
            // Nettoyer le service après la redirection
            setTimeout(async () => {
              try {
                await fetch('http://' + window.location.hostname + ':3005/cleanup', {
                  method: 'POST'
                });
                console.log('[Monitor] Cleanup appelé');
              } catch (e) {
                console.log('[Monitor] Cleanup appelé (erreur ignorée)');
              }
            }, 2000);
          }, 2000);
        }
      }, 500);
    }

    // Démarrer le timer
    startUpdateTimer();
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

// Endpoint pour lire le fichier de statut
app.get('/status', (req, res) => {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      res.json(status);
    } else {
      res.json({ 
        step: 'initializing', 
        progress: 5, 
        message: 'Initialisation de la mise à jour...' 
      });
    }
  } catch (error) {
    res.json({ 
      step: 'initializing', 
      progress: 5, 
      message: 'Initialisation de la mise à jour...' 
    });
  }
});

// Endpoint de santé
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Endpoint de nettoyage - arrête le service et supprime les fichiers temporaires
app.post('/cleanup', (req, res) => {
  log('[Update Monitor] Nettoyage demandé');
  res.json({ success: true });
  
  setTimeout(() => {
    try {
      log('[Update Monitor] Début du nettoyage...');
      
      // Supprimer le fichier de statut
      if (fs.existsSync(STATUS_FILE)) {
        fs.unlinkSync(STATUS_FILE);
        log('[Update Monitor] Fichier de statut supprimé: ' + STATUS_FILE);
      }
      
      // Lister les fichiers avant suppression pour le log
      const tmpDir = '/tmp/ryvie-update-monitor';
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        log('[Update Monitor] Fichiers à supprimer: ' + files.join(', '));
      }
      
      // Supprimer le dossier temporaire (incluant .env, data.log, monitor.js, etc.)
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        log('[Update Monitor] Dossier temporaire supprimé: ' + tmpDir);
      }
      
      log('[Update Monitor] Nettoyage terminé, arrêt du service');
      process.exit(0);
    } catch (error) {
      log('[Update Monitor] Erreur nettoyage: ' + error.message);
      process.exit(1);
    }
  }, 1000);
});

// Démarrer le serveur
const server = app.listen(PORT, () => {
  log('[Update Monitor] Service de monitoring démarré sur le port ' + PORT);
  log('[Update Monitor] Fichier de statut: ' + STATUS_FILE);
  log('[Update Monitor] PID du processus: ' + process.pid);
  log('[Update Monitor] Prêt à recevoir des requêtes');
});

// Gérer l'arrêt propre
process.on('SIGTERM', () => {
  log('[Update Monitor] SIGTERM reçu, arrêt...');
  server.close(() => {
    log('[Update Monitor] Serveur fermé suite à SIGTERM');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('[Update Monitor] SIGINT reçu, arrêt...');
  server.close(() => {
    log('[Update Monitor] Serveur fermé suite à SIGINT');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  log('[Update Monitor] Exception non gérée: ' + error.message);
  log('[Update Monitor] Stack: ' + error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  log('[Update Monitor] Promesse rejetée non gérée: ' + reason);
});
