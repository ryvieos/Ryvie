/**
 * Configuration dynamique des applications basée sur les icônes disponibles
 */

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
      containerName: `app-${appName.toLowerCase()}`,
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
        config[iconFile].route = null;
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

// Exporter la configuration et les fonctions
module.exports = {
  generateAppConfig,
  generateDefaultZones,
  images,
  extractAppName
};
