/**
 * Configuration dynamique des applications basée sur les manifests + icônes locales
 */

import axios from '../utils/setupAxios';
const { getServerUrl } = require('./urls');

// Import explicite des icônes critiques de la taskbar (évite les soucis de bundling cross-plateformes)
import taskSettings from '../icons/task-settings.svg';
import taskAppStore from '../icons/task-AppStore.svg';
import taskTransfer from '../icons/task-transfer.svg';
import taskUser from '../icons/task-user.svg';

// Fonction pour importer toutes les images du dossier icons
const importAll = (r) => {
  let images = {};
  r.keys().forEach((item) => {
    images[item.replace('./', '')] = r(item);
  });
  return images;
};

// Importer toutes les icônes
const images = importAll(require.context('../icons', false, /\.(png|jpe?g|svg)$/));

// Surcharger avec des imports explicites (assure la bonne résolution des URLs)
images['task-settings.svg'] = (taskSettings && taskSettings.default) ? taskSettings.default : taskSettings;
images['task-AppStore.svg'] = (taskAppStore && taskAppStore.default) ? taskAppStore.default : taskAppStore;
images['task-transfer.svg'] = (taskTransfer && taskTransfer.default) ? taskTransfer.default : taskTransfer;
images['task-user.svg'] = (taskUser && taskUser.default) ? taskUser.default : taskUser;

// Fonction pour extraire le nom de l'app depuis le nom du fichier
const extractAppName = (filename) => {
  // Pour les icônes app-*, extraire le nom après "app-"
  if (filename.startsWith('app-')) {
    return filename.replace('app-', '').replace(/\.(png|jpe?g|svg)$/i, '');
  }
  // Pour les icônes task-*, extraire le nom après "task-"
  if (filename.startsWith('task-')) {
    return filename.replace('task-', '').replace(/\.(png|jpe?g|svg)$/i, '');
  }
  // Pour les autres, utiliser le nom complet sans extension
  return filename.replace(/\.(png|jpe?g|svg)$/i, '');
};

// Fonction pour générer la configuration des applications
const generateAppConfig = () => {
  const config = {};
  const availableIcons = Object.keys(images);
  
  // Traiter les icônes d'applications (app-*)
  const appIcons = availableIcons.filter(icon => icon.startsWith('app-'));
  appIcons.forEach(iconFile => {
    const appName = extractAppName(iconFile);
    const urlKey = appName.toUpperCase();
    
    config[iconFile] = {
      name: appName,
      urlKey: urlKey,
      showStatus: true,
      isTaskbarApp: false,
      containerName: appName.toLowerCase(),
    };
    
    // Configurations spéciales pour certaines apps
    if (appName.toLowerCase() === 'appstore') {
      config[iconFile].showStatus = false;
      // Ne pas mettre l'app-AppStore dans la taskbar car on a déjà task-AppStore
      config[iconFile].isTaskbarApp = false;
    }
    
    if (appName.toLowerCase() === 'rtransfer') {
      config[iconFile].useDirectWindow = true;
    }
  });
  
  // Traiter les icônes de la taskbar (task-*)
  const taskIcons = availableIcons.filter(icon => icon.startsWith('task-'));
  taskIcons.forEach(iconFile => {
    const appName = extractAppName(iconFile);
    
    config[iconFile] = {
      name: appName.charAt(0).toUpperCase() + appName.slice(1),
      urlKey: '',
      showStatus: false,
      isTaskbarApp: true,
    };
    
    // Définir les routes pour les icônes de tâches
    switch(appName.toLowerCase()) {
      case 'user':
        config[iconFile].route = '/user';
        break;
      case 'transfer':
        config[iconFile].route = '/userlogin';
        break;
      case 'settings':
        config[iconFile].route = '/settings';
        break;
      case 'appstore':
        config[iconFile].urlKey = 'APPSTORE';
        config[iconFile].route = null; // laisser passer par handleClick pour afficher un overlay
        break;
    }
  });
  
  // N'utilise plus les icônes sans préfixe comme demandé
  
  return config;
};

// Fonction pour générer les zones par défaut dynamiquement
const generateDefaultZones = () => {
  const availableIcons = Object.keys(images);
  // N'utiliser que les icônes avec préfixe app-
  const appIcons = availableIcons.filter(icon => icon.startsWith('app-'));
  
  const zones = {
    left: [],
    right: [],
    bottom1: [],
    bottom2: [],
    bottom3: [],
    bottom4: [],
    bottom5: [],
    bottom6: [],
    bottom7: [],
    bottom8: [],
    bottom9: [],
    bottom10: [],
  };
  
  // Placer les icônes d'applications dans les zones
  if (appIcons.length > 0) {
    // AppStore en haut à gauche si disponible
    const appStore = appIcons.find(icon => icon.includes('AppStore'));
    if (appStore) zones.left = [appStore];
    
    // Portainer en haut à droite si disponible
    const portainer = appIcons.find(icon => icon.includes('Portainer'));
    if (portainer) zones.right = [portainer];
    
    // Distribuer les autres apps dans les zones du bas
    const otherApps = appIcons.filter(icon => 
      !icon.includes('AppStore') && !icon.includes('Portainer')
    );
    
    const bottomZones = ['bottom1', 'bottom2', 'bottom3', 'bottom4', 'bottom5'];
    otherApps.forEach((app, index) => {
      if (index < bottomZones.length) {
        zones[bottomZones[index]] = [app];
      }
    });
  }
  
  return zones;
};

/**
 * Charge les apps depuis l'API avec manifests
 */
const fetchAppsFromManifests = async (accessMode) => {
  try {
    const serverUrl = getServerUrl(accessMode);
    console.log('[appConfig] Chargement des apps depuis manifests:', serverUrl);
    
    const response = await axios.get(`${serverUrl}/api/apps/manifests`);
    const apps = response.data;
    
    console.log('[appConfig] Apps chargées depuis manifests:', apps.length);
    return apps;
  } catch (error) {
    console.error('[appConfig] Erreur lors du chargement des manifests:', error.message);
    return [];
  }
};

/**
 * Génère la config des apps depuis les manifests
 */
const generateAppConfigFromManifests = async (accessMode) => {
  const config = {};
  
  try {
    const apps = await fetchAppsFromManifests(accessMode);
    const serverUrl = getServerUrl(accessMode);
    
    apps.forEach(app => {
      const iconId = `app-${app.id}`;
      
      // Ajouter un timestamp pour éviter le cache du navigateur
      const iconUrl = `${serverUrl}/api/apps/${app.id}/icon?t=${Date.now()}`;
      
      config[iconId] = {
        id: app.id,
        name: app.name,
        description: app.description,
        category: app.category,
        icon: iconUrl, // URL de l'icône servie par le backend avec cache-busting
        urlKey: app.id.toUpperCase(),
        showStatus: true, // Afficher le badge de statut
        isTaskbarApp: false,
        containerName: app.id,
        mainPort: app.mainPort,
        ports: app.ports
      };
    });
    
    console.log('[appConfig] Config générée depuis manifests:', Object.keys(config).length, 'apps');
  } catch (error) {
    console.error('[appConfig] Erreur lors de la génération de la config:', error);
  }
  
  // Ajouter les icônes de la taskbar (toujours locales)
  const taskIcons = Object.keys(images).filter(icon => icon.startsWith('task-'));
  taskIcons.forEach(iconFile => {
    const appName = extractAppName(iconFile);
    
    config[iconFile] = {
      name: appName.charAt(0).toUpperCase() + appName.slice(1),
      urlKey: '',
      showStatus: false,
      isTaskbarApp: true,
    };
    
    // Définir les routes pour les icônes de tâches
    switch(appName.toLowerCase()) {
      case 'user':
        config[iconFile].route = '/user';
        break;
      case 'transfer':
        config[iconFile].route = '/userlogin';
        break;
      case 'settings':
        config[iconFile].route = '/settings';
        break;
      case 'appstore':
        config[iconFile].urlKey = 'APPSTORE';
        config[iconFile].route = null;
        break;
    }
  });
  
  return config;
};

/**
 * Génère les zones par défaut depuis les manifests
 */
const generateDefaultZonesFromManifests = async (accessMode) => {
  const zones = {
    left: [],
    right: [],
    bottom1: [],
    bottom2: [],
    bottom3: [],
    bottom4: [],
    bottom5: [],
    bottom6: [],
    bottom7: [],
    bottom8: [],
    bottom9: [],
    bottom10: [],
  };
  
  try {
    const apps = await fetchAppsFromManifests(accessMode);
    
    if (apps.length > 0) {
      // AppStore en haut à gauche si disponible
      const appStore = apps.find(app => app.id.toLowerCase().includes('appstore'));
      if (appStore) zones.left = [`app-${appStore.id}`];
      
      // Portainer en haut à droite si disponible
      const portainer = apps.find(app => app.id.toLowerCase().includes('portainer'));
      if (portainer) zones.right = [`app-${portainer.id}`];
      
      // Distribuer les autres apps dans les zones du bas
      const otherApps = apps.filter(app => 
        !app.id.toLowerCase().includes('appstore') && 
        !app.id.toLowerCase().includes('portainer')
      );
      
      const bottomZones = ['bottom1', 'bottom2', 'bottom3', 'bottom4', 'bottom5'];
      otherApps.forEach((app, index) => {
        if (index < bottomZones.length) {
          zones[bottomZones[index]] = [`app-${app.id}`];
        }
      });
    }
  } catch (error) {
    console.error('[appConfig] Erreur lors de la génération des zones:', error);
  }
  
  return zones;
};

// Exporter la configuration et les fonctions (ESM)
export { 
  generateAppConfig, 
  generateDefaultZones, 
  generateAppConfigFromManifests,
  generateDefaultZonesFromManifests,
  fetchAppsFromManifests,
  images, 
  extractAppName 
};
