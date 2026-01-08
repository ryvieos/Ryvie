import urlsConfig from '../config/urls';
const { getServerUrl, netbirdData, setLocalIP } = urlsConfig;
import { io, Socket } from 'socket.io-client';
import { isElectron } from './platformUtils';

type AccessMode = 'private' | 'public' | 'remote';

let currentMode: AccessMode | null = null;

function detectModeFromUrl(): AccessMode {
  if (typeof window === 'undefined') return 'private';
  
  const hostname = window.location.hostname;
  const port = window.location.port;
  const backendHost = netbirdData?.received?.backendHost;
  const domains = netbirdData?.domains || {};
  
  if (backendHost && hostname === backendHost) {
    console.log(`[AccessMode] Hostname ${hostname} = backendHost → mode REMOTE`);
    return 'public';
  }
  
  const allDomains = Object.values(domains);
  if (allDomains.includes(hostname)) {
    console.log(`[AccessMode] Hostname ${hostname} = domaine Netbird → mode REMOTE`);
    return 'public';
  }
  
  if (hostname.endsWith('.ryvie.fr')) {
    console.log(`[AccessMode] Hostname ${hostname} contient .ryvie.ovh → mode REMOTE`);
    return 'public';
  }
  
  if (hostname === 'ryvie.local' && (port === '80' || port === '')) {
    console.log(`[AccessMode] Hostname ${hostname}:${port || '80'} (Caddy same-origin) → mode PRIVATE`);
    return 'private';
  }
  
  console.log(`[AccessMode] Hostname ${hostname}:${port} → mode PRIVATE`);
  return 'private';
}

const listeners = new Set<(mode: AccessMode) => void>();

function notify(mode: AccessMode): void {
  for (const cb of Array.from(listeners)) {
    try { cb(mode); } catch {}
  }
}

function persist(mode: AccessMode): void {
  try { localStorage.setItem('accessMode', mode); } catch {}
}

function ensureLoadedFromStorage(): void {
  if (currentMode !== null) return;
  
  const urlMode = detectModeFromUrl();
  
  try {
    const stored = localStorage.getItem('accessMode') as AccessMode | null;
    if (urlMode !== stored) {
      console.log(`[AccessMode] URL indique ${urlMode}, stockage indique ${stored} → utilisation de ${urlMode}`);
      currentMode = urlMode;
      persist(urlMode);
      return;
    }
    if (stored === 'private' || stored === 'public' || stored === 'remote') {
      currentMode = stored;
    }
  } catch {}
  
  if (currentMode === null) {
    currentMode = urlMode;
    persist(urlMode);
  }
}

export async function detectAccessMode(timeout: number = 2000): Promise<AccessMode> {
  const urlMode = detectModeFromUrl();
  
  if (urlMode === 'public') {
    console.log('[AccessMode] URL indique mode REMOTE - pas de test de connectivité');
    setAccessMode('public');
    return 'public';
  }
  
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
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      console.log('[AccessMode] Timeout - Serveur local non accessible');
    } else {
      console.log('[AccessMode] Erreur de connexion:', error.message);
    }
  }

  console.log('[AccessMode] Basculement vers le mode REMOTE');
  setAccessMode('public');
  return 'public';
}

export function getCurrentAccessMode(): AccessMode | null {
  const urlMode = detectModeFromUrl();
  
  if (currentMode !== urlMode) {
    console.log(`[AccessMode] Mode actuel (${currentMode}) != URL (${urlMode}) → mise à jour`);
    currentMode = urlMode;
    persist(urlMode);
  }
  
  if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
    if (currentMode !== 'public') {
      console.log('[AccessMode] Page HTTPS détectée - forçage du mode REMOTE');
      setAccessMode('public');
    }
    return 'public';
  }
  
  return currentMode;
}

export function setAccessMode(mode: AccessMode): void {
  if (mode !== 'private' && mode !== 'public' && mode !== 'remote') {
    throw new Error('Mode d\'accès invalide. Utilisez "private" ou "remote".');
  }
  currentMode = mode;
  persist(mode);
  console.log(`[AccessMode] Mode forcé à: ${mode.toUpperCase()}`);
  notify(mode);
}

export async function testServerConnectivity(mode: AccessMode, timeout: number = 2000): Promise<boolean> {
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

export function subscribeAccessMode(cb: (mode: AccessMode) => void): () => void {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function unsubscribeAccessMode(cb: (mode: AccessMode) => void): void {
  listeners.delete(cb);
}

interface ConnectRyvieSocketParams {
  mode: AccessMode;
  onConnect?: (socket: Socket) => void;
  onDisconnect?: () => void;
  onError?: (err: Error) => void;
  onServerStatus?: (data: any) => void;
  onAppsStatusUpdate?: (updatedApps: any) => void;
  timeoutMs?: number;
}

export function connectRyvieSocket({
  mode,
  onConnect,
  onDisconnect,
  onError,
  onServerStatus,
  onAppsStatusUpdate,
  timeoutMs = 10000,
}: ConnectRyvieSocketParams): Socket | null {
  if (!mode) {
    try { console.log('[SocketHelper] Aucun mode fourni, annulation de la connexion'); } catch {}
    return null;
  }

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
