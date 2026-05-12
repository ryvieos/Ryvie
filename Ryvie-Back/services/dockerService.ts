export {};
const Docker = require('dockerode');
const os = require('os');
const { execSync } = require('child_process');
const appManager = require('./appManagerService');

const docker = new Docker();

function isRWLayerError(error: any): boolean {
  const msg = error?.message || error?.stderr || String(error);
  return msg.includes('RWLayer') && msg.includes('unexpectedly nil');
}

function extractCorruptedContainerIds(errorOutput: string): string[] {
  const matches = errorOutput.match(/RWLayer of container ([a-f0-9]+)/g) || [];
  return matches.map(m => {
    const idMatch = m.match(/([a-f0-9]{12,})/);
    return idMatch ? idMatch[1] : '';
  }).filter(Boolean);
}

function removeCorruptedContainers(error: any): boolean {
  const msg = error?.message || error?.stderr || String(error);
  const ids = extractCorruptedContainerIds(msg);
  if (ids.length === 0) return false;

  for (const id of ids) {
    try {
      console.log(`[dockerService] 🗑️ Suppression du conteneur corrompu ${id.substring(0, 12)}...`);
      execSync(`docker rm -f ${id}`, { stdio: 'pipe', timeout: 30000 });
      console.log(`[dockerService] ✅ Conteneur ${id.substring(0, 12)} supprimé`);
    } catch (rmErr: any) {
      console.error(`[dockerService] ❌ Impossible de supprimer ${id.substring(0, 12)}:`, rmErr.message);
      return false;
    }
  }
  return true;
}

const MAX_COMPOSE_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

function sleepSync(ms: number): void {
  execSync(`sleep ${ms / 1000}`, { stdio: 'pipe' });
}

/**
 * Lance un docker compose up -d avec récupération automatique des conteneurs corrompus.
 * Gère le cas où plusieurs conteneurs du stack sont corrompus en cascade.
 * Stratégie : détection RWLayer → down + nettoyage complet → retry (jusqu'à MAX_COMPOSE_RETRIES)
 */
function composeUpWithRecovery(
  composeCmd: string,
  opts: { cwd: string; timeout?: number; label?: string },
): void {
  const label = opts.label || 'service';
  const execOpts = { stdio: 'pipe' as const, timeout: opts.timeout || 120000, cwd: opts.cwd };

  for (let attempt = 1; attempt <= MAX_COMPOSE_RETRIES; attempt++) {
    try {
      execSync(composeCmd, execOpts);
      if (attempt > 1) {
        console.log(`[dockerService] ✅ ${label} démarré après ${attempt} tentative(s)`);
      }
      return;
    } catch (err: any) {
      if (!isRWLayerError(err)) {
        throw err;
      }

      console.warn(`[dockerService] ⚠️ [${label}] Conteneur(s) corrompu(s) détecté(s) (tentative ${attempt}/${MAX_COMPOSE_RETRIES})`);
      removeCorruptedContainers(err);

      try {
        execSync(`docker compose down --remove-orphans`, { stdio: 'pipe', timeout: 60000, cwd: opts.cwd });
      } catch { /* le down peut échouer si déjà nettoyé */ }

      try {
        const staleContainers = execSync(
          `docker ps -a --filter "status=created" --filter "status=dead" --format "{{.ID}}\t{{.Names}}"`,
          { encoding: 'utf8', stdio: 'pipe', timeout: 10000, cwd: opts.cwd }
        ).trim();
        if (staleContainers) {
          for (const line of staleContainers.split('\n').filter(Boolean)) {
            const cid = line.split('\t')[0];
            try {
              execSync(`docker rm -f ${cid}`, { stdio: 'pipe', timeout: 15000 });
              console.log(`[dockerService] 🗑️ Conteneur stale ${cid.substring(0, 12)} supprimé`);
            } catch { /* best effort */ }
          }
        }
      } catch { /* best effort */ }

      if (attempt < MAX_COMPOSE_RETRIES) {
        console.log(`[dockerService] 🔄 [${label}] Nouvelle tentative dans ${RETRY_DELAY_MS / 1000}s...`);
        sleepSync(RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`[${label}] Échec du démarrage après ${MAX_COMPOSE_RETRIES} tentatives (conteneurs corrompus persistants)`);
}

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
        if (isRWLayerError(e)) {
          console.warn(`[dockerService] ⚠️ Conteneur ${c.Names[0]} corrompu, suppression et recréation via compose...`);
          try {
            execSync(`docker rm -f ${c.Id}`, { stdio: 'pipe', timeout: 30000 });
            execSync('docker compose up -d', { stdio: 'pipe', timeout: 120000, cwd: `/data/apps/${appId}` });
            startedCount++;
            continue;
          } catch { /* fallthrough */ }
        }
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
      if (isRWLayerError(e)) {
        console.warn(`[dockerService] ⚠️ Conteneur ${c.Names[0]} corrompu, suppression et recréation via compose...`);
        try {
          execSync(`docker rm -f ${c.Id}`, { stdio: 'pipe', timeout: 30000 });
          execSync('docker compose up -d', { stdio: 'pipe', timeout: 120000, cwd: `/data/apps/${appId}` });
          restartedCount++;
          continue;
        } catch { /* fallthrough */ }
      }
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
  isRWLayerError,
  removeCorruptedContainers,
  composeUpWithRecovery,
};
