/**
 * Configuration centralisée des URLs pour l'application Ryvie
 * Ce fichier contient toutes les URLs utilisées dans l'application,
 * avec leurs versions publiques et privées.
 */

// URLs de base pour les API et services
const BASE_URLS = {
  // URLs du serveur principal
  SERVER: {
    PUBLIC: 'https://status.demo.ryvie.fr',
    PRIVATE: 'http://ryvie.local:3002'
  },
  
  // URLs des applications
  APPS: {
    APPSTORE: {
      PUBLIC: 'https://appstore.makerfaire.jules.ryvie.fr',
      PRIVATE: 'http://ryvie.local:5173'
    },
    RDRIVE: {
      PUBLIC: 'https://rdrive.demo.ryvie.fr',
      PRIVATE: 'http://ryvie.local:3010'
    },
    PORTAINER: {
      PUBLIC: 'https://portainer.demo.ryvie.fr',
      PRIVATE: 'http://ryvie.local:9000'
    },
    RTRANSFER: {
      PUBLIC: 'https://rtransfer.demo.ryvie.fr/auth/signIn',
      PRIVATE: 'http://ryvie.local:3011'
    },
    RDROP: {
      PUBLIC: 'https://rdrop.demo.ryvie.fr',
      PRIVATE: 'http://ryvie.local:8080'
    },
    RPICTURES: {
      PUBLIC: 'https://rpictures.demo.ryvie.fr',
      PRIVATE: 'http://ryvie.local:2283'
    }
  }
};

/**
 * Fonction utilitaire pour obtenir l'URL appropriée en fonction du mode d'accès
 * @param {Object} urlConfig - Configuration d'URL avec propriétés PUBLIC et PRIVATE
 * @param {string} accessMode - Mode d'accès ('public' ou 'private')
 * @returns {string} - L'URL appropriée selon le mode d'accès
 */
const getUrl = (urlConfig, accessMode) => {
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

// Exporter les fonctions et constantes en utilisant module.exports (CommonJS)
module.exports = {
  BASE_URLS,
  getUrl,
  getServerUrl,
  getAppUrl
};