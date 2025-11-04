/**
 * Configuration centralisée des URLs pour l'application Ryvie
 * Version front-end - lit les données depuis netbird_data.json
 */

// Import des données Netbird
import netbirdDataRaw from './netbird-data.json';
// Import des ports d'app générés par le backend (si une app n'est pas listée, fallback sur LOCAL_PORTS)
import appPortsRaw from './app-ports.json';

// Mapping des services vers les ports locaux
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

// Données Netbird (copie pour éviter les mutations)
const netbirdData = { ...netbirdDataRaw };
const appPorts = { ...appPortsRaw };

const resolvePort = (appId, fallback) => {
  const p = appPorts?.[appId];
  return Number.isInteger(p) ? p : fallback;
};

const privateUrl = (host, port) => {
  const scheme = port === 443 ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
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
      PUBLIC: domains[id] ? `https://${domains[id]}` : '',
      PRIVATE: privateUrl('ryvietest.local', port)
    };
  });

  return {
    // URLs du frontend
    FRONTEND: {
      PUBLIC: `https://${domains.app}`,
      PRIVATE: `http://ryvietest.local:${LOCAL_PORTS.FRONTEND}`
    },

    // URLs du serveur principal
    SERVER: {
      PUBLIC: `https://${domains.status}`,
      PRIVATE: `http://ryvietest.local:${LOCAL_PORTS.SERVER}`
    },

    // URLs des applications (connues + dynamiques)
    APPS: apps,

    // URLs des services backend RDrive
    RDRIVE_BACKEND: {
      BACKEND: {
        PUBLIC: `https://${domains['backend.rdrive']}`,
        PRIVATE: `http://ryvietest.local:${LOCAL_PORTS.BACKEND_RDRIVE}`
      },
      CONNECTOR: {
        PUBLIC: `https://${domains['connector.rdrive']}`,
        PRIVATE: `http://ryvietest.local:${LOCAL_PORTS.CONNECTOR_RDRIVE}`
      },
      DOCUMENT: {
        PUBLIC: `https://${domains['document.rdrive']}`,
        PRIVATE: `http://ryvietest.local:${LOCAL_PORTS.DOCUMENT_RDRIVE}`
      }
    }
  };
};

// URLs générées dynamiquement
const BASE_URLS = generateBaseUrls();

/**
 * Fonction utilitaire pour obtenir l'URL appropriée en fonction du mode d'accès
 * @param {Object} urlConfig - Configuration d'URL avec propriétés PUBLIC et PRIVATE
 * @param {string} accessMode - Mode d'accès ('public' ou 'private')
 * @returns {string} - L'URL appropriée selon le mode d'accès
 */
const isHttpsContext = () => {
  if (typeof window === 'undefined') return false;
  return window.location?.protocol === 'https:';
};

const getUrl = (urlConfig, accessMode) => {
  if (isHttpsContext()) {
    return urlConfig.PUBLIC;
  }
  return accessMode === 'public' ? urlConfig.PUBLIC : urlConfig.PRIVATE;
};

/**
 * Fonction pour obtenir l'URL du serveur en fonction du mode d'accès
 * @param {string} accessMode - Mode d'accès ('public' ou 'private')
 * @returns {string} - L'URL du serveur
 */
const getServerUrl = (accessMode) => {
  return getUrl(BASE_URLS.SERVER, accessMode);
};

/**
 * Fonction pour obtenir l'URL d'une application en fonction du mode d'accès
 * @param {string} appName - Nom de l'application (doit correspondre à une clé dans APPS)
 * @param {string} accessMode - Mode d'accès ('public' ou 'private')
 * @returns {string} - L'URL de l'application
 */
const getAppUrl = (appName, accessMode) => {
  if (!BASE_URLS.APPS[appName]) {
    console.error(`Application non trouvée: ${appName}`);
    return '';
  }
  return getUrl(BASE_URLS.APPS[appName], accessMode);
};

/**
 * Fonction pour obtenir l'URL d'un service backend RDrive
 * @param {string} serviceName - Nom du service (BACKEND, CONNECTOR, DOCUMENT)
 * @param {string} accessMode - Mode d'accès ('public' ou 'private')
 * @returns {string} - L'URL du service backend
 */
const getRdriveBackendUrl = (serviceName, accessMode) => {
  if (!BASE_URLS.RDRIVE_BACKEND[serviceName]) {
    console.error(`Service RDrive Backend non trouvé: ${serviceName}`);
    return '';
  }
  return getUrl(BASE_URLS.RDRIVE_BACKEND[serviceName], accessMode);
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
 * @returns {string} - 'public' ou 'private'
 */
const getAccessMode = () => {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    if (protocol === 'https:') {
      return 'public';
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.includes('local')) {
      return 'private';
    }
  }
  return 'public';
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
 * @param {string} mode - 'public' ou 'private'
 * @returns {string} - L'URL du frontend
 */
function getFrontendUrl(mode = 'public') {
  return mode === 'public' ? BASE_URLS.FRONTEND.PUBLIC : BASE_URLS.FRONTEND.PRIVATE;
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
  getFrontendUrl
};
