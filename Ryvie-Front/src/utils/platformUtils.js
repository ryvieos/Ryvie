/**
 * Utilitaires pour détecter l'environnement d'exécution et gérer la compatibilité web/desktop
 */

/**
 * Détecte si l'application s'exécute dans Electron
 * @returns {boolean} - true si dans Electron, false si dans un navigateur web
 */
export function isElectron() {
  return !!(window && window.electronAPI);
}

/**
 * Détecte si l'application s'exécute dans un navigateur web
 * @returns {boolean} - true si dans un navigateur, false si dans Electron
 */
export function isWeb() {
  return !isElectron();
}

/**
 * Exécute une fonction seulement si on est dans Electron
 * @param {Function} electronFn - Fonction à exécuter dans Electron
 * @param {Function} [webFallback] - Fonction alternative pour le web
 * @returns {any} - Résultat de la fonction exécutée
 */
export function ifElectron(electronFn, webFallback = () => {}) {
  if (isElectron()) {
    return electronFn();
  } else {
    return webFallback();
  }
}

/**
 * Exécute une fonction seulement si on est dans un navigateur web
 * @param {Function} webFn - Fonction à exécuter dans le web
 * @param {Function} [electronFallback] - Fonction alternative pour Electron
 * @returns {any} - Résultat de la fonction exécutée
 */
export function ifWeb(webFn, electronFallback = () => {}) {
  if (isWeb()) {
    return webFn();
  } else {
    return electronFallback();
  }
}

/**
 * Gestion des fenêtres - compatible web et Electron
 */
export const WindowManager = {
  /**
   * Ouvre une nouvelle fenêtre/onglet
   * @param {string} url - URL à ouvrir
   * @param {Object} options - Options d'ouverture
   */
  openWindow: (url, options = {}) => {
    if (isElectron()) {
      // Dans Electron, utiliser l'API native
      window.open(url, '_blank', `width=${options.width || 1000},height=${options.height || 700}`);
    } else {
      // Dans le navigateur, ouvrir un nouvel onglet
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },

  /**
   * Ferme la fenêtre actuelle
   */
  closeWindow: () => {
    if (isElectron() && window.electronAPI) {
      window.electronAPI.closeCurrentWindow();
    } else {
      // Dans le navigateur, on ne peut pas fermer la fenêtre principale
      // On peut rediriger vers une page de déconnexion
      window.location.href = '/login';
    }
  }
};

/**
 * Gestion du stockage - compatible web et Electron
 */
export const StorageManager = {
  /**
   * Stocke une valeur
   * @param {string} key - Clé de stockage
   * @param {any} value - Valeur à stocker
   */
  setItem: (key, value) => {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    localStorage.setItem(key, stringValue);
  },

  /**
   * Récupère une valeur
   * @param {string} key - Clé de stockage
   * @param {any} defaultValue - Valeur par défaut
   * @returns {any} - Valeur stockée ou valeur par défaut
   */
  getItem: (key, defaultValue = null) => {
    try {
      const value = localStorage.getItem(key);
      if (value === null) return defaultValue;
      
      // Essayer de parser en JSON, sinon retourner la chaîne
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    } catch {
      return defaultValue;
    }
  },

  /**
   * Supprime une valeur
   * @param {string} key - Clé à supprimer
   */
  removeItem: (key) => {
    localStorage.removeItem(key);
  },

  /**
   * Vide tout le stockage
   */
  clear: () => {
    localStorage.clear();
  }
};

/**
 * Gestion des notifications - compatible web et Electron
 */
export const NotificationManager = {
  /**
   * Affiche une notification
   * @param {string} title - Titre de la notification
   * @param {string} message - Message de la notification
   * @param {Object} options - Options de notification
   */
  show: (title, message, options = {}) => {
    if (isElectron()) {
      // Dans Electron, on peut utiliser les notifications système
      new Notification(title, {
        body: message,
        icon: options.icon,
        ...options
      });
    } else {
      // Dans le navigateur, demander permission puis afficher
      if (Notification.permission === 'granted') {
        new Notification(title, {
          body: message,
          icon: options.icon || '/favicon.ico',
          ...options
        });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification(title, {
              body: message,
              icon: options.icon || '/favicon.ico',
              ...options
            });
          }
        });
      }
    }
  }
};

export default {
  isElectron,
  isWeb,
  ifElectron,
  ifWeb,
  WindowManager,
  StorageManager,
  NotificationManager
};
