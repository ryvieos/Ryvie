export {};
const Docker = require('dockerode');
const os = require('os');
const appManager = require('./appManagerService');

const docker = new Docker();

// Container name mapping for display
const containerMapping: Record<string, string> = {
  'ryvie-backend': 'Ryvie Backend',
  'ryvie-frontend': 'Ryvie Frontend',
  'openldap': 'OpenLDAP',
  'redis': 'Redis',
};

// Cache pour getAppStatus (5 secondes)
let appStatusCache: any = null;
let appStatusCacheTime = 0;
const APP_STATUS_CACHE_DURATION = 5000; // 5 secondes

function extractAppName(containerName) {
  if (containerName.startsWith('app-')) {
    const appNameWithSuffix = containerName.substring(4);
    const dashIndex = appNameWithSuffix.indexOf('-');
    if (dashIndex > 0) return appNameWithSuffix.substring(0, dashIndex);
    return appNameWithSuffix;
  }
  return null;
}

async function getAllContainers(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    docker.listContainers({ all: true }, (err: any, containers: any[]) => {
      if (err) return reject(err);
      resolve(containers);
    });
  });
}

async function getAppStatus() {
  // Retourner le cache si valide
  const now = Date.now();
  if (appStatusCache && (now - appStatusCacheTime) < APP_STATUS_CACHE_DURATION) {
    return appStatusCache;
  }
  
  let result;
  
  try {
    // Essayer d'abord d'utiliser le nouveau système avec manifests
    const installedApps = await appManager.listInstalledApps();
    
    if (installedApps && installedApps.length > 0) {
      console.log('[dockerService] Utilisation du système de manifests');
      result = installedApps.map(app => ({
        id: app.id,
        name: app.name,
        status: app.status,
        progress: app.progress,
        containersRunning: `${app.containersRunning}/${app.containersTotal}`,
        ports: app.ports,
        mainPort: app.mainPort,
        containers: app.containers,
        icon: app.icon,
        category: app.category,
        description: app.description,
        requiresHttps: app.requiresHttps || false,
        proxy: app.proxy
      }));
      
      // Mettre en cache
      appStatusCache = result;
      appStatusCacheTime = Date.now();
      return result;
    }
  } catch (error: any) {
    console.log('[dockerService] Erreur avec appManager, fallback sur ancien système:', error.message);
  }

  // Fallback: ancien système si pas de manifests
  console.log('[dockerService] Utilisation de l\'ancien système (sans manifests)');
  const containers = await getAllContainers();
  const apps: Record<string, any> = {};

  containers.forEach((container) => {
    const containerName = container.Names[0].replace('/', '');
    const appName = extractAppName(containerName);
    if (!appName) return;

    if (!apps[appName]) {
      const displayName = containerMapping[appName] || appName;
      apps[appName] = {
        id: `app-${appName}`,
        name: displayName,
        containers: [],
        running: false,
        total: 0,
        active: 0,
        ports: [],
      };
    }

    apps[appName].total++;
    if (container.State === 'running') {
      apps[appName].active++;
      if (container.Ports && container.Ports.length > 0) {
        container.Ports.forEach((port) => {
          if (port.PublicPort && !apps[appName].ports.includes(port.PublicPort)) {
            apps[appName].ports.push(port.PublicPort);
          }
        });
      }
    }

    apps[appName].containers.push({
      id: container.Id,
      name: containerName,
      state: container.State,
      status: container.Status,
    });
  });

  for (const appName in apps) {
    apps[appName].running = apps[appName].active > 0;
  }

  result = Object.values(apps).map((app) => ({
    id: app.id,
    name: app.name,
    status: app.running ? 'running' : 'stopped',
    progress: app.total > 0 ? Math.round((app.active / app.total) * 100) : 0,
    containersTotal: app.total,
    containersRunning: app.active,
    containersHealthy: app.active, // Approximation pour l'ancien système
    containersStarting: 0,
    containersUnhealthy: 0,
    containersStopped: app.total - app.active,
    ports: app.ports.sort((a, b) => a - b),
    containers: app.containers,
  }));
  
  // Mettre en cache
  appStatusCache = result;
  appStatusCacheTime = Date.now();
  
  return result;
}

async function startApp(appId) {
  const containers = await getAllContainers();
  const appContainers = containers.filter((c) => c.Names[0].replace('/', '').startsWith(appId));
  if (appContainers.length === 0) throw new Error(`Aucun conteneur trouvé pour l'application ${appId}`);

  let startedCount = 0;
  let failedCount = 0;
  for (const c of appContainers) {
    if (c.State !== 'running') {
      try {
        await docker.getContainer(c.Id).start();
        startedCount++;
      } catch (e: any) {
        failedCount++;
      }
    }
  }
  return { success: failedCount === 0, message: `${startedCount} conteneur(s) démarré(s), ${failedCount} échec(s)`, appId };
}

async function stopApp(appId) {
  const containers = await getAllContainers();
  const appContainers = containers.filter((c) => c.Names[0].replace('/', '').startsWith(appId));
  if (appContainers.length === 0) throw new Error(`Aucun conteneur trouvé pour l'application ${appId}`);

  let stoppedCount = 0;
  let failedCount = 0;
  for (const c of appContainers) {
    if (c.State === 'running') {
      try {
        await docker.getContainer(c.Id).stop();
        stoppedCount++;
      } catch (e: any) {
        failedCount++;
      }
    }
  }
  return { success: failedCount === 0, message: `${stoppedCount} conteneur(s) arrêté(s), ${failedCount} échec(s)`, appId };
}

async function restartApp(appId) {
  const containers = await getAllContainers();
  const appContainers = containers.filter((c) => c.Names[0].replace('/', '').startsWith(appId));
  if (appContainers.length === 0) throw new Error(`Aucun conteneur trouvé pour l'application ${appId}`);

  let restartedCount = 0;
  let failedCount = 0;
  for (const c of appContainers) {
    try {
      const cont = docker.getContainer(c.Id);
      if (c.State === 'running') await cont.restart();
      else await cont.start();
      restartedCount++;
    } catch (e: any) {
      failedCount++;
    }
  }
  return { success: failedCount === 0, message: `${restartedCount} conteneur(s) redémarré(s), ${failedCount} échec(s)`, appId };
}

// Fonction pour invalider le cache manuellement
function clearAppStatusCache() {
  appStatusCache = null;
  appStatusCacheTime = 0;
  console.log('[dockerService] Cache des statuts invalidé');
}

export = {
  getAllContainers,
  getAppStatus,
  startApp,
  stopApp,
  restartApp,
  clearAppStatusCache,
};
