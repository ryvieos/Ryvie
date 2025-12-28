/**
 * Gestionnaire d'état persistant pour les installations d'applications
 * Permet de conserver l'état des installations même lors de la navigation
 */

const STORAGE_KEY = 'ryvie_installing_apps';

/**
 * Sauvegarde l'état des installations dans localStorage
 * @param {Object} installingApps - Map des installations { appId: { appName, progress, startTime } }
 */
export function saveInstallState(installingApps) {
  try {
    const state = {
      installations: installingApps,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[InstallStateManager] Erreur sauvegarde état:', error);
  }
}

/**
 * Récupère l'état des installations depuis localStorage
 * @returns {Object} - Map des installations ou objet vide
 */
export function loadInstallState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    
    const state = JSON.parse(stored);
    const age = Date.now() - (state.timestamp || 0);
    
    // Ignorer les états trop anciens (> 30 minutes)
    if (age > 30 * 60 * 1000) {
      clearInstallState();
      return {};
    }
    
    return state.installations || {};
  } catch (error) {
    console.warn('[InstallStateManager] Erreur chargement état:', error);
    return {};
  }
}

/**
 * Nettoie l'état des installations
 */
export function clearInstallState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('[InstallStateManager] Erreur nettoyage état:', error);
  }
}

/**
 * Ajoute ou met à jour une installation
 * @param {string} appId - ID de l'app
 * @param {Object} data - { appName, progress }
 */
export function updateInstallation(appId, data) {
  const state = loadInstallState();
  state[appId] = {
    ...data,
    lastUpdate: Date.now()
  };
  saveInstallState(state);
}

/**
 * Supprime une installation terminée
 * @param {string} appId - ID de l'app
 */
export function removeInstallation(appId) {
  const state = loadInstallState();
  delete state[appId];
  
  if (Object.keys(state).length === 0) {
    clearInstallState();
  } else {
    saveInstallState(state);
  }
}

/**
 * Vérifie si une installation est en cours
 * @param {string} appId - ID de l'app
 * @returns {boolean}
 */
export function isInstalling(appId) {
  const state = loadInstallState();
  return !!state[appId];
}
