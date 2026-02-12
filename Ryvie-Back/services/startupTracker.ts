/**
 * Service de suivi de l'initialisation des services au démarrage.
 * Chaque service s'enregistre, puis se marque comme terminé (ou en erreur).
 * Le serveur n'est "ready" que quand TOUS les services enregistrés sont terminés.
 */

interface ServiceStatus {
  name: string;
  status: 'pending' | 'done' | 'error';
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const services: Map<string, ServiceStatus> = new Map();
let readyCallback: (() => void) | null = null;

/**
 * Enregistre un service à tracker. Doit être appelé AVANT de lancer le service.
 */
function registerService(name: string): void {
  services.set(name, {
    name,
    status: 'pending',
    startedAt: Date.now()
  });
}

/**
 * Marque un service comme terminé avec succès.
 */
function markDone(name: string): void {
  const svc = services.get(name);
  if (svc) {
    svc.status = 'done';
    svc.finishedAt = Date.now();
    console.log(`[StartupTracker] ✅ ${name} terminé (${svc.finishedAt - svc.startedAt}ms)`);
    checkAllDone();
  }
}

/**
 * Marque un service comme terminé avec erreur (non bloquant pour le ready global).
 * Le service est considéré comme "terminé" même en erreur — il ne bloque pas le démarrage.
 */
function markError(name: string, error: string): void {
  const svc = services.get(name);
  if (svc) {
    svc.status = 'error';
    svc.error = error;
    svc.finishedAt = Date.now();
    console.log(`[StartupTracker] ⚠️ ${name} terminé avec erreur: ${error}`);
    checkAllDone();
  }
}

/**
 * Vérifie si tous les services sont terminés (done ou error).
 * Si oui, met global.serverReady = true et appelle le callback.
 */
function checkAllDone(): void {
  const allFinished = Array.from(services.values()).every(s => s.status !== 'pending');
  if (allFinished && !(global as any).serverReady) {
    (global as any).serverReady = true;
    const total = services.size;
    const errors = Array.from(services.values()).filter(s => s.status === 'error').length;
    console.log(`[StartupTracker] ✅ Tous les services sont initialisés (${total - errors}/${total} OK, ${errors} erreurs) - serveur prêt`);
    if (readyCallback) {
      readyCallback();
    }
  }
}

/**
 * Définit un callback appelé quand tous les services sont prêts.
 */
function onReady(callback: () => void): void {
  readyCallback = callback;
  // Si déjà prêt, appeler immédiatement
  if ((global as any).serverReady) {
    callback();
  }
}

/**
 * Retourne le statut de tous les services (pour /api/health/ready).
 */
function getStatus(): { ready: boolean; services: ServiceStatus[]; pending: string[] } {
  const allServices = Array.from(services.values());
  const pending = allServices.filter(s => s.status === 'pending').map(s => s.name);
  return {
    ready: (global as any).serverReady === true,
    services: allServices,
    pending
  };
}

/**
 * Retourne true si tous les services sont terminés.
 */
function isReady(): boolean {
  return (global as any).serverReady === true;
}

module.exports = {
  registerService,
  markDone,
  markError,
  onReady,
  getStatus,
  isReady
};
