/**
 * Utilitaire pour détecter automatiquement le mode d'accès (privé/public)
 * Teste la connectivité au serveur local et bascule vers public si nécessaire
 */

import urlsConfig from '../config/urls';
const { getServerUrl, netbirdData, setLocalIP } = urlsConfig;
import { io } from 'socket.io-client';
import { isElectron } from './platformUtils';

// Etat global (source de vérité pour la session en cours)
let currentMode = null; // 'private' | 'public' | null

/**
 * Détecte le mode d'accès basé sur l'URL courante du navigateur
 * - Si hostname = backendHost de netbird-data.json → public
 * - Si hostname = un domaine de netbird-data.json → public
 * - Sinon → private
 * @returns {'private' | 'public'}
 */
function detectModeFromUrl() {
  if (typeof window === 'undefined') return 'private';
  
  const hostname = window.location.hostname;
  const port = window.location.port;
  const backendHost = netbirdData?.received?.backendHost;
  const domains = netbirdData?.domains || {};
  
  // Si on est sur l'IP Netbird (backendHost), c'est le mode public
  if (backendHost && hostname === backendHost) {
    console.log(`[AccessMode] Hostname ${hostname} = backendHost → mode PUBLIC`);
    return 'public';
  }
  
  // Si on est sur un domaine Netbird (*.ryvie.ovh), c'est le mode public
  const allDomains = Object.values(domains);
  if (allDomains.includes(hostname)) {
    console.log(`[AccessMode] Hostname ${hostname} = domaine Netbird → mode PUBLIC`);
    return 'public';
  }
  

  if (hostname.endsWith('.ryvie.fr')) {
    console.log(`[AccessMode] Hostname ${hostname} contient .ryvie.ovh → mode PUBLIC`);
    return 'public';
  }
  
  // IMPORTANT: Si on accède via ryvie.local sur port 80 (Caddy), c'est du same-origin
  // On garde le mode private mais les URLs seront relatives (gérées dans urls.js)
  if (hostname === 'ryvie.local' && (port === '80' || port === '')) {
    console.log(`[AccessMode] Hostname ${hostname}:${port || '80'} (Caddy same-origin) → mode PRIVATE`);
    return 'private';
  }
  
  // Sinon c'est le mode privé (ryvie.local:3000, localhost, etc.)
  console.log(`[AccessMode] Hostname ${hostname}:${port} → mode PRIVATE`);
  return 'private';
}
const listeners = new Set(); // callbacks (mode) => void

function notify(mode) {
  for (const cb of Array.from(listeners)) {
    try { cb(mode); } catch {}
  }
}

function persist(mode) {
  try { localStorage.setItem('accessMode', mode); } catch {}
}

function ensureLoadedFromStorage() {
  if (currentMode !== null) return;
  
  // Priorité 1: Détecter le mode basé sur l'URL courante
  const urlMode = detectModeFromUrl();
  
  // Priorité 2: Vérifier le localStorage (mais l'URL a priorité)
  try {
    const stored = localStorage.getItem('accessMode');
    // Si l'URL indique un mode différent du stockage, l'URL gagne
    if (urlMode !== stored) {
      console.log(`[AccessMode] URL indique ${urlMode}, stockage indique ${stored} → utilisation de ${urlMode}`);
      currentMode = urlMode;
      persist(urlMode);
      return;
    }
    if (stored === 'private' || stored === 'public') {
      currentMode = stored;
    }
  } catch {}
  
  // Si toujours pas de mode, utiliser celui de l'URL
  if (currentMode === null) {
    currentMode = urlMode;
    persist(urlMode);
  }
}

/**
 * Détecte automatiquement le mode d'accès
 * PRIORITÉ: L'URL courante détermine le mode (pas le test de connectivité)
 * - Si on est sur l'IP Netbird ou un domaine *.ryvie.ovh → PUBLIC
 * - Sinon → PRIVATE
 * @param {number} timeout - Timeout en millisecondes pour le test (défaut: 2000ms)
 * @returns {Promise<string>} - 'private' ou 'public'
 */
export async function detectAccessMode(timeout = 2000) {
  // PRIORITÉ: Détecter le mode basé sur l'URL courante
  const urlMode = detectModeFromUrl();
  
  // Si l'URL indique clairement le mode public, ne pas faire de test de connectivité
  if (urlMode === 'public') {
    console.log('[AccessMode] URL indique mode PUBLIC - pas de test de connectivité');
    setAccessMode('public');
    return 'public';
  }
  
  // En mode privé (URL locale), vérifier la connectivité au serveur
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
      
      // Récupérer l'IP locale depuis la réponse du serveur
      try {
        const data = await response.json();
        if (data.ip) {
          setLocalIP(data.ip);
          console.log('[AccessMode] IP locale récupérée:', data.ip);
        }
      } catch (e) {
        console.warn('[AccessMode] Impossible de parser la réponse /status:', e);
      }
      
      setAccessMode('private');
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
  setAccessMode('public');
  return 'public';
}

/**
 * Récupère le mode d'accès actuel
 * La détection est basée sur l'URL courante du navigateur:
 * - IP Netbird (backendHost) ou domaine *.ryvie.ovh → public
 * - Sinon (ryvie.local, localhost, etc.) → private
 * @returns {string|null} - 'private', 'public' ou null si non défini
 */
export function getCurrentAccessMode() {
  // Toujours re-détecter basé sur l'URL courante
  const urlMode = detectModeFromUrl();
  
  // Si le mode actuel est différent de ce que l'URL indique, mettre à jour
  if (currentMode !== urlMode) {
    console.log(`[AccessMode] Mode actuel (${currentMode}) != URL (${urlMode}) → mise à jour`);
    currentMode = urlMode;
    persist(urlMode);
  }
  
  // IMPORTANT: Si on est en HTTPS, forcer le mode public pour éviter Mixed Content
  if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    if (currentMode !== 'public') {
      console.log('[AccessMode] Page HTTPS détectée - forçage du mode PUBLIC');
      setAccessMode('public');
    }
    return 'public';
  }
  
  return currentMode;
}

/**
 * Force un mode d'accès spécifique
 * @param {string} mode - 'private' ou 'public'
 */
export function setAccessMode(mode) {
  if (mode !== 'private' && mode !== 'public') {
    throw new Error('Mode d\'accès invalide. Utilisez "private" ou "public".');
  }
  currentMode = mode;
  persist(mode);
  console.log(`[AccessMode] Mode forcé à: ${mode.toUpperCase()}`);
  notify(mode);
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

/**
 * S'abonner aux changements de mode
 * @param {(mode: string)=>void} cb
 */
export function subscribeAccessMode(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Se désabonner (alias pratique)
 */
export function unsubscribeAccessMode(cb) {
  listeners.delete(cb);
}

/**
 * Crée une connexion Socket.IO en respectant le mode d'accès et le contexte (Web/Electron, HTTPS, etc.)
 * @param {Object} params
 * @param {'private'|'public'} params.mode - Mode d'accès à utiliser
 * @param {function} [params.onConnect]
 * @param {function} [params.onDisconnect]
 * @param {function} [params.onError]
 * @param {function} [params.onServerStatus]
 * @param {function} [params.onAppsStatusUpdate]
 * @param {number} [params.timeoutMs=10000]
 * @returns {import('socket.io-client').Socket | null}
 */
export function connectRyvieSocket({
  mode,
  onConnect,
  onDisconnect,
  onError,
  onServerStatus,
  onAppsStatusUpdate,
  timeoutMs = 10000,
} = {}) {
  if (!mode) {
    try { console.log('[SocketHelper] Aucun mode fourni, annulation de la connexion'); } catch {}
    return null;
  }

  // En mode web sous HTTPS, éviter le mode private (réseau local / Mixed Content)
  try {
    if (!isElectron() && typeof window !== 'undefined' && window.location?.protocol === 'https:' && mode === 'private') {
      console.log('[SocketHelper] HTTPS Web + mode private -> pas de tentative Socket.io');
      return null;
    }
  } catch {}

  const serverUrl = getServerUrl(mode);
  console.log(`[SocketHelper] Connexion Socket.io -> ${serverUrl} (mode=${mode})`);

  const socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    timeout: timeoutMs,
    forceNew: true,
  });

  socket.on('connect', () => {
    try { console.log(`[SocketHelper] Socket connecté (mode=${mode})`); } catch {}
    onConnect && onConnect(socket);
  });

  socket.on('disconnect', () => {
    try { console.log('[SocketHelper] Socket déconnecté'); } catch {}
    onDisconnect && onDisconnect();
  });

  socket.on('connect_error', (err) => {
    try { console.log(`[SocketHelper] Erreur de connexion (mode=${mode}):`, err?.message); } catch {}
    onError && onError(err);
  });

  if (typeof onServerStatus === 'function') {
    socket.on('server-status', (data) => onServerStatus(data));
  }

  if (typeof onAppsStatusUpdate === 'function') {
    socket.on('apps-status-update', (updatedApps) => onAppsStatusUpdate(updatedApps));
  }

  return socket;
}
