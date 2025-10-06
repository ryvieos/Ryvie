/**
 * Utilitaire pour détecter automatiquement le mode d'accès (privé/public)
 * Teste la connectivité au serveur local et bascule vers public si nécessaire
 */

import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { io } from 'socket.io-client';
import { isElectron } from './platformUtils';

// Etat global (source de vérité pour la session en cours)
let currentMode = null; // 'private' | 'public' | null
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
  try {
    const stored = localStorage.getItem('accessMode');
    if (stored === 'private' || stored === 'public') {
      currentMode = stored;
    }
  } catch {}
}

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
 * Récupère le mode d'accès actuel depuis localStorage
 * @returns {string|null} - 'private', 'public' ou null si non défini
 */
export function getCurrentAccessMode() {
  ensureLoadedFromStorage();
  
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
