/**
 * Configuration centralisée des URLs pour l'application Ryvie
 * Version front-end - charge les données dynamiquement au runtime
 */

// Mapping des services vers les ports locaux (fallback si app-ports.json n'est pas chargé)
const LOCAL_PORTS = {
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

// Données Netbird (chargées dynamiquement au runtime)
let netbirdData = {
  domains: {},
  received: {
    backendHost: ''
  }
};

// Ports des applications (chargés dynamiquement au runtime)
const appPorts = {};

// État du chargement des fichiers JSON
let netbirdDataLoaded = false;
let netbirdDataLoading = false;
const netbirdDataCallbacks = [];

let appPortsLoaded = false;
let appPortsLoading = false;
const appPortsCallbacks = [];

/**
 * Charge les données Netbird depuis le serveur de manière asynchrone
 * @returns {Promise<Object>} - Les données Netbird
 */
const loadNetbirdData = async () => {
  // Si déjà chargé, retourner immédiatement
  if (netbirdDataLoaded) {
    return netbirdData;
  }
  
  // Si en cours de chargement, attendre la fin
  if (netbirdDataLoading) {
    return new Promise((resolve) => {
      netbirdDataCallbacks.push(resolve);
    });
  }
  
  netbirdDataLoading = true;
  
  try {
    // Charger depuis le serveur (le fichier est servi statiquement)
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
  } catch (error) {
    console.warn('[urls] Erreur lors du chargement de netbird-data.json:', error.message);
  } finally {
    netbirdDataLoaded = true;
    netbirdDataLoading = false;
    
    // Notifier tous les callbacks en attente
    netbirdDataCallbacks.forEach(cb => cb(netbirdData));
    netbirdDataCallbacks.length = 0;
  }
  
  return netbirdData;
};

/**
 * Charge les ports des applications depuis le serveur de manière asynchrone
 * @returns {Promise<Object>} - Les ports des applications
 */
const loadAppPorts = async () => {
  // Si déjà chargé, retourner immédiatement
  if (appPortsLoaded) {
    return appPorts;
  }
  
  // Si en cours de chargement, attendre la fin
  if (appPortsLoading) {
    return new Promise((resolve) => {
      appPortsCallbacks.push(resolve);
    });
  }
  
  appPortsLoading = true;
  
  try {
    // Charger depuis le serveur (le fichier est servi statiquement)
    const response = await fetch('/config/app-ports.json', {
      cache: 'no-cache'
    });
    
    if (response.ok) {
      const data = await response.json();
      // Fusionner les données chargées avec l'objet appPorts
      Object.assign(appPorts, data);
      console.log('[urls] Ports des applications chargés:', appPorts);
    } else {
      console.warn('[urls] Impossible de charger app-ports.json, utilisation de LOCAL_PORTS');
    }
  } catch (error) {
    console.warn('[urls] Erreur lors du chargement de app-ports.json:', error.message);
  } finally {
    appPortsLoaded = true;
    appPortsLoading = false;
    
    // Notifier tous les callbacks en attente
    appPortsCallbacks.forEach(cb => cb(appPorts));
    appPortsCallbacks.length = 0;
  }
  
  return appPorts;
};

// Charger les données au démarrage de l'application
loadNetbirdData();
loadAppPorts();

// Cache de l'IP locale du serveur
let cachedLocalIP = null;

const resolvePort = (appId, fallback) => {
  const p = appPorts?.[appId];
  return Number.isInteger(p) ? p : fallback;
};

/**
 * Enregistre ou met à jour dynamiquement le port d'une application côté front.
 * Utilisé après chargement des manifests pour que getAppUrl fonctionne
 * immédiatement après installation, sans redémarrer le frontend.
 * @param {string} appId - Identifiant logique de l'app (ex: 'linkwarden')
 * @param {number} port - Port HTTP exposé de l'app
 */
const registerAppPort = (appId, port) => {
  if (!appId || !Number.isInteger(port)) return;
  try {
    const id = String(appId).toLowerCase();
    appPorts[id] = port;
    // Mettre aussi à jour BASE_URLS.APPS si déjà généré
    if (BASE_URLS && BASE_URLS.APPS) {
      const domains = netbirdData?.domains || {};
      const domainsId = id;
      BASE_URLS.APPS[id.toUpperCase()] = {
        REMOTE: domains[domainsId] ? `https://${domains[domainsId]}` : '',
        PRIVATE: privateUrl('ryvie.local', port)
      };
    }
  } catch (e) {
    console.warn('[urls] registerAppPort failed for', appId, port, e?.message);
  }
};

const privateUrl = (host, port) => {
  const scheme = port === 443 ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
};

/**
 * Récupère les informations de l'URL courante du navigateur
 * @returns {{ hostname: string, protocol: string, port: string }}
 */
const getCurrentLocation = () => {
  if (typeof window === 'undefined') {
    return { hostname: 'ryvie.local', protocol: 'http:', port: '3000' };
  }
  return {
    hostname: window.location.hostname,
    protocol: window.location.protocol,
    port: window.location.port || (window.location.protocol === 'https:' ? '443' : '80')
  };
};

/**
 * Vérifie si on est connecté via le tunnel Netbird (backendHost)
 * @returns {boolean}
 */
const isOnNetbirdTunnel = () => {
  const { hostname } = getCurrentLocation();
  const backendHost = netbirdData?.received?.backendHost;
  return backendHost && hostname === backendHost;
};

/**
 * Définit l'IP locale du serveur (appelé après récupération depuis le backend)
 * @param {string} ip - IP locale du serveur
 */
const setLocalIP = (ip) => {
  if (ip && typeof ip === 'string') {
    cachedLocalIP = ip;
    console.log('[urls] IP locale mise en cache:', ip);
  }
};

/**
 * Récupère l'IP locale du serveur depuis le cache
 * @returns {string|null} - IP locale ou null si non définie
 */
const getLocalIP = () => {
  return cachedLocalIP;
};

/**
 * Construit l'URL d'une app en fonction de l'URL courante et des données Netbird
 * Nouvelle logique:
 * - Si on est sur ryvie.local (Caddy) → http://ryvie.local (sans port, Caddy gère le routing)
 * - Si on est sur backendHost ET l'app a un domaine dans netbird-data.json → https://<domaine>
 * - En mode local (HTTP), utiliser l'IP locale du serveur au lieu du hostname
 * - Sinon → http(s)://<hostname_courant>:<port_app>
 * @param {string} appId - ID de l'app (ex: 'rdrive', 'rtransfer')
 * @param {number} port - Port de l'app
 * @returns {string} - URL complète de l'app
 */
const buildAppUrl = (appId, port) => {
  const { hostname, protocol } = getCurrentLocation();
  const domains = netbirdData?.domains || {};
  const appDomain = domains[appId];

  // Si on est sur ryvie.local (Caddy) ET qu'on a l'IP locale, utiliser IP:port pour ouvrir l'app directement
  // Sinon utiliser ryvie.local (Caddy gère le routing)
  if (hostname === 'ryvie.local') {
    if (cachedLocalIP && port) {
      console.log(`[buildAppUrl] ${appId} → http://${cachedLocalIP}:${port}`);
      return `http://${cachedLocalIP}:${port}`;
    }
    console.log(`[buildAppUrl] ${appId} → http://ryvie.local (IP locale non disponible: ${cachedLocalIP})`);
    return 'http://ryvie.local';
  }

  // En contexte HTTPS, si un domaine Netbird est défini pour cette application,
  // toujours utiliser ce domaine remote (accès via reverse proxy/domaine).
  if (protocol === 'https:' && appDomain) {
    return `https://${appDomain}`;
  }

  // Fallback: conserver l'ancienne logique basée sur le tunnel Netbird + hostname:port
  if (isOnNetbirdTunnel() && appDomain) {
    return `https://${appDomain}`;
  }

  const scheme = protocol === 'https:' ? 'https' : 'http';
  
  // En mode local (HTTP), utiliser l'IP locale du serveur si disponible
  if (scheme === 'http' && cachedLocalIP) {
    return `${scheme}://${cachedLocalIP}:${port}`;
  }
  
  return `${scheme}://${hostname}:${port}`;
};

// Génération dynamique des URLs de base
const generateBaseUrls = () => {
  const domains = netbirdData.domains;
  
  // APPS entièrement dynamiques depuis app-ports.json
  const apps = {};

  // Générer les entrées dynamiques à partir des ports connus (provenant du backend)
  Object.keys(appPorts).forEach((id) => {
    const upper = id.toUpperCase();
    const port = resolvePort(id, null);
    if (!port) return; // ignorer si pas de port défini
    apps[upper] = {
      REMOTE: domains[id] ? `https://${domains[id]}` : '',
      PRIVATE: privateUrl('ryvie.local', port)
    };
  });

  return {
    // URLs du frontend
    FRONTEND: {
      REMOTE: `https://${domains.app}`,
      PRIVATE: `http://ryvie.local:${LOCAL_PORTS.FRONTEND}`
    },

    // URLs du serveur principal
    SERVER: {
      REMOTE: `https://${domains.status}`,
      PRIVATE: `http://ryvie.local:${LOCAL_PORTS.SERVER}`
    },

    // URLs des applications (connues + dynamiques)
    APPS: apps,

    // URLs des services backend RDrive
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

// URLs générées dynamiquement
const BASE_URLS = generateBaseUrls();

/**
 * Fonction utilitaire pour obtenir l'URL appropriée en fonction du mode d'accès
 * @param {Object} urlConfig - Configuration d'URL avec propriétés REMOTE et PRIVATE
 * @param {string} accessMode - Mode d'accès ('remote' ou 'private')
 * @returns {string} - L'URL appropriée selon le mode d'accès
 */
const isHttpsContext = () => {
  if (typeof window === 'undefined') return false;
  return window.location?.protocol === 'https:';
};

const getUrl = (urlConfig, accessMode) => {
  if (isHttpsContext()) {
    return urlConfig.REMOTE;
  }
  return accessMode === 'public' ? urlConfig.REMOTE : urlConfig.PRIVATE;
};

/**
 * Fonction pour obtenir l'URL du serveur.
 * Nouvelle logique basée sur l'URL courante:
 * - Si on est sur ryvie.local (via Caddy) → http://ryvie.local (sans port, Caddy gère le routing)
 * - Si on est sur backendHost (tunnel Netbird) ET 'status' a un domaine → https://<domaine>
 * - Sinon → http(s)://<hostname_courant>:<port_server>
 * @param {string} accessMode - Mode d'accès (ignoré, gardé pour compatibilité)
 * @returns {string} - L'URL du serveur
 */
const getServerUrl = (accessMode) => {
  const domains = netbirdData?.domains || {};
  const { hostname, protocol, port } = getCurrentLocation();

  // Si on accède via ryvie.local (Caddy reverse proxy), utiliser l'URL de base sans port
  if (hostname === 'ryvie.local') {
    return 'http://ryvie.local'; // Caddy route automatiquement /api/* vers le backend
  }

  // En contexte remote (HTTPS) et si un domaine Netbird "status" est défini,
  // toujours utiliser ce domaine comme URL remote du backend.
  if (protocol === 'https:' && domains.status) {
    return `https://${domains.status}`;
  }

  // Fallback: conserver l'ancienne logique basée sur l'URL courante et le port serveur
  return buildAppUrl('status', LOCAL_PORTS.SERVER);
};

/**
 * Fonction pour obtenir l'URL d'une application.
 * Nouvelle logique basée sur l'URL courante:
 * - Si on est sur backendHost (tunnel Netbird) ET l'app a un domaine → https://<domaine>
 * - Sinon → http(s)://<hostname_courant>:<port_app>
 * @param {string} appName - Nom de l'application (clé uppercase, ex: 'RDRIVE')
 * @param {string} accessMode - Mode d'accès (ignoré dans la nouvelle logique, gardé pour compatibilité)
 * @returns {string} - L'URL de l'application
 */
const getAppUrl = (appName, accessMode) => {
  // Convertir en lowercase pour chercher dans appPorts et domains
  const appId = appName.toLowerCase();
  
  // Récupérer le port de l'app
  const port = appPorts?.[appId] || LOCAL_PORTS[appName];
  
  if (!port) {
    console.error(`Application non trouvée ou port non défini: ${appName}`);
    return '';
  }
  
  return buildAppUrl(appId, port);
};

/**
 * Fonction pour obtenir l'URL d'un service backend RDrive
 * Nouvelle logique basée sur l'URL courante
 * @param {string} serviceName - Nom du service (BACKEND, CONNECTOR, DOCUMENT)
 * @param {string} accessMode - Mode d'accès (ignoré, gardé pour compatibilité)
 * @returns {string} - L'URL du service backend
 */
const getRdriveBackendUrl = (serviceName, accessMode) => {
  // Mapping des noms de service vers les IDs dans netbird-data.json
  const serviceToAppId = {
    'BACKEND': 'backend.rdrive',
    'CONNECTOR': 'connector.rdrive',
    'DOCUMENT': 'document.rdrive'
  };
  
  const serviceToPort = {
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

/**
 * Fonction pour obtenir directement un domaine depuis les données Netbird
 * @param {string} serviceName - Nom du service dans netbird_data.domains
 * @returns {string} - Le domaine complet avec https://
 */
const getNetbirdDomain = (serviceName) => {
  const domain = netbirdData.domains[serviceName];
  return domain ? `https://${domain}` : '';
};

/**
 * Fonction pour obtenir les informations Netbird
 * @returns {Object} - Les données complètes de Netbird
 */
const getNetbirdInfo = () => {
  return { ...netbirdData };
};

/**
 * Fonction pour déterminer automatiquement le mode d'accès
 * basé sur l'environnement ou l'hostname
 * @returns {string} - 'remote' ou 'private'
 */
const getAccessMode = () => {
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

/**
 * Fonction de convenance pour obtenir une URL automatiquement
 * selon l'environnement
 * @param {string} type - Type de service ('server', 'app', 'rdrive-backend')
 * @param {string} name - Nom du service
 * @returns {string} - L'URL appropriée
 */
const getAutoUrl = (type, name) => {
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

// Exporter les fonctions et constantes (ES modules)
/**
 * Obtient l'URL du frontend en fonction du mode d'accès
 * - Mode 'private' : utilise ryvie.local (sans port, via Caddy same-origin)
 * - Mode 'remote' : 
 *   - Si domains.app existe dans netbird-data.json → https://<domains.app>
 *   - Sinon → http://<backendHost>:3000
 * @param {string} mode - 'remote' ou 'private'
 * @returns {string} - L'URL du frontend
 */
function getFrontendUrl(mode = 'remote') {
  if (mode === 'private') {
    // En mode privé, utiliser ryvie.local sans port (Caddy reverse proxy sur port 80)
    return `http://ryvie.local`;
  }
  
  // Mode remote : vérifier netbird-data.json
  const domains = netbirdData?.domains || {};
  const backendHost = netbirdData?.received?.backendHost;
  
  // Si domains.app existe, utiliser HTTPS avec ce domaine
  if (domains.app) {
    return `https://${domains.app}`;
  }
  
  // Sinon, utiliser backendHost avec le port frontend
  if (backendHost) {
    return `http://${backendHost}:${LOCAL_PORTS.FRONTEND}`;
  }
  
  // Fallback : URL courante
  const { hostname, protocol } = getCurrentLocation();
  const scheme = protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${hostname}:${LOCAL_PORTS.FRONTEND}`;
}

// Export par défaut pour la compatibilité
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
  // Nouvelles fonctions utilitaires
  getCurrentLocation,
  isOnNetbirdTunnel,
  buildAppUrl,
  registerAppPort,
  setLocalIP,
  getLocalIP,
  // Chargement dynamique des fichiers JSON
  loadNetbirdData,
  loadAppPorts
};
