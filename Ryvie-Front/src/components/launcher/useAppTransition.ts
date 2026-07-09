import React from 'react';

// ============================================================================
// useAppTransition — machine à états unique pour TOUTES les transitions d'une
// icône d'app (start / stop / restart / reset).
//
// Principe (identique au flux "exposition" déjà fiable, généralisé) :
//   1. Une seule opération à la fois par icône (verrou anti double-clic).
//   2. Le spinner (état "busy") est piloté UNIQUEMENT par le cycle de vie de
//      l'opération — jamais par le statut socket brut, qui est périmé (≤30 s,
//      dédupliqué) et faisait couper le spinner trop tôt sur un "running" pré-
//      redémarrage (bug de l'icône grise).
//   3. L'opération ne se termine que lorsque le BACKEND a confirmé (la requête
//      HTTP se résout : la route attend que l'app soit réellement saine) ET
//      qu'un plancher anti-flash s'est écoulé.
//   4. Le statut optimiste terminal ('running' / 'stopped') est écrit AVANT de
//      retirer le spinner -> aucun flash gris entre "spinner off" et "statut à
//      jour".
//   5. Filet de sécurité annulable : jamais de spinner figé indéfiniment, et pas
//      de vieux timer qui vienne tuer le spinner d'une opération plus récente.
// ============================================================================

export type OpKind = 'start' | 'stop' | 'restart' | 'reset';

export interface AppOp {
  kind: OpKind;
  startedAt: number;
}

export interface BeginOptions {
  // Statut optimiste écrit dès le lancement (ex: 'starting', 'partial'). undefined = ne rien écrire.
  optimisticStatus?: string | null;
  optimisticProgress?: number;
  // Statut optimiste écrit à la réussite, AVANT de retirer le spinner (ex: 'running', 'stopped').
  terminalStatus?: string | null;
  // Plancher anti-flash : durée minimale du spinner (ms).
  minFloorMs?: number;
  // Filet de sécurité : arrêt forcé si la requête ne se résout jamais (ms).
  // Doit être > au timeout HTTP de la requête pour ne pas couper une op en cours.
  safetyMs?: number;
  // L'appel API. Sa RÉSOLUTION = signal fiable "opération terminée".
  run: () => Promise<any>;
  // Effets différés joués à la réussite (ex: toast "accès réinitialisé").
  onDone?: (result: any) => void;
  // Callback en cas d'échec (restauration du statut + message d'erreur).
  onError?: (err: any) => void;
}

interface UseAppTransitionArgs {
  id: string;
  setAppStatus?: (updater: any) => void;
  refreshDesktopIcons?: () => void;
}

export function useAppTransition({ id, setAppStatus, refreshDesktopIcons }: UseAppTransitionArgs) {
  const [op, setOp] = React.useState<AppOp | null>(null);

  // Toute la logique vit dans des refs (insensibles aux re-renders / closures périmées).
  const opRef = React.useRef<AppOp | null>(null);
  const floorTimerRef = React.useRef<any>(null);
  const safetyTimerRef = React.useRef<any>(null);
  const floorElapsedRef = React.useRef(true);
  const settledRef = React.useRef(false);
  const settleResultRef = React.useRef<any>(null);
  const terminalStatusRef = React.useRef<string | null | undefined>(undefined);
  const onDoneRef = React.useRef<((r: any) => void) | null>(null);
  const mountedRef = React.useRef(true);

  const clearTimers = React.useCallback(() => {
    if (floorTimerRef.current) { clearTimeout(floorTimerRef.current); floorTimerRef.current = null; }
    if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
  }, []);

  // Nettoyage au démontage : aucun timer ne survit à l'icône.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; clearTimers(); };
  }, [clearTimers]);

  const writeStatus = React.useCallback((status?: string | null, progress?: number) => {
    if (status == null || !setAppStatus) return;
    setAppStatus((prev: any) => ({
      ...prev,
      [id]: { ...((prev && prev[id]) || {}), status, ...(progress != null ? { progress } : {}) },
    }));
  }, [id, setAppStatus]);

  const finish = React.useCallback((phase: 'done' | 'failed', result?: any) => {
    clearTimers();
    if (phase === 'done') {
      // Statut optimiste terminal AVANT de retirer le spinner (pas de flash gris).
      if (terminalStatusRef.current != null) writeStatus(terminalStatusRef.current);
    }
    const done = onDoneRef.current;
    opRef.current = null;
    settledRef.current = false;
    settleResultRef.current = null;
    terminalStatusRef.current = undefined;
    onDoneRef.current = null;
    if (mountedRef.current) setOp(null);
    if (phase === 'done' && done) { try { done(result); } catch (_) {} }
    // Réconciliation finale (recharge config/statut réel).
    if (refreshDesktopIcons) { try { refreshDesktopIcons(); } catch (_) {} }
  }, [clearTimers, writeStatus, refreshDesktopIcons]);

  // Termine dès que les DEUX conditions sont réunies : confirmé backend + plancher écoulé.
  const tryComplete = React.useCallback(() => {
    if (!opRef.current) return;
    if (settledRef.current && floorElapsedRef.current) {
      finish('done', settleResultRef.current);
    }
  }, [finish]);

  const begin = React.useCallback((kind: OpKind, opts: BeginOptions): boolean => {
    // Verrou : une seule opération à la fois.
    if (opRef.current) return false;

    const newOp: AppOp = { kind, startedAt: Date.now() };
    opRef.current = newOp;
    settledRef.current = false;
    settleResultRef.current = null;
    terminalStatusRef.current = opts.terminalStatus;
    onDoneRef.current = opts.onDone || null;
    if (mountedRef.current) setOp(newOp);

    // Statut optimiste de lancement.
    if (opts.optimisticStatus !== undefined) {
      writeStatus(opts.optimisticStatus, opts.optimisticProgress);
    }

    // Plancher anti-flash.
    const floor = opts.minFloorMs || 0;
    floorElapsedRef.current = floor <= 0;
    if (floor > 0) {
      floorTimerRef.current = setTimeout(() => {
        floorElapsedRef.current = true;
        tryComplete();
      }, floor);
    }

    // Filet de sécurité (arrêt forcé) — annulable, propre à cette op.
    const safety = opts.safetyMs || 130000;
    safetyTimerRef.current = setTimeout(() => {
      if (opRef.current !== newOp) return;
      settledRef.current = true;
      floorElapsedRef.current = true;
      finish('done', settleResultRef.current);
    }, safety);

    // Lancement de la requête : sa résolution = confirmation backend.
    Promise.resolve()
      .then(() => opts.run())
      .then((result) => {
        if (opRef.current !== newOp) return; // op supersédée / démontée
        settledRef.current = true;
        settleResultRef.current = result;
        tryComplete();
      })
      .catch((err) => {
        if (opRef.current !== newOp) return;
        if (opts.onError) { try { opts.onError(err); } catch (_) {} }
        finish('failed');
      });

    return true;
  }, [writeStatus, tryComplete, finish]);

  return { op, isBusy: op !== null, begin };
}

export default useAppTransition;
