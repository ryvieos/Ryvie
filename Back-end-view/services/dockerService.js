const Docker = require('dockerode');
const os = require('os');

const docker = new Docker();

// Mapping for nicer display names if needed
const containerMapping = {
  rcloud: 'Cloud',
  portainer: 'Portainer',
  rtransfer: 'rTransfer',
  rdrop: 'rDrop',
  rpictures: 'rPictures',
};

function extractAppName(containerName) {
  if (containerName.startsWith('app-')) {
    const appNameWithSuffix = containerName.substring(4);
    const dashIndex = appNameWithSuffix.indexOf('-');
    if (dashIndex > 0) return appNameWithSuffix.substring(0, dashIndex);
    return appNameWithSuffix;
  }
  return null;
}

async function getAllContainers() {
  return new Promise((resolve, reject) => {
    docker.listContainers({ all: true }, (err, containers) => {
      if (err) return reject(err);
      resolve(containers);
    });
  });
}

async function getAppStatus() {
  const containers = await getAllContainers();
  const apps = {};

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

  return Object.values(apps).map((app) => ({
    id: app.id,
    name: app.name,
    status: app.running ? 'running' : 'stopped',
    progress: app.total > 0 ? Math.round((app.active / app.total) * 100) : 0,
    containersRunning: `${app.active}/${app.total}`,
    ports: app.ports.sort((a, b) => a - b),
    containers: app.containers,
  }));
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
      } catch (e) {
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
      } catch (e) {
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
    } catch (e) {
      failedCount++;
    }
  }
  return { success: failedCount === 0, message: `${restartedCount} conteneur(s) redémarré(s), ${failedCount} échec(s)`, appId };
}

module.exports = {
  getAllContainers,
  getAppStatus,
  startApp,
  stopApp,
  restartApp,
};
