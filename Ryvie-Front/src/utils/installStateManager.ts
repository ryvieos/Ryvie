const STORAGE_KEY = 'ryvie_installing_apps';

interface InstallationData {
  appName: string;
  progress: number;
  startTime?: number;
  lastUpdate?: number;
}

interface InstallState {
  installations: Record<string, InstallationData>;
  timestamp: number;
}

export function saveInstallState(installingApps: Record<string, InstallationData>): void {
  try {
    const state: InstallState = {
      installations: installingApps,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[InstallStateManager] Erreur sauvegarde état:', error);
  }
}

export function loadInstallState(): Record<string, InstallationData> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    
    const state: InstallState = JSON.parse(stored);
    const age = Date.now() - (state.timestamp || 0);
    
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

export function clearInstallState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('[InstallStateManager] Erreur nettoyage état:', error);
  }
}

export function updateInstallation(appId: string, data: InstallationData): void {
  const state = loadInstallState();
  state[appId] = {
    ...data,
    lastUpdate: Date.now()
  };
  saveInstallState(state);
}

export function removeInstallation(appId: string): void {
  const state = loadInstallState();
  delete state[appId];
  
  if (Object.keys(state).length === 0) {
    clearInstallState();
  } else {
    saveInstallState(state);
  }
}

export function isInstalling(appId: string): boolean {
  const state = loadInstallState();
  return !!state[appId];
}
