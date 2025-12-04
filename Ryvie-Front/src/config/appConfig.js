/**
 * Configuration centralisée de Ryvie
 * - Configuration de la grille (dimensions, responsive)
 * - Configuration des applications (manifests + icônes locales)
 */

import axios from '../utils/setupAxios';
import urlsConfig from './urls';
const { getServerUrl, registerAppPort } = urlsConfig;

// ==================== CONFIGURATION GRILLE ====================

/**
 * Configuration de la grille du launcher
 * Modifier ces valeurs pour changer le comportement de toute la grille
 */
export const GRID_CONFIG = {
  // Nombre de colonnes de base (plein écran)
  BASE_COLS: 10,
  
  // Nombre de lignes minimum
  BASE_ROWS: 4,
  
  // Taille fixe d'un slot en pixels (ne change jamais)
  SLOT_SIZE: 120,
  
  // Espacement entre les slots en pixels
  GAP: 12,
  
  // Nombre minimum de colonnes (fenêtre très réduite)
  MIN_COLS: 3,
  
  // Padding horizontal estimé (marges latérales de la page)
  HORIZONTAL_PADDING: 80
};

// Fonctions utilitaires pour la grille
export const getBaseTotalSlots = () => GRID_CONFIG.BASE_COLS * GRID_CONFIG.BASE_ROWS;

export const getMinWidthForFullGrid = () => {
  return GRID_CONFIG.BASE_COLS * GRID_CONFIG.SLOT_SIZE + 
         (GRID_CONFIG.BASE_COLS - 1) * GRID_CONFIG.GAP + 
         GRID_CONFIG.HORIZONTAL_PADDING;
};

// ==================== CONFIGURATION ICÔNES ====================

// Import explicite des icônes critiques de la taskbar (évite les soucis de bundling cross-plateformes)
import taskSettings from '../icons/task-settings.svg';
import taskAppStore from '../icons/task-AppStore.png';
import taskTransfer from '../icons/task-transfer.png';
import taskUser from '../icons/task-user.png';

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
images['task-AppStore.png'] = (taskAppStore && taskAppStore.default) ? taskAppStore.default : taskAppStore;
images['task-transfer.png'] = (taskTransfer && taskTransfer.default) ? taskTransfer.default : taskTransfer;
images['task-user.png'] = (taskUser && taskUser.default) ? taskUser.default : taskUser;

// ==================== CONFIGURATION APPLICATIONS ====================

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

/**
 * Génère la configuration des icônes de la taskbar
 * Ces icônes sont toujours locales (pas depuis les manifests)
 */
const generateTaskbarConfig = () => {
  const config = {};
  const taskIcons = Object.keys(images).filter(icon => {
    if (!icon.startsWith('task-')) return false;
    // Pour AppStore, n'utiliser que la variante PNG dans la taskbar
    if (icon === 'task-AppStore.svg') return false;
    // Pour Transfer, n'utiliser que la variante PNG dans la taskbar
    if (icon === 'task-transfer.svg') return false;
    return true;
  });
  
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
 * Génère la config des apps depuis les manifests (système principal)
 * Charge les apps depuis l'API et ajoute les icônes de la taskbar
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

      // Enregistrer dynamiquement le port principal pour getAppUrl
      if (app.mainPort && Number.isInteger(app.mainPort)) {
        try { registerAppPort(app.id, app.mainPort); } catch (_) {}
      }
      
      config[iconId] = {
        id: app.id, // ⚠️ OBLIGATOIRE pour les actions start/stop/restart
        name: app.name,
        description: app.description,
        category: app.category,
        icon: iconUrl,
        urlKey: app.id.toUpperCase(),
        showStatus: true,
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
  const taskbarConfig = generateTaskbarConfig();
  Object.assign(config, taskbarConfig);
  
  return config;
};

/**
 * Génère une liste d'apps par défaut pour la migration depuis l'ancien système
 * Utilisé uniquement si aucun layout n'est sauvegardé sur le backend
 */
const generateDefaultAppsList = async (accessMode) => {
  try {
    const apps = await fetchAppsFromManifests(accessMode);
    return apps.map(app => `app-${app.id}`);
  } catch (error) {
    console.error('[appConfig] Erreur lors de la génération de la liste d\'apps:', error);
    return [];
  }
};

// ==================== EXPORTS ====================

export { 
  // Configuration des applications
  generateAppConfigFromManifests,
  generateDefaultAppsList,
  fetchAppsFromManifests,
  generateTaskbarConfig,
  
  // Utilitaires
  images, 
  extractAppName 
};

// Export par défaut pour compatibilité
export default GRID_CONFIG;
