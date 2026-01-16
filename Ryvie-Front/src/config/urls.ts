import { NetbirdData, UrlConfig, BaseUrls, LocationInfo } from '../types';

const LOCAL_PORTS: Record<string, number> = {
  FRONTEND: 3000,
  SERVER: 3002,
  APPSTORE: 5173,
  RDRIVE: 3010,
  PORTAINER: 9000,
  RTRANSFER: 3011,
  RDROP: 8080,
  RPICTURES: 2283,
  BACKEND_RDRIVE: 3012,
  CONNECTOR_RDRIVE: 3013,
  DOCUMENT_RDRIVE: 3014
};

let netbirdData: NetbirdData = {
  domains: {},
  received: {
    backendHost: ''
  }
};

const appPorts: Record<string, number> = {};
const appHttpsRequired: Record<string, boolean> = {};

let netbirdDataLoaded = false;
let netbirdDataLoading = false;
const netbirdDataCallbacks: Array<(data: NetbirdData) => void> = [];

let appPortsLoaded = false;
let appPortsLoading = false;
const appPortsCallbacks: Array<(data: Record<string, number>) => void> = [];

const loadNetbirdData = async (): Promise<NetbirdData> => {
  if (netbirdDataLoaded) {
    return netbirdData;
  }
  
  if (netbirdDataLoading) {
    return new Promise((resolve) => {
      netbirdDataCallbacks.push(resolve);
    });
  }
  
  netbirdDataLoading = true;
  
  try {
    const response = await fetch('/config/netbird-data.json', {
      cache: 'no-cache'
    });
    
    if (response.ok) {
      const data = await response.json();
      netbirdData = { ...data };
      console.log('[urls] Données Netbird chargées:', netbirdData);
    } else {
      console.warn('[urls] Impossible de charger netbird-data.json, utilisation des valeurs par défaut');
    }
  } catch (error: any) {
    console.warn('[urls] Erreur lors du chargement de netbird-data.json:', error.message);
  } finally {
    netbirdDataLoaded = true;
    netbirdDataLoading = false;
    
    netbirdDataCallbacks.forEach(cb => cb(netbirdData));
    netbirdDataCallbacks.length = 0;
  }
  
  return netbirdData;
};

const loadAppPorts = async (): Promise<Record<string, number>> => {
  if (appPortsLoaded) {
    return appPorts;
  }
  
  if (appPortsLoading) {
    return new Promise((resolve) => {
      appPortsCallbacks.push(resolve);
    });
  }
  
  appPortsLoading = true;
  
  try {
    const response = await fetch('/config/app-ports.json', {
      cache: 'no-cache'
    });
    
    if (response.ok) {
      const data = await response.json();
      Object.assign(appPorts, data);
      console.log('[urls] Ports des applications chargés:', appPorts);
    } else {
      console.warn('[urls] Impossible de charger app-ports.json, utilisation de LOCAL_PORTS');
    }
  } catch (error: any) {
    console.warn('[urls] Erreur lors du chargement de app-ports.json:', error.message);
  } finally {
    appPortsLoaded = true;
    appPortsLoading = false;
    
    appPortsCallbacks.forEach(cb => cb(appPorts));
    appPortsCallbacks.length = 0;
  }
  
  return appPorts;
};

loadNetbirdData();
loadAppPorts();

let cachedLocalIP: string | null = null;

const resolvePort = (appId: string, fallback: number): number => {
  const p = appPorts?.[appId];
  return Number.isInteger(p) ? p : fallback;
};

const registerAppPort = (appId: string, port: number, requiresHttps: boolean = false): void => {
  if (!appId || !Number.isInteger(port)) return;
  try {
    const id = String(appId).toLowerCase();
    appPorts[id] = port;
    appHttpsRequired[id] = requiresHttps;
    if (BASE_URLS && BASE_URLS.APPS) {
      const domains = netbirdData?.domains || {};
      const domainsId = id;
      BASE_URLS.APPS[id.toUpperCase()] = {
        REMOTE: domains[domainsId] ? `https://${domains[domainsId]}` : '',
        PRIVATE: privateUrl('ryvie.local', port)
      };
    }
  } catch (e: any) {
    console.warn('[urls] registerAppPort failed for', appId, port, e?.message);
  }
};

const privateUrl = (host: string, port: number): string => {
  const scheme = port === 443 ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
};

const getCurrentLocation = (): LocationInfo => {
  if (typeof window === 'undefined') {
    return { hostname: 'ryvie.local', protocol: 'http:', port: '3000' };
  }
  return {
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    port: window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
  };
};

const isOnNetbirdTunnel = (): boolean => {
  const { hostname } = getCurrentLocation();
  const backendHost = netbirdData?.received?.backendHost;
  return !!backendHost && hostname === backendHost;
};

const setLocalIP = (ip: string): void => {
  if (ip && typeof ip === 'string') {
    cachedLocalIP = ip;
    console.log('[urls] IP locale mise en cache:', ip);
  }
};

const getLocalIP = (): string | null => {
  return cachedLocalIP;
};

const buildAppUrl = (appId: string, port: number): string => {
  const { hostname, protocol } = getCurrentLocation();
  const domains = netbirdData?.domains || {};
  const appDomain = domains[appId];
  const requiresHttps = appHttpsRequired[appId] || false;

  if (hostname === 'ryvie.local') {
    if (cachedLocalIP && port) {
      // Utiliser HTTPS si l'app le requiert
      const scheme = requiresHttps ? 'https' : 'http';
      console.log(`[buildAppUrl] ${appId} → ${scheme}://${cachedLocalIP}:${port}${requiresHttps ? ' (HTTPS requis)' : ''}`);
      return `${scheme}://${cachedLocalIP}:${port}`;
    }
    console.log(`[buildAppUrl] ${appId} → http://ryvie.local (IP locale non disponible: ${cachedLocalIP})`);
    return 'http://ryvie.local';
  }

  if (protocol === 'https:' && appDomain) {
    return `https://${appDomain}`;
  }

  if (isOnNetbirdTunnel() && appDomain) {
    return `https://${appDomain}`;
  }

  // Forcer HTTPS si l'app le requiert
  const scheme = requiresHttps ? 'https' : (protocol === 'https:' ? 'https' : 'http');
  
  if (scheme === 'http' && cachedLocalIP) {
    return `${scheme}://${cachedLocalIP}:${port}`;
  }
  
  return `${scheme}://${hostname}:${port}`;
};

const generateBaseUrls = (): BaseUrls => {
  const domains = netbirdData.domains;
  
  const apps: Record<string, UrlConfig> = {};

  Object.keys(appPorts).forEach((id) => {
    const upper = id.toUpperCase();
    const port = resolvePort(id, 0);
    if (!port) return;
    apps[upper] = {
      REMOTE: domains[id] ? `https://${domains[id]}` : '',
      PRIVATE: privateUrl('ryvie.local', port)
    };
  });

  return {
    FRONTEND: {
      REMOTE: `https://${domains.app}`,
      PRIVATE: `http://ryvie.local:${LOCAL_PORTS.FRONTEND}`
    },

    SERVER: {
      REMOTE: `https://${domains.status}`,
      PRIVATE: `http://ryvie.local:${LOCAL_PORTS.SERVER}`
    },

    APPS: apps,

    RDRIVE_BACKEND: {
      BACKEND: {
        REMOTE: `https://${domains['backend.rdrive']}`,
        PRIVATE: `http://ryvie.local:${LOCAL_PORTS.BACKEND_RDRIVE}`
      },
      CONNECTOR: {
        REMOTE: `https://${domains['connector.rdrive']}`,
        PRIVATE: `http://ryvie.local:${LOCAL_PORTS.CONNECTOR_RDRIVE}`
      },
      DOCUMENT: {
        REMOTE: `https://${domains['document.rdrive']}`,
        PRIVATE: `http://ryvie.local:${LOCAL_PORTS.DOCUMENT_RDRIVE}`
      }
    }
  };
};

const BASE_URLS = generateBaseUrls();

const isHttpsContext = (): boolean => {
  if (typeof window === 'undefined') return false;
  return window.location?.protocol === 'https:';
};

const getUrl = (urlConfig: UrlConfig, accessMode: string): string => {
  if (isHttpsContext()) {
    return urlConfig.REMOTE;
  }
  return accessMode === 'remote' ? urlConfig.REMOTE : urlConfig.PRIVATE;
};

const getServerUrl = (accessMode: string): string => {
  const domains = netbirdData?.domains || {};
  const { hostname, protocol } = getCurrentLocation();

  if (hostname === 'ryvie.local') {
    return 'http://ryvie.local';
  }

  if (protocol === 'https:' && domains.status) {
    return `https://${domains.status}`;
  }

  return buildAppUrl('status', LOCAL_PORTS.SERVER);
};

const getAppUrl = (appName: string, accessMode: string): string => {
  const appId = appName.toLowerCase();
  
  const port = appPorts?.[appId] || (LOCAL_PORTS as any)[appName];
  
  if (!port) {
    console.error(`Application non trouvée ou port non défini: ${appName}`);
    return '';
  }
  
  return buildAppUrl(appId, port);
};

const getRdriveBackendUrl = (serviceName: string, accessMode: string): string => {
  const serviceToAppId: Record<string, string> = {
    'BACKEND': 'backend.rdrive',
    'CONNECTOR': 'connector.rdrive',
    'DOCUMENT': 'document.rdrive'
  };
  
  const serviceToPort: Record<string, number> = {
    'BACKEND': LOCAL_PORTS.BACKEND_RDRIVE,
    'CONNECTOR': LOCAL_PORTS.CONNECTOR_RDRIVE,
    'DOCUMENT': LOCAL_PORTS.DOCUMENT_RDRIVE
  };
  
  const appId = serviceToAppId[serviceName];
  const port = serviceToPort[serviceName];
  
  if (!appId || !port) {
    console.error(`Service RDrive Backend non trouvé: ${serviceName}`);
    return '';
  }
  
  return buildAppUrl(appId, port);
};

const getNetbirdDomain = (serviceName: string): string => {
  const domain = netbirdData.domains[serviceName];
  return domain ? `https://${domain}` : '';
};

const getNetbirdInfo = (): NetbirdData => {
  return { ...netbirdData };
};

const getAccessMode = (): string => {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    if (protocol === 'https:') {
      return 'remote';
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.includes('local')) {
      return 'private';
    }
  }
  return 'remote';
};

const getAutoUrl = (type: string, name: string): string => {
  const mode = getAccessMode();
  
  switch (type) {
    case 'server':
      return getServerUrl(mode);
    case 'app':
      return getAppUrl(name, mode);
    case 'rdrive-backend':
      return getRdriveBackendUrl(name, mode);
    default:
      console.error(`Type de service non reconnu: ${type}`);
      return '';
  }
};

function getFrontendUrl(mode: string = 'remote'): string {
  if (mode === 'private') {
    return `http://ryvie.local`;
  }
  
  // Mode remote
  const domains = netbirdData?.domains || {};
  const backendHost = netbirdData?.received?.backendHost;
  
  // Priorité 1: Domaine Netbird pour l'app frontend
  if (domains.app) {
    return `https://${domains.app}`;
  }
  
  // Priorité 2: Backend host Netbird
  if (backendHost) {
    return `http://${backendHost}:${LOCAL_PORTS.FRONTEND}`;
  }
  
  // Priorité 3: IP locale en cache (quand on bascule depuis ryvie.local)
  if (cachedLocalIP) {
    console.log(`[getFrontendUrl] Utilisation de l'IP locale en cache: ${cachedLocalIP}`);
    return `http://${cachedLocalIP}:${LOCAL_PORTS.FRONTEND}`;
  }
  
  // Fallback: hostname actuel
  const { hostname, protocol } = getCurrentLocation();
  const scheme = protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${hostname}:${LOCAL_PORTS.FRONTEND}`;
}

export default {
  BASE_URLS,
  netbirdData,
  getUrl,
  getServerUrl,
  getAppUrl,
  getRdriveBackendUrl,
  getNetbirdDomain,
  getNetbirdInfo,
  getAccessMode,
  getAutoUrl,
  getFrontendUrl,
  getCurrentLocation,
  isOnNetbirdTunnel,
  buildAppUrl,
  registerAppPort,
  setLocalIP,
  getLocalIP,
  loadNetbirdData,
  loadAppPorts
};
