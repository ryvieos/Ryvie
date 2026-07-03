const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const Docker = require('dockerode');
const { MANIFESTS_DIR, APPS_DIR } = require('../config/paths');
const { getLocalIP } = require('../utils/network');

const docker = new Docker();

// Configuration
const APPS_SOURCE_DIR = APPS_DIR;

/**
 * Liste toutes les apps installées (avec manifests)
 */
async function listInstalledApps() {
  try {
    if (!fs.existsSync(MANIFESTS_DIR)) {
      console.log(`[appManager] Dossier ${MANIFESTS_DIR} n'existe pas encore`);
      return [];
    }

    const appDirs = fs.readdirSync(MANIFESTS_DIR, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    const apps = [];

    for (const appDirName of appDirs) {
      try {
        const manifest = await getAppManifest(appDirName);
        if (manifest) {
          // Enrichir avec le statut Docker
          const dockerStatus = await getAppDockerStatus(manifest.id);
          apps.push({
            ...manifest,
            ...dockerStatus
          });
        }
      } catch (error: any) {
        console.error(`[appManager] Erreur lors de la lecture du manifest de ${appDirName}:`, error.message);
      }
    }

    return apps;
  } catch (error: any) {
    console.error('[appManager] Erreur lors de la liste des apps:', error);
    return [];
  }
}

/**
 * Récupère le manifest d'une app
 * @param appDirName - Le nom du dossier dans /data/config/manifests/ (peut différer de l'appId)
 */
async function getAppManifest(appDirName) {
  const manifestPath = path.join(MANIFESTS_DIR, appDirName, 'manifest.json');
  
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    
    // Lire également le ryvie-app.yml pour obtenir la config proxy
    // Utiliser sourceDir du manifest car le nom du dossier peut différer
    const appSourceDir = manifest.sourceDir || path.join(APPS_SOURCE_DIR, appDirName);
    const ryvieAppPath = path.join(appSourceDir, 'ryvie-app.yml');
    
    if (fs.existsSync(ryvieAppPath)) {
      try {
        const yaml = require('yaml');
        const ryvieAppContent = fs.readFileSync(ryvieAppPath, 'utf8');
        const ryvieAppConfig = yaml.parse(ryvieAppContent);
        
        // Ajouter les infos proxy au manifest si elles existent
        if (ryvieAppConfig && ryvieAppConfig.proxy) {
          manifest.proxy = ryvieAppConfig.proxy;
          manifest.requiresHttps = ryvieAppConfig.proxy.https === true;
        }

        // Recopier la recette de gestion des comptes (bloc `accounts:`),
        // utilisée par appAccountsService pour lister / réinitialiser les mdp.
        if (ryvieAppConfig && ryvieAppConfig.accounts) {
          manifest.accounts = ryvieAppConfig.accounts;
        }

        // Recopier le bloc `ai:` (mapping config IA centrale → variables d'env de
        // l'app), utilisé par aiService pour connecter l'app au proxy LiteLLM.
        if (ryvieAppConfig && ryvieAppConfig.ai) {
          manifest.ai = ryvieAppConfig.ai;
        }

        // Recopier le bloc `configEditor:` (fichiers de config éditables depuis
        // l'UI Ryvie), utilisé par configEditorService pour l'édition zéro-terminal.
        if (ryvieAppConfig && ryvieAppConfig.configEditor) {
          manifest.configEditor = ryvieAppConfig.configEditor;
        }
      } catch (yamlError: any) {
        console.warn(`[appManager] Impossible de lire ryvie-app.yml pour ${appDirName}:`, yamlError.message);
      }
    } else {
      console.log(`[appManager] Fichier ryvie-app.yml non trouvé: ${ryvieAppPath}`);
    }
    
    return manifest;
  } catch (error: any) {
    console.error(`[appManager] Erreur lors de la lecture du manifest ${appDirName}:`, error.message);
    return null;
  }
}

/**
 * Containers temporaires à ignorer (ne comptent pas dans le statut)
 */
const TEMPORARY_CONTAINERS = [
  'create-user',
  'migration',
  'init',
  'setup',
  'seed'
];

/**
 * Vérifie si un container est temporaire
 */
function isTemporaryContainer(containerName) {
  return TEMPORARY_CONTAINERS.some(pattern => containerName.includes(pattern));
}

/**
 * Détermine l'état d'un container (stopped, starting, healthy, unhealthy)
 */
function getContainerState(container) {
  const state = container.State;
  const status = container.Status || '';
  
  // Container arrêté
  if (state === 'exited' || state === 'dead') {
    return 'stopped';
  }
  
  // Container en cours de démarrage
  if (state === 'created' || state === 'restarting') {
    return 'starting';
  }
  
  // Container running - vérifier le health check
  if (state === 'running') {
    // Vérifier si le container a un health check
    const healthStatus = container.Status?.match(/\(([^)]+)\)/)?.[1];
    
    if (healthStatus) {
      // Le container a un health check configuré
      if (healthStatus.includes('starting')) {
        return 'starting';
      }
      if (healthStatus.includes('healthy')) {
        return 'healthy';
      }
      if (healthStatus.includes('unhealthy')) {
        return 'unhealthy';
      }
    } else {
      // Pas de health check configuré
      // Si running depuis moins de 30s, considérer comme "starting"
      if (status.includes('second') || status.includes('Less than')) {
        return 'starting';
      }
      // Sinon, considérer comme healthy (le container tourne correctement)
      return 'healthy';
    }
    
    // Fallback: running = healthy
    return 'healthy';
  }
  
  return 'unknown';
}

/**
 * Récupère le statut Docker d'une app
 */
async function getAppDockerStatus(appId) {
  try {
    const containers = await docker.listContainers({ all: true });
    
    // Filtrer les conteneurs qui appartiennent à cette app
    const appContainers = containers.filter(container => {
      const labels = container.Labels || {};
      if (labels['ryvie.app.id'] === appId) {
        return true;
      }
      
      const containerName = container.Names[0]?.replace('/', '') || '';
      
      // Ignorer les containers temporaires
      if (isTemporaryContainer(containerName)) {
        return false;
      }
      
      return containerName.startsWith(`app-${appId}`);
    });

    // Compter les containers par état
    const containerStates = {
      stopped: 0,
      starting: 0,
      healthy: 0,
      unhealthy: 0
    };
    
    const containerDetails = appContainers.map(c => {
      const containerName = c.Names[0]?.replace('/', '');
      const containerState = getContainerState(c);
      containerStates[containerState]++;
      
      return {
        id: c.Id,
        name: containerName,
        state: c.State,
        status: c.Status,
        detailedState: containerState
      };
    });

    const total = appContainers.length;
    const running = containerStates.healthy + containerStates.unhealthy + containerStates.starting;
    
    // Déterminer le statut global de l'app
    let globalStatus = 'stopped';
    if (containerStates.healthy === total && total > 0) {
      globalStatus = 'running'; // Tous les containers sont healthy
    } else if (containerStates.starting > 0) {
      globalStatus = 'starting'; // Au moins un container démarre
    } else if (running > 0) {
      globalStatus = 'partial'; // Certains containers running mais pas tous healthy
    } else if (containerStates.stopped === total && total > 0) {
      globalStatus = 'stopped'; // Tous arrêtés
    }
    
    // Extraire les ports
    const ports = [];
    appContainers.forEach(container => {
      if (container.Ports) {
        container.Ports.forEach(port => {
          if (port.PublicPort && !ports.includes(port.PublicPort)) {
            ports.push(port.PublicPort);
          }
        });
      }
    });

    return {
      status: globalStatus,
      containersTotal: total,
      containersRunning: running,
      containersHealthy: containerStates.healthy,
      containersStarting: containerStates.starting,
      containersUnhealthy: containerStates.unhealthy,
      containersStopped: containerStates.stopped,
      progress: total > 0 ? Math.round((containerStates.healthy / total) * 100) : 0,
      ports: ports.sort((a, b) => a - b),
      containers: containerDetails
    };
  } catch (error: any) {
    console.error(`[appManager] Erreur lors de la récupération du statut Docker de ${appId}:`, error.message);
    return {
      status: 'unknown',
      containersTotal: 0,
      containersRunning: 0,
      containersHealthy: 0,
      containersStarting: 0,
      containersUnhealthy: 0,
      containersStopped: 0,
      progress: 0,
      ports: [],
      containers: []
    };
  }
}

/**
 * Démarre une app (démarre tous les containers app-{appId}-*)
 */
async function startApp(appId) {
  try {
    const manifest = await getAppManifest(appId);
    if (!manifest) {
      throw new Error(`App ${appId} non trouvée`);
    }

    // Le bouton "Démarrer" REBUILD l'app via `docker compose up -d --build` :
    // au-delà d'un simple démarrage, cela relance la construction des images, ce qui
    // permet de réparer une app cassée (image corrompue, build interrompu, conteneurs
    // bloqués en "created"). Si aucun docker-compose n'est trouvé, on retombe sur le
    // démarrage simple des conteneurs existants (cf. plus bas).
    const appDir = manifest.sourceDir || path.join(APPS_SOURCE_DIR, appId);
    const composeRel = manifest.dockerComposePath || 'docker-compose.yml';
    const workingDir = composeRel.includes('/')
      ? path.join(appDir, path.dirname(composeRel))
      : appDir;
    const composeFileName = path.basename(composeRel);
    const composeFullPath = path.join(workingDir, composeFileName);

    if (fs.existsSync(composeFullPath)) {
      // S'assurer que le .env existe (LOCAL_IP), comme lors de l'installation.
      try {
        const envPath = path.join(appDir, '.env');
        if (!fs.existsSync(envPath)) {
          const localIP = getLocalIP();
          fs.writeFileSync(
            envPath,
            `# Fichier .env généré automatiquement par Ryvie\n# IP locale du serveur\nLOCAL_IP=${localIP}\n`
          );
          console.log(`[appManager] ✅ .env recréé pour ${appId} (LOCAL_IP=${localIP})`);
        }
      } catch (envError: any) {
        console.warn(`[appManager] ⚠️ Impossible de garantir le .env de ${appId}:`, envError.message);
      }

      console.log(`[appManager] 🔨 Rebuild + démarrage de ${appId} (docker compose -f ${composeFileName} up -d --build)...`);

      // Pause du monitoring realtime pendant l'opération Docker (cohérent avec l'install) :
      // évite les requêtes Docker concurrentes qui provoquent des races pendant le up.
      const realtimeService = (global as any).realtimeService;
      if (realtimeService?.pauseBroadcast) {
        realtimeService.pauseBroadcast();
      }

      try {
        // exec async (et non execSync) pour NE PAS bloquer l'event loop du serveur
        // pendant le build, qui peut durer plusieurs minutes.
        await execAsync(`docker compose -f ${composeFileName} up -d --build`, {
          cwd: workingDir,
          timeout: 300000,            // 5 minutes max
          maxBuffer: 1024 * 1024 * 50 // 50 Mo de logs de build
        });
        console.log(`[appManager] ✅ ${appId} reconstruit et démarré`);
      } finally {
        if (realtimeService?.resumeBroadcast) {
          realtimeService.resumeBroadcast();
        }
      }

      // Invalider le cache de statut pour refléter l'état immédiatement (require paresseux
      // car dockerService dépend déjà de ce module → évite un cycle de require).
      try {
        const dockerService = require('./dockerService');
        if (dockerService.clearAppStatusCache) {
          dockerService.clearAppStatusCache();
        }
      } catch {}

      return {
        success: true,
        message: `${manifest.name} reconstruit et démarré`,
        rebuilt: true
      };
    }

    // ---- Fallback : aucun docker-compose → démarrage simple des conteneurs existants ----
    console.log(`[appManager] ℹ️ Pas de docker-compose pour ${appId}, démarrage simple des conteneurs (app-${appId}-*)`);

    const containers = await docker.listContainers({ all: true });
    const appContainers = containers.filter(c => {
      const containerName = c.Names[0]?.replace('/', '') || '';
      // Ignorer les containers temporaires
      if (isTemporaryContainer(containerName)) {
        return false;
      }
      return containerName === `app-${appId}` || containerName.startsWith(`app-${appId}-`);
    });

    console.log(`[appManager] ${appContainers.length} container(s) trouvé(s) pour ${appId}`);

    let startedCount = 0;
    let errorCount = 0;

    for (const container of appContainers) {
      const containerName = container.Names[0]?.replace('/', '');
      if (container.State !== 'running') {
        try {
          console.log(`[appManager] Démarrage du container ${containerName}...`);
          await docker.getContainer(container.Id).start();
          startedCount++;
          console.log(`[appManager] ✓ Container ${containerName} démarré`);
        } catch (startError: any) {
          console.error(`[appManager] Erreur lors du démarrage de ${containerName}:`, startError.message);
          errorCount++;
        }
      } else {
        console.log(`[appManager] Container ${containerName} déjà démarré`);
      }
    }

    const message = errorCount > 0
      ? `${manifest.name} démarré partiellement (${startedCount} container(s), ${errorCount} erreur(s))`
      : `${manifest.name} démarré avec succès (${startedCount} container(s))`;

    return {
      success: errorCount === 0,
      message: message,
      startedCount,
      errorCount
    };
  } catch (error: any) {
    console.error(`[appManager] Erreur lors du démarrage de ${appId}:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Arrête une app (arrête tous les containers app-{appId}-*)
 */
async function stopApp(appId) {
  try {
    const manifest = await getAppManifest(appId);
    if (!manifest) {
      throw new Error(`App ${appId} non trouvée`);
    }

    console.log(`[appManager] Arrêt de tous les containers de ${appId} (app-${appId}-*)`);
    
    const containers = await docker.listContainers({ all: true });
    const appContainers = containers.filter(c => {
      const containerName = c.Names[0]?.replace('/', '') || '';
      // Ignorer les containers temporaires
      if (isTemporaryContainer(containerName)) {
        return false;
      }
      return containerName === `app-${appId}` || containerName.startsWith(`app-${appId}-`);
    });

    console.log(`[appManager] ${appContainers.length} container(s) trouvé(s) pour ${appId}`);
    
    let stoppedCount = 0;
    let errorCount = 0;
    
    for (const container of appContainers) {
      const containerName = container.Names[0]?.replace('/', '');
      if (container.State === 'running') {
        try {
          console.log(`[appManager] Arrêt du container ${containerName}...`);
          
          // Timeout de 5 secondes avant SIGKILL (suffisant pour la plupart des apps)
          await docker.getContainer(container.Id).stop({ t: 5 });
          stoppedCount++;
          console.log(`[appManager] ✓ Container ${containerName} arrêté`);
          
        } catch (stopError: any) {
          console.error(`[appManager] Erreur lors de l'arrêt de ${containerName}:`, stopError.message);
          
          // Si l'arrêt normal échoue, tenter un kill forcé
          try {
            console.log(`[appManager] Tentative de kill forcé sur ${containerName}...`);
            await docker.getContainer(container.Id).kill();
            stoppedCount++;
            console.log(`[appManager] ✓ Container ${containerName} killé avec succès`);
          } catch (killError: any) {
            console.error(`[appManager] Échec du kill forcé sur ${containerName}:`, killError.message);
            errorCount++;
          }
        }
      } else {
        console.log(`[appManager] Container ${containerName} déjà arrêté`);
      }
    }
    
    const message = errorCount > 0 
      ? `${manifest.name} arrêté partiellement (${stoppedCount} container(s), ${errorCount} erreur(s))`
      : `${manifest.name} arrêté avec succès (${stoppedCount} container(s))`;
    
    return { 
      success: errorCount === 0, 
      message: message,
      stoppedCount,
      errorCount
    };
  } catch (error: any) {
    console.error(`[appManager] Erreur lors de l'arrêt de ${appId}:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Redémarre une app
 */
async function restartApp(appId) {
  try {
    console.log(`[appManager] Redémarrage de ${appId}...`);
    
    // Arrêter l'app
    const stopResult = await stopApp(appId);
    if (!stopResult.success) {
      console.warn(`[appManager] Arrêt partiel de ${appId}, poursuite du redémarrage...`);
    }
    
    // Attendre 5 secondes pour que les conteneurs soient complètement arrêtés
    console.log(`[appManager] Attente de 5 secondes...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Redémarrer l'app
    const startResult = await startApp(appId);
    
    return {
      success: startResult.success,
      message: `Redémarrage: ${stopResult.message} puis ${startResult.message}`,
      stopResult,
      startResult
    };
  } catch (error: any) {
    console.error(`[appManager] Erreur lors du redémarrage de ${appId}:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Récupère l'icône d'une app
 */
function getAppIcon(appId) {
  const manifestDir = path.join(MANIFESTS_DIR, appId);
  const possibleIcons = ['icon.svg', 'icon.png', 'icon.jpg', 'icon.jpeg'];
  
  for (const iconName of possibleIcons) {
    const iconPath = path.join(manifestDir, iconName);
    if (fs.existsSync(iconPath)) {
      return iconPath;
    }
  }
  
  return null;
}

/**
 * Synchronise les apps avec Docker (détecte les changements)
 */
async function syncAppsWithDocker() {
  try {
    const installedApps = await listInstalledApps();
    console.log(`[appManager] ${installedApps.length} apps installées détectées`);
    return installedApps;
  } catch (error: any) {
    console.error('[appManager] Erreur lors de la synchronisation:', error);
    return [];
  }
}

export = {
  listInstalledApps,
  getAppManifest,
  getAppDockerStatus,
  startApp,
  stopApp,
  restartApp,
  getAppIcon,
  syncAppsWithDocker
};
