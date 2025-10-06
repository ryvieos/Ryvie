const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Docker = require('dockerode');

const docker = new Docker();

// Configuration
const MANIFESTS_DIR = '/data/config/manifests';
const APPS_SOURCE_DIR = '/data/apps';

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

    for (const appId of appDirs) {
      try {
        const manifest = await getAppManifest(appId);
        if (manifest) {
          // Enrichir avec le statut Docker
          const dockerStatus = await getAppDockerStatus(appId);
          apps.push({
            ...manifest,
            ...dockerStatus
          });
        }
      } catch (error) {
        console.error(`[appManager] Erreur lors de la lecture du manifest de ${appId}:`, error.message);
      }
    }

    return apps;
  } catch (error) {
    console.error('[appManager] Erreur lors de la liste des apps:', error);
    return [];
  }
}

/**
 * Récupère le manifest d'une app
 */
async function getAppManifest(appId) {
  const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
  
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(manifestContent);
  } catch (error) {
    console.error(`[appManager] Erreur lors de la lecture du manifest ${appId}:`, error.message);
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
      if (healthStatus.includes('starting')) {
        return 'starting';
      }
      if (healthStatus.includes('healthy')) {
        return 'healthy';
      }
      if (healthStatus.includes('unhealthy')) {
        return 'unhealthy';
      }
    }
    
    // Pas de health check mais running depuis moins de 30s = starting
    if (status.includes('second') || status.includes('Less than')) {
      return 'starting';
    }
    
    // Running sans health check = healthy
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
  } catch (error) {
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
 * Démarre une app
 */
async function startApp(appId) {
  try {
    const manifest = await getAppManifest(appId);
    if (!manifest) {
      throw new Error(`App ${appId} non trouvée`);
    }

    const manifestDir = path.join(MANIFESTS_DIR, appId);

    // Si l'app a un script de lancement personnalisé
    if (manifest.customLaunchScript) {
      const scriptPath = path.join(manifestDir, manifest.customLaunchScript);
      if (fs.existsSync(scriptPath)) {
        console.log(`[appManager] Lancement de ${appId} avec script personnalisé`);
        execSync(`bash ${scriptPath}`, { stdio: 'inherit' });
        return { success: true, message: `${manifest.name} démarré avec succès` };
      }
    }

    // Sinon, utiliser docker-compose depuis le répertoire source
    const composePath = path.join(manifest.sourceDir, manifest.dockerComposePath);
    if (fs.existsSync(composePath)) {
      console.log(`[appManager] Démarrage de ${appId} avec docker-compose: ${composePath}`);
      const composeDir = path.dirname(composePath);
      const composeFile = path.basename(composePath);
      execSync(`cd ${composeDir} && docker compose -f ${composeFile} up -d`, { stdio: 'inherit' });
      return { success: true, message: `${manifest.name} démarré avec succès` };
    }

    throw new Error(`Aucune méthode de lancement trouvée pour ${appId}`);
  } catch (error) {
    console.error(`[appManager] Erreur lors du démarrage de ${appId}:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Arrête une app
 */
async function stopApp(appId) {
  try {
    const manifest = await getAppManifest(appId);
    if (!manifest) {
      throw new Error(`App ${appId} non trouvée`);
    }

    const composePath = path.join(manifest.sourceDir, manifest.dockerComposePath);

    if (fs.existsSync(composePath)) {
      console.log(`[appManager] Arrêt de ${appId} avec docker-compose`);
      const composeDir = path.dirname(composePath);
      const composeFile = path.basename(composePath);
      execSync(`cd ${composeDir} && docker compose -f ${composeFile} down`, { stdio: 'inherit' });
      return { success: true, message: `${manifest.name} arrêté avec succès` };
    }

    // Fallback: arrêter tous les conteneurs de l'app
    const containers = await docker.listContainers({ all: true });
    const appContainers = containers.filter(c => {
      const labels = c.Labels || {};
      const containerName = c.Names[0]?.replace('/', '') || '';
      return labels['ryvie.app.id'] === appId || containerName.startsWith(`app-${appId}`);
    });

    for (const container of appContainers) {
      if (container.State === 'running') {
        await docker.getContainer(container.Id).stop();
      }
    }

    return { success: true, message: `${manifest.name} arrêté avec succès` };
  } catch (error) {
    console.error(`[appManager] Erreur lors de l'arrêt de ${appId}:`, error.message);
    return { success: false, message: error.message };
  }
}

/**
 * Redémarre une app
 */
async function restartApp(appId) {
  try {
    await stopApp(appId);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Attendre 2s
    return await startApp(appId);
  } catch (error) {
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
  } catch (error) {
    console.error('[appManager] Erreur lors de la synchronisation:', error);
    return [];
  }
}

module.exports = {
  listInstalledApps,
  getAppManifest,
  getAppDockerStatus,
  startApp,
  stopApp,
  restartApp,
  getAppIcon,
  syncAppsWithDocker
};
