/**
 * Utilitaire pour détecter automatiquement le mode d'accès (privé/public)
 * Teste la connectivité au serveur local et bascule vers public si nécessaire
 */

const { getServerUrl } = require('../config/urls');

/**
 * Détecte automatiquement le mode d'accès en testant la connectivité
 * @param {number} timeout - Timeout en millisecondes pour le test (défaut: 2000ms)
 * @returns {Promise<string>} - 'private' si le serveur local est accessible, 'public' sinon
 */
export async function detectAccessMode(timeout = 2000) {
  const privateUrl = getServerUrl('private');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    console.log(`[AccessMode] Test de connectivité vers ${privateUrl}...`);
    
    const response = await fetch(`${privateUrl}/status`, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json'
      }
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      console.log('[AccessMode] Serveur local accessible - Mode PRIVATE');
      localStorage.setItem('accessMode', 'private');
      return 'private';
    }
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      console.log('[AccessMode] Timeout - Serveur local non accessible');
    } else {
      console.log('[AccessMode] Erreur de connexion:', error.message);
    }
  }

  console.log('[AccessMode] Basculement vers le mode PUBLIC');
  localStorage.setItem('accessMode', 'public');
  return 'public';
}

/**
 * Récupère le mode d'accès actuel depuis localStorage
 * @returns {string|null} - 'private', 'public' ou null si non défini
 */
export function getCurrentAccessMode() {
  return localStorage.getItem('accessMode');
}

/**
 * Force un mode d'accès spécifique
 * @param {string} mode - 'private' ou 'public'
 */
export function setAccessMode(mode) {
  if (mode !== 'private' && mode !== 'public') {
    throw new Error('Mode d\'accès invalide. Utilisez "private" ou "public".');
  }
  
  localStorage.setItem('accessMode', mode);
  console.log(`[AccessMode] Mode forcé à: ${mode.toUpperCase()}`);
}

/**
 * Teste la connectivité vers un serveur spécifique
 * @param {string} mode - 'private' ou 'public'
 * @param {number} timeout - Timeout en millisecondes
 * @returns {Promise<boolean>} - true si accessible, false sinon
 */
export async function testServerConnectivity(mode, timeout = 2000) {
  const serverUrl = getServerUrl(mode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${serverUrl}/status`, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json'
      }
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    clearTimeout(timeoutId);
    return false;
  }
}
