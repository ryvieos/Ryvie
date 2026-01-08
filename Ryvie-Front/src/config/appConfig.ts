import axios from '../utils/setupAxios';
import urlsConfig from './urls';
const { getServerUrl, registerAppPort } = urlsConfig;
import { GridConfig, AppConfig, AppManifest } from '../types';

import taskSettings from '../icons/task-settings.svg';
import taskAppStore from '../icons/task-AppStore.png';
import taskTransfer from '../icons/task-transfer.png';
import taskUser from '../icons/task-user.png';

export const GRID_CONFIG: GridConfig = {
  BASE_COLS: 10,
  BASE_ROWS: 4,
  SLOT_SIZE: 120,
  GAP: 12,
  MIN_COLS: 3,
  HORIZONTAL_PADDING: 80
};

export const getBaseTotalSlots = (): number => GRID_CONFIG.BASE_COLS * GRID_CONFIG.BASE_ROWS;

export const getMinWidthForFullGrid = (): number => {
  return GRID_CONFIG.BASE_COLS * GRID_CONFIG.SLOT_SIZE + 
         (GRID_CONFIG.BASE_COLS - 1) * GRID_CONFIG.GAP + 
         GRID_CONFIG.HORIZONTAL_PADDING;
};

const importAll = (r: any): Record<string, string> => {
  const images: Record<string, string> = {};
  r.keys().forEach((item: string) => {
    images[item.replace('./', '')] = r(item);
  });
  return images;
};

const images = importAll(require.context('../icons', false, /\.(png|jpe?g|svg)$/));

images['task-settings.svg'] = (taskSettings && (taskSettings as any).default) ? (taskSettings as any).default : taskSettings;
images['task-AppStore.png'] = (taskAppStore && (taskAppStore as any).default) ? (taskAppStore as any).default : taskAppStore;
images['task-transfer.png'] = (taskTransfer && (taskTransfer as any).default) ? (taskTransfer as any).default : taskTransfer;
images['task-user.png'] = (taskUser && (taskUser as any).default) ? (taskUser as any).default : taskUser;

const extractAppName = (filename: string): string => {
  if (filename.startsWith('app-')) {
    return filename.replace('app-', '').replace(/\.(png|jpe?g|svg)$/i, '');
  }
  if (filename.startsWith('task-')) {
    return filename.replace('task-', '').replace(/\.(png|jpe?g|svg)$/i, '');
  }
  return filename.replace(/\.(png|jpe?g|svg)$/i, '');
};

const generateTaskbarConfig = (): Record<string, AppConfig> => {
  const config: Record<string, AppConfig> = {};
  const taskIcons = Object.keys(images).filter(icon => {
    if (!icon.startsWith('task-')) return false;
    if (icon === 'task-AppStore.svg') return false;
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

const fetchAppsFromManifests = async (accessMode: string): Promise<AppManifest[]> => {
  try {
    const serverUrl = getServerUrl(accessMode);
    console.log('[appConfig] Chargement des apps depuis manifests:', serverUrl);
    
    const response = await axios.get(`${serverUrl}/api/apps/manifests`);
    const apps = response.data;
    
    console.log('[appConfig] Apps chargées depuis manifests:', apps.length);
    return apps;
  } catch (error: any) {
    console.error('[appConfig] Erreur lors du chargement des manifests:', error.message);
    return [];
  }
};

const generateAppConfigFromManifests = async (accessMode: string): Promise<Record<string, AppConfig>> => {
  const config: Record<string, AppConfig> = {};
  
  try {
    const apps = await fetchAppsFromManifests(accessMode);
    const serverUrl = getServerUrl(accessMode);
    
    apps.forEach(app => {
      const iconId = `app-${app.id}`;
      
      const iconUrl = `${serverUrl}/api/apps/${app.id}/icon?t=${Date.now()}`;

      if (app.mainPort && Number.isInteger(app.mainPort)) {
        try { registerAppPort(app.id, app.mainPort); } catch (_) {}
      }
      
      config[iconId] = {
        id: app.id,
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
  
  const taskbarConfig = generateTaskbarConfig();
  Object.assign(config, taskbarConfig);
  
  return config;
};

const generateDefaultAppsList = async (accessMode: string): Promise<string[]> => {
  try {
    const apps = await fetchAppsFromManifests(accessMode);
    return apps.map(app => `app-${app.id}`);
  } catch (error) {
    console.error('[appConfig] Erreur lors de la génération de la liste d\'apps:', error);
    return [];
  }
};

export { 
  generateAppConfigFromManifests,
  generateDefaultAppsList,
  fetchAppsFromManifests,
  generateTaskbarConfig,
  images, 
  extractAppName 
};

export default GRID_CONFIG;
