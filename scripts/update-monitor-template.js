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
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
    }

    .spinner {
      width: 64px;
      height: 64px;
      border: 4px solid #f3f3f3;
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
      background: #e2e8f0;
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
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
    
    document.getElementById('version').textContent = 'Version cible: ' + targetVersion;

    let statusPollingInterval = null;
    let healthPollingInterval = null;
    let lastProgress = 5;
    let healthCheckStarted = false;

    function updateProgress(progress, message, step) {
      document.getElementById('progressBar').style.width = progress + '%';
      document.getElementById('progressText').textContent = progress + '%';
      document.getElementById('message').textContent = message;
      if (step) {
        document.getElementById('stepIndicator').textContent = step;
      }
    }

    function getServerUrl() {
      if (accessMode === 'private') {
        return window.location.protocol + '//' + window.location.hostname + ':3001';
      } else {
        return window.location.protocol + '//' + window.location.hostname;
      }
    }

    // Polling du fichier de statut
    function startStatusPolling() {
      statusPollingInterval = setInterval(async () => {
        try {
          // Lire le fichier de statut depuis le service de monitoring
          const response = await fetch('http://' + window.location.hostname + ':3005/status', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });

          if (response.ok) {
            const data = await response.json();
            
            if (data.step && data.message) {
              const newProgress = data.progress || lastProgress;
              if (newProgress >= lastProgress) {
                updateProgress(newProgress, data.message, data.step);
                lastProgress = newProgress;
              }

              // Si on atteint la phase de redémarrage
              if (data.step === 'restarting' || data.progress >= 90) {
                if (!healthCheckStarted) {
                  healthCheckStarted = true;
                  clearInterval(statusPollingInterval);
                  updateProgress(90, 'Redémarrage du système en cours...', 'Redémarrage');
                  setTimeout(startHealthPolling, 3000);
                }
              }
            }
          }
        } catch (error) {
          // Si le fichier n'est pas encore créé, continuer
          console.log('[Monitor] En attente du fichier de statut...');
        }
      }, 1000);
    }

    // Polling du health check
    function startHealthPolling() {
      let attempts = 0;
      const maxAttempts = 150;
      let consecutiveReady = 0;
      let progressValue = 90;

      updateProgress(90, 'Attente du redémarrage du serveur...', 'Health check');

      healthPollingInterval = setInterval(async () => {
        attempts++;

        if (progressValue < 99) {
          progressValue = Math.min(99, 90 + (attempts * 0.06));
          document.getElementById('progressBar').style.width = Math.floor(progressValue) + '%';
          document.getElementById('progressText').textContent = Math.floor(progressValue) + '%';
        }

        try {
          const serverUrl = getServerUrl();
          const response = await fetch(serverUrl + '/api/health', {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          });

          if (response.ok) {
            consecutiveReady++;
            updateProgress(Math.floor(progressValue), 
              'Serveur en ligne, vérification finale... (' + consecutiveReady + '/2)',
              'Vérification');

            if (consecutiveReady >= 2) {
              clearInterval(healthPollingInterval);
              
              document.getElementById('spinner').style.display = 'none';
              document.getElementById('successIcon').style.display = 'block';
              updateProgress(100, 'Mise à jour terminée avec succès!', 'Terminé');

              // Nettoyer le service de monitoring
              try {
                await fetch('http://' + window.location.hostname + ':3005/cleanup', {
                  method: 'POST'
                });
              } catch (e) {
                console.log('[Monitor] Cleanup appelé');
              }

              // Recharger vers l'URL de retour après 1.5s
              setTimeout(() => {
                window.location.href = window.location.protocol + '//' + window.location.hostname + 
                  (accessMode === 'private' ? ':3000' : '') + returnUrl;
              }, 1500);
            }
          } else {
            consecutiveReady = 0;
          }
        } catch (error) {
          consecutiveReady = 0;

          if (attempts < 30) {
            updateProgress(Math.floor(progressValue), 'Redémarrage en cours, veuillez patienter...', 'Redémarrage');
          } else if (attempts < 60) {
            updateProgress(Math.floor(progressValue), 'Installation des dépendances...', 'Installation');
          } else if (attempts < 90) {
            updateProgress(Math.floor(progressValue), 'Compilation du frontend...', 'Compilation');
          } else {
            updateProgress(Math.floor(progressValue), 'Le serveur prend plus de temps que prévu...', 'Attente');
          }

          if (attempts >= maxAttempts) {
            clearInterval(healthPollingInterval);
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('errorIcon').style.display = 'block';
            updateProgress(Math.floor(progressValue), 
              'Le redémarrage prend plus de temps que prévu. Veuillez rafraîchir la page manuellement.',
              'Erreur');
          }
        }
      }, 2000);
    }

    // Démarrer le polling
    startStatusPolling();
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
  console.log('[Update Monitor] Nettoyage demandé');
  res.json({ success: true });
  
  setTimeout(() => {
    try {
      // Supprimer le fichier de statut
      if (fs.existsSync(STATUS_FILE)) {
        fs.unlinkSync(STATUS_FILE);
      }
      
      // Supprimer le dossier temporaire
      const tmpDir = '/tmp/ryvie-update-monitor';
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      
      console.log('[Update Monitor] Nettoyage terminé, arrêt du service');
      process.exit(0);
    } catch (error) {
      console.error('[Update Monitor] Erreur nettoyage:', error);
      process.exit(1);
    }
  }, 1000);
});

// Démarrer le serveur
const server = app.listen(PORT, () => {
  console.log('[Update Monitor] Service de monitoring démarré sur le port ' + PORT);
  console.log('[Update Monitor] Fichier de statut: ' + STATUS_FILE);
});

// Gérer l'arrêt propre
process.on('SIGTERM', () => {
  console.log('[Update Monitor] SIGTERM reçu, arrêt...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Update Monitor] SIGINT reçu, arrêt...');
  server.close(() => {
    process.exit(0);
  });
});
