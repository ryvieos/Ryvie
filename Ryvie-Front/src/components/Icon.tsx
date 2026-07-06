import React from 'react';
import ReactDOM from 'react-dom';
import { useDrag } from 'react-dnd';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
import { useLanguage } from '../contexts/LanguageContext';
import AppSettingsModal from './AppSettingsModal';

const { getServerUrl } = urlsConfig;
const ItemTypes = { ICON: 'icon' };

// Set global pour empêcher plusieurs désinstallations parallèles de la même app
const uninstallInProgress = new Set();

// Composant ContextMenuPortal
const ContextMenuPortal = ({ children, x, y }) => {
  const menu = (
    <div
      className="context-menu"
      style={{
        position: 'fixed',
        left: `${x}px`,
        top: `${y}px`,
        zIndex: 10000,
        pointerEvents: 'auto',
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
  return ReactDOM.createPortal(menu, document.body);
};

// Composant Icon avec React.memo pour éviter les re-renders inutiles
const Icon = React.memo(({ id, src, installInfo, zoneId, moveIcon, handleClick, showName, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus, accessMode, refreshDesktopIcons, isNew, onBusyChange }) => {
  const { t } = useLanguage();
  const appConfig = appsConfig[id] || {};
  const [imgSrc, setImgSrc] = React.useState(src);
  const [imgError, setImgError] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState(null);
  // Plancher de durée du spinner de réinitialisation d'accès (10 s minimum)
  const [resetMinElapsed, setResetMinElapsed] = React.useState(true);
  // Spinner d'exposition (création/suppression d'adresse publique) :
  // - exposureMinElapsed : ≥10 s écoulées (plancher anti-flash)
  // - exposureSettled : le backend a CONFIRMÉ que l'app est de nouveau joignable
  //   (création : adresse publique qui répond ; suppression : app de retour en
  //   local). C'est le signal fiable — le statut socket est trop tardif (≤30 s).
  const [exposureMinElapsed, setExposureMinElapsed] = React.useState(true);
  const [exposureSettled, setExposureSettled] = React.useState(true);
  const [isUninstalling, setIsUninstalling] = React.useState(false);
  const isProcessingMenuActionRef = React.useRef(false);
  // Résultat d'un reset d'accès en attente d'affichage (montré quand le spinner s'arrête)
  const resetResultRef = React.useRef<any>(null);
  const [confirmModal, setConfirmModal] = React.useState({ show: false, type: '', title: '', message: '', onConfirm: null });
  const [settingsModalOpen, setSettingsModalOpen] = React.useState(false);

  // L'app gère-t-elle des comptes internes réinitialisables ? (non-SSO + recette)
  const canManageAccounts = appConfig.sso !== true && !!appConfig.hasAccounts;
  // L'app propose-t-elle une réinitialisation d'accès native (CLI, ex. n8n) ?
  const canResetOwner = appConfig.sso !== true && !!appConfig.hasOwnerReset;
  // L'app expose-t-elle des fichiers de config éditables ? (édition YAML zéro-terminal)
  const canEditConfig = !!appConfig.hasConfigEditor;
  // Onglet « Adresse publique » : pas pour les apps Ryvie dont l'exposition est native
  const EXPOSURE_NATIVE_APPS = ['rdrive', 'rpictures', 'rtransfer', 'rdrop'];
  const showExposure = !!appConfig.id &&
    !EXPOSURE_NATIVE_APPS.includes(String(appConfig.id).toLowerCase().replace(/^ryvie-/, ''));
  // Fenêtre « Réglages » (onglets : adresse publique / comptes / config avancée) :
  // affichée dès qu'au moins un onglet est disponible.
  const canOpenSettings = showExposure || canManageAccounts || canEditConfig;
  
  React.useEffect(() => {
    setImgSrc(src);
    setImgError(false);
  }, [src]);
  
  React.useEffect(() => {
    if (pendingAction === 'stopping' && appStatusData?.status === 'stopped') {
      setPendingAction(null);
    } else if (pendingAction === 'starting' && appStatusData?.status === 'running') {
      setPendingAction(null);
    } else if (pendingAction === 'resetting' && appStatusData?.status === 'running' && resetMinElapsed) {
      // Reset : le spinner s'arrête quand l'app est RÉELLEMENT "running" (accessible)
      // ET qu'au moins 10 s se sont écoulées (plancher). Sûr car on pose un statut
      // optimiste "starting" au début (sinon ça couperait tout de suite).
      setPendingAction(null);
      // La notif « Accès réinitialisé » s'affiche PILE maintenant (spinner arrêté).
      const r = resetResultRef.current;
      if (r) {
        resetResultRef.current = null;
        setConfirmModal({ show: true, type: 'success', title: r.title, message: r.message, onConfirm: () => closeModal() } as any);
      }
    }
    // L'arrêt du spinner d'exposition n'est PAS géré ici : le statut socket est
    // trop tardif (rafraîchi ≤30 s, et seulement sur changement) pour voir le
    // bref passage hors-ligne du redémarrage → on s'appuie sur la confirmation
    // backend (exposureSettled), cf. l'effet dédié plus bas.
  }, [appStatusData?.status, pendingAction, resetMinElapsed]);
  
  const handleImageError = () => {
    if (imgError) return;
    setImgError(true);
  };

  const ref = React.useRef(null);
  
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.ICON,
    item: { id, zoneId },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  drag(ref);

  // === État visuel de l'icône (remplace l'ancien système de pastilles) ===
  const status = appStatusData?.status;
  // Installation ou mise à jour en cours -> camembert de progression
  const isInstalling = !!installInfo;
  // Plafonné à 95% : le camembert n'est retiré que lorsque l'app est réellement
  // "running" (cf. Home), donc on garde toujours une petite part grise tant que
  // l'app n'est pas prête, même si le téléchargement est à 100%.
  const installPercent = isInstalling
    ? Math.max(0, Math.min(95, Math.round(installInfo.progress || 0)))
    : 0;

  // États transitoires -> grise + spinner UNIQUEMENT pour une action explicite de
  // l'utilisateur (start/stop/restart/désinstallation). On n'affiche PAS le spinner
  // pour un statut "starting"/"partial" passif (ex: démarrage automatique après une
  // installation), qui ressemblerait à tort à un redémarrage.
  const isTransitioning = !isInstalling && appConfig.showStatus && (
    isUninstalling ||
    pendingAction === 'starting' || pendingAction === 'stopping' ||
    pendingAction === 'resetting' || pendingAction === 'exposing'
  );

  // App arrêtée -> grise fixe
  const isStopped = !isInstalling && !isTransitioning && appConfig.showStatus &&
    (!status || status !== 'running');

  // L'icône doit-elle être assombrie/grisée ?
  const isDimmed = isInstalling || isTransitioning || isStopped;

  // Vérifier si l'app est cliquable. Règle simple : une icône GRISÉE (arrêtée) ou
  // avec un SPINNER (installation, démarrage, arrêt, reset, exposition, ou les
  // deux) n'ouvre JAMAIS l'app — on tomberait sur une URL qui ne répond pas
  // encore. On n'ouvre que si l'icône est en état normal (ni grisée, ni spinner)
  // et réellement « running ».
  const isClickable = !isDimmed && (!appConfig.showStatus || status === 'running');

  // Remonte l'état « occupé » (grisé / spinner) au launcher : la tuile parente a
  // sa propre logique de clic qui ne voit PAS les états transitoires internes
  // (pendingAction) → sans ça elle ouvrirait l'app pendant le spinner.
  const prevBusyRef = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    if (prevBusyRef.current !== isDimmed) {
      prevBusyRef.current = isDimmed;
      onBusyChange?.(id, isDimmed);
    }
  }, [id, isDimmed, onBusyChange]);
  
  const handleIconClick = () => {
    // Ne rien faire si l'app n'est pas running (rouge ou orange)
    if (!isClickable) {
      console.log('[Icon] App non disponible:', id, 'Status:', appStatusData?.status);
      return;
    }
    // Ne pas ouvrir si un menu contextuel est actif
    if (activeContextMenu) return;
    // Ne pas ouvrir si une action de menu est en cours de traitement
    if (isProcessingMenuActionRef.current) return;
    handleClick(id);
  };

  // ── Spinner « exposition d'une adresse publique » (création ou suppression) ──
  // Démarre quand l'opération est lancée dans la modale Réglages. Le spinner tient
  // au moins 10 s (plancher anti-flash) et ne s'arrête que lorsque le BACKEND a
  // confirmé que l'app est de nouveau joignable (exposureSettled) — la requête
  // create/delete ne répond qu'après avoir sondé l'app post-redémarrage. On ne se
  // fie PAS au statut socket : il est rafraîchi au plus toutes les 30 s (et
  // seulement sur changement), donc il rate souvent le bref passage hors-ligne du
  // redémarrage → le spinner s'arrêtait avant que l'app ne grise, d'où les
  // « connection refused » / « route not configured » au clic.
  const exposureSafetyRef = React.useRef<any>(null);
  const exposureMinTimerRef = React.useRef<any>(null);

  const stopExposureSpinner = React.useCallback((markRunning = false) => {
    if (exposureSafetyRef.current) { clearTimeout(exposureSafetyRef.current); exposureSafetyRef.current = null; }
    if (exposureMinTimerRef.current) { clearTimeout(exposureMinTimerRef.current); exposureMinTimerRef.current = null; }
    // Succès confirmé par le backend (markRunning) : on pose un statut optimiste
    // « running » AVANT de retirer le spinner. Sinon le statut socket (rafraîchi
    // ≤30 s) est encore périmé et l'icône resterait grisée SANS spinner ~2 s avant
    // de revenir. Comme le backend a sondé l'app (elle répond), c'est exact.
    if (markRunning && setAppStatus) {
      setAppStatus((prev: any) => ({ ...prev, [id]: { ...(prev?.[id] || {}), status: 'running' } }));
    }
    setPendingAction((p) => (p === 'exposing' ? null : p));
    // Rafraîchit une dernière fois l'icône (image/statut) une fois l'op terminée.
    if (refreshDesktopIcons) { try { refreshDesktopIcons(); } catch (_) {} }
  }, [refreshDesktopIcons, setAppStatus, id]);

  const handleExposureStart = React.useCallback((_op: 'create' | 'delete' = 'create') => {
    setPendingAction('exposing');
    setExposureSettled(false);
    // Plancher anti-flash : le spinner tourne au moins 10 s.
    setExposureMinElapsed(false);
    if (exposureMinTimerRef.current) clearTimeout(exposureMinTimerRef.current);
    exposureMinTimerRef.current = setTimeout(() => setExposureMinElapsed(true), 10000);

    // Filet de sécurité : ne jamais laisser le spinner tourner plus de 5 min
    // (au cas où la requête create/delete n'aboutirait jamais).
    if (exposureSafetyRef.current) clearTimeout(exposureSafetyRef.current);
    exposureSafetyRef.current = setTimeout(stopExposureSpinner, 300000);
  }, [stopExposureSpinner]);

  // Le backend a confirmé que l'app est de nouveau joignable (réponse create/delete
  // reçue) → on autorise l'arrêt du spinner (effectif après le plancher de 10 s).
  const handleExposureSettled = React.useCallback(() => {
    setExposureSettled(true);
  }, []);

  // Échec de l'opération → on coupe le spinner tout de suite
  const handleExposureError = React.useCallback(() => {
    stopExposureSpinner();
  }, [stopExposureSpinner]);

  // Arrêt du spinner d'exposition : app confirmée joignable par le backend ET
  // plancher de 10 s écoulé.
  React.useEffect(() => {
    if (pendingAction === 'exposing' && exposureSettled && exposureMinElapsed) {
      // Succès : statut optimiste « running » → pas de gris résiduel sans spinner.
      stopExposureSpinner(true);
    }
  }, [pendingAction, exposureSettled, exposureMinElapsed, stopExposureSpinner]);

  // Nettoyage si l'icône est démontée pendant l'opération
  React.useEffect(() => () => {
    if (exposureSafetyRef.current) clearTimeout(exposureSafetyRef.current);
    if (exposureMinTimerRef.current) clearTimeout(exposureMinTimerRef.current);
  }, []);

  const handleContextMenu = (e) => {
    // IMPORTANT: Toujours empêcher le menu natif du navigateur en premier
    e.preventDefault();
    e.stopPropagation();
    
    console.log(`[Icon] 🖱️ Clic droit sur ${id}`);
    console.log(`[Icon] showStatus:`, appConfig.showStatus);
    console.log(`[Icon] isAdmin:`, isAdmin);
    
    if (!appConfig.showStatus) {
      console.log(`[Icon] ❌ Menu bloqué: showStatus = false`);
      return;
    }
    if (!isAdmin) {
      console.log(`[Icon] ❌ Menu bloqué: pas admin`);
      return;
    }
    
    const iconRect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 110;

    let x = iconRect.right + 8;
    let y = iconRect.top + iconRect.height / 2 - menuHeight / 2;

    if (x + menuWidth > window.innerWidth) {
      x = iconRect.left - menuWidth - 8;
    }
    if (y < 8) y = 8;
    if (y + menuHeight > window.innerHeight - 8) y = window.innerHeight - menuHeight - 8;

    console.log(`[Icon] ✅ Affichage du menu à (${x}, ${y})`);
    setActiveContextMenu({ iconId: id, x, y });
  };

  // Fonction pour exécuter la désinstallation (appelée après confirmation)
  const executeUninstall = async (appId, appName, appKey) => {
    // Empêcher plusieurs appels parallèles pour la même app (double clic, re-renders, etc.)
    if (uninstallInProgress.has(appId)) {
      console.log(`[Icon] ⏭️  Désinstallation déjà en cours pour ${appId}`);
      return;
    }
    uninstallInProgress.add(appId);

    setPendingAction('stopping');
    setIsUninstalling(true);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      const uninstallUrl = `${serverUrl}/api/appstore/apps/${appId}/uninstall`;
      console.log(`[Icon] 📡 DELETE ${uninstallUrl}`);
      const response = await axios.delete(uninstallUrl, { timeout: 120000 });
      console.log(`[Icon] ✅ Désinstallation de ${appName} lancée en arrière-plan`);

      // La notification sera envoyée par le backend quand la désinstallation sera vraiment terminée
      // Ne pas afficher de notification ici car c'est juste le lancement
      
      // NE PAS arrêter l'animation pulse ici - elle doit continuer jusqu'à ce que l'icône disparaisse
      // L'icône disparaîtra automatiquement quand le backend émettra l'événement 'app-uninstalled'
    } catch (error) {
      console.error(`[Icon] ❌ Erreur lors de la désinstallation de ${appName}:`, error);
      setIsUninstalling(false);
      setPendingAction(null);
      
      const errorMsg = error.response?.data?.message || error.message;
      setConfirmModal({
        show: true,
        type: 'error',
        title: t('icon.error'),
        message: t('icon.uninstallError').replace('{appName}', appName).replace('{error}', errorMsg),
        onConfirm: () => setConfirmModal({ show: false, type: '', title: '', message: '', onConfirm: null })
      });
    } finally {
      uninstallInProgress.delete(appId);
    }
  };

  const modalClosingRef = React.useRef(false);

  // Fermer la modal
  const closeModal = React.useCallback(() => {
    modalClosingRef.current = true;
    setConfirmModal({ show: false, type: '', title: '', message: '', onConfirm: null });
    // Réinitialiser après un court délai
    setTimeout(() => {
      modalClosingRef.current = false;
    }, 500);
  }, []);

  // Gérer le clic sur l'overlay
  const handleOverlayClick = React.useCallback((e) => {
    // Pour les modales de succès/erreur, le clic à l'extérieur ne doit rien faire :
    // l'utilisateur doit obligatoirement cliquer sur OK.
    if (confirmModal.type === 'success' || confirmModal.type === 'error') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Pour les modales de confirmation (type "danger"), autoriser la fermeture par clic sur l'overlay
    if (e.target === e.currentTarget) {
      e.nativeEvent.stopImmediatePropagation();
      e.stopPropagation();
      e.preventDefault();
      closeModal();
    }
  }, [closeModal, confirmModal.type]);

  // Bloquer tous les événements de l'overlay
  const blockAllEvents = React.useCallback((e) => {
    if (e.nativeEvent && e.nativeEvent.stopImmediatePropagation) {
      e.nativeEvent.stopImmediatePropagation();
    }
    e.stopPropagation();
    e.preventDefault();
  }, []);

  // Composant modal de confirmation (rendu via portal)
  const ConfirmModalPortal = () => {
    if (!confirmModal.show) return null;
    
    const isError = confirmModal.type === 'error';
    const isSuccess = confirmModal.type === 'success';
    const isDanger = confirmModal.type === 'danger';
    
    // Empêcher tous les événements de se propager
    const stopAllEvents = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    
    return ReactDOM.createPortal(
      <div 
        className="confirm-modal-overlay" 
        onClick={handleOverlayClick}
        onMouseDown={blockAllEvents}
        onMouseUp={blockAllEvents}
        onMouseMove={blockAllEvents}
        onDragStart={blockAllEvents}
        onDrag={blockAllEvents}
        onDragEnd={blockAllEvents}
        onPointerDown={blockAllEvents}
        onPointerMove={blockAllEvents}
        onPointerUp={blockAllEvents}
      >
        <div 
          className={`confirm-modal ${confirmModal.type}`} 
          onClick={stopAllEvents}
          onMouseDown={stopAllEvents}
          onMouseUp={stopAllEvents}
          onMouseMove={stopAllEvents}
        >
          <div className="confirm-modal-icon">
            {isError && '❌'}
            {isSuccess && '✅'}
            {isDanger && '⚠️'}
          </div>
          <h3 className="confirm-modal-title">{confirmModal.title}</h3>
          <p className="confirm-modal-message">{confirmModal.message}</p>
          <div className="confirm-modal-buttons">
            {(isError || isSuccess) ? (
              <button 
                className="confirm-modal-btn confirm-modal-btn-primary" 
                onClick={(e) => { e.stopPropagation(); confirmModal.onConfirm(); }}
              >
                OK
              </button>
            ) : (
              <>
                <button 
                  className="confirm-modal-btn confirm-modal-btn-cancel" 
                  onClick={(e) => { e.stopPropagation(); closeModal(); }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="confirm-modal-btn confirm-modal-btn-danger"
                  onClick={(e) => { e.stopPropagation(); confirmModal.onConfirm(); }}
                >
                  {confirmModal.confirmLabel || t('common.uninstall')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const handleOwnerReset = () => {
    setActiveContextMenu(null);
    if (confirmModal.show || modalClosingRef.current) return;
    const appId = appConfig.id;
    const appName = appConfig.name || id;
    setConfirmModal({
      show: true,
      type: 'danger',
      title: t('icon.resetAccessTitle').replace('{appName}', appName),
      message: t('icon.resetAccessMessage'),
      confirmLabel: t('icon.resetAccess'),
      onConfirm: async () => {
        setConfirmModal({ show: false, type: '', title: '', message: '', onConfirm: null });
        // Spinner + statut optimiste "starting" (comme un redémarrage) : le spinner
        // restera tant que l'app n'est pas réellement revenue "running" (accessible)
        // ET au moins 10 s (plancher, pour éviter un flash trop court).
        setPendingAction('resetting');
        setResetMinElapsed(false);
        setTimeout(() => setResetMinElapsed(true), 10000);
        if (setAppStatus) {
          setAppStatus((prev: any) => ({ ...prev, [id]: { ...(prev?.[id] || {}), status: 'starting', progress: 50 } }));
        }

        try {
          const serverUrl = getServerUrl(accessMode);
          const res = await axios.post(`${serverUrl}/api/apps/${appId}/reset-owner`, {}, { _noAuthRedirect: true });
          // Succès : on N'AFFICHE PAS la notif tout de suite. On la mémorise et elle
          // sera montrée PILE quand le spinner s'arrêtera (app de retour "running").
          resetResultRef.current = { title: t('icon.resetAccessDone'), message: res.data?.message || '' };
          // Rafraîchir le statut en rafale ; l'effet coupe le spinner quand c'est prêt.
          if (refreshDesktopIcons) {
            [0, 2000, 5000, 10000, 20000, 35000, 55000].forEach((ms) =>
              setTimeout(() => { try { refreshDesktopIcons(); } catch (_) {} }, ms)
            );
          }
          // Filet de sécurité : si "running" n'est jamais détecté, on coupe le spinner
          // et on affiche quand même la notif au bout de 90 s.
          setTimeout(() => {
            setPendingAction(null);
            const r = resetResultRef.current;
            if (r) {
              resetResultRef.current = null;
              setConfirmModal({ show: true, type: 'success', title: r.title, message: r.message, onConfirm: () => closeModal() } as any);
            }
          }, 90000);
        } catch (e) {
          // Erreur : on coupe le spinner et on affiche l'erreur immédiatement.
          resetResultRef.current = null;
          setConfirmModal({
            show: true, type: 'error',
            title: t('icon.error'),
            message: e?.response?.data?.error || String(e?.message || ''),
            onConfirm: () => closeModal(),
          });
          setPendingAction(null);
          if (refreshDesktopIcons) { try { refreshDesktopIcons(); } catch (_) {} }
        }
      },
    });
  };

  const handleAppAction = async (action) => {
    console.log(`[Icon] 🔴 handleAppAction appelé avec action: ${action}, iconId: ${id}`);
    console.log(`[Icon] 📍 accessMode:`, accessMode);
    console.log(`[Icon] 📍 appConfig:`, appConfig);
    
    // Marquer qu'une action est en cours pour bloquer les clics
    isProcessingMenuActionRef.current = true;
    
    // Fermer le menu contextuel immédiatement
    setActiveContextMenu(null);
    
    // Réinitialiser le flag après un court délai
    setTimeout(() => {
      isProcessingMenuActionRef.current = false;
    }, 500);
    
    // Validation: vérifier que l'ID de l'app existe
    if (!appConfig.id) {
      console.error(`[Icon] ❌ Action ${action} impossible: appConfig.id manquant`);
      console.error('[Icon] ID de l\'icône:', id);
      console.error('[Icon] Config:', appConfig);
      alert(t('icon.errorMissingAppId').replace('{id}', appConfig.name || id));
      return;
    }

    const appId = appConfig.id;
    const appName = appConfig.name || id;
    const appKey = id; // La clé utilisée dans appStatus
    
    // Confirmation pour la désinstallation via modal moderne
    if (action === 'uninstall') {
      // Empêcher les clics multiples ou réouverture après fermeture
      if (confirmModal.show || modalClosingRef.current) return;
      setConfirmModal({
        show: true,
        type: 'danger',
        title: t('icon.confirmUninstallTitle').replace('{appName}', appName),
        message: t('icon.confirmUninstallMessage'),
        onConfirm: () => {
          setConfirmModal({ show: false, type: '', title: '', message: '', onConfirm: null });
          executeUninstall(appId, appName, appKey);
        }
      });
      return;
    }
    
    // Définir l'action en cours (pour l'affichage du badge)
    if (action === 'stop') {
      setPendingAction('stopping');
    } else if (action === 'start' || action === 'restart') {
      setPendingAction('starting');
    } else if (action === 'uninstall') {
      // On garde le badge en mode "arrêt" mais on ne touche pas à appStatus global
      setPendingAction('stopping');
      setIsUninstalling(true);
    }
    
    // Mise à jour optimiste du statut (avant l'appel API)
    if (setAppStatus) {
      setAppStatus(prevStatus => {
        const newStatus = { ...prevStatus };
        
        if (action === 'stop') {
          console.log(`[Icon] ⏹️  ${appName} - Mise à jour optimiste: partial (arrêt en cours)`);
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'partial',
            progress: 50
          };
        } else if (action === 'start' || action === 'restart') {
          console.log(`[Icon] ▶️  ${appName} - Mise à jour optimiste: starting`);
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'starting',
            progress: 50
          };
        }
        
        return newStatus;
      });
    }
    
    // Appel API vers le backend
    try {
      const serverUrl = getServerUrl(accessMode);
      
      // Gestion spéciale du restart: tenter /restart, sinon fallback stop+start
      if (action === 'restart') {
        const restartUrl = `${serverUrl}/api/apps/${appId}/restart`;
        console.log(`[Icon] 📡 POST ${restartUrl}`);
        try {
          const resp = await axios.post(restartUrl, {}, { timeout: 120000, headers: { 'Content-Type': 'application/json' } });
          console.log('[Icon] ✅ restart terminé avec succès', resp.data);
        } catch (err) {
          const status = err?.response?.status;
          console.warn(`[Icon] ⚠️  /restart indisponible (status ${status}). Fallback stop+start`);
          // Fallback: stop puis start séquentiels
          const stopUrl = `${serverUrl}/api/apps/${appId}/stop`;
          console.log(`[Icon] 📡 POST ${stopUrl}`);
          await axios.post(stopUrl, {}, { timeout: 120000, headers: { 'Content-Type': 'application/json' } });
          // Mise à jour optimiste: partial
          if (setAppStatus) {
            setAppStatus(prev => ({
              ...prev,
              [appKey]: { ...(prev[appKey] || {}), status: 'partial', progress: 50 }
            }));
          }
          const startUrl = `${serverUrl}/api/apps/${appId}/start`;
          console.log(`[Icon] 📡 POST ${startUrl}`);
          await axios.post(startUrl, {}, { timeout: 120000, headers: { 'Content-Type': 'application/json' } });
          console.log('[Icon] ✅ restart (stop+start) terminé avec succès');
        }
      } else {
        const apiUrl = `${serverUrl}/api/apps/${appId}/${action}`;
        console.log(`[Icon] 📡 POST ${apiUrl}`);
        const response = await axios.post(apiUrl, {}, { 
          timeout: 120000,
          headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[Icon] ✅ ${action} de ${appName} terminé avec succès`);
        console.log('[Icon] Réponse:', response.data);
      }

      // IMPORTANT : le backend renvoie souvent AVANT que l'app soit réellement prête
      // (start/restart lancent la commande mais n'attendent pas que les conteneurs soient
      // sains). On NE force donc PAS le statut "running" ici (sinon le spinner s'arrête
      // trop tôt). On garde pendingAction (= spinner) et on rafraîchit le statut en rafale :
      // l'effet de reset (cf. useEffect plus haut) coupera le spinner quand le statut réel
      // sera "running" (start/restart) ou "stopped" (stop) — donc quand l'app est accessible.
      if (refreshDesktopIcons) {
        [0, 2000, 5000, 10000, 20000, 35000, 55000].forEach(ms => setTimeout(() => {
          try { refreshDesktopIcons(); } catch (_) {}
        }, ms));
      }
      // Filet de sécurité : ne pas laisser le spinner tourner indéfiniment si le statut
      // "running" n'est jamais détecté.
      setTimeout(() => setPendingAction(null), 90000);

    } catch (error) {
      console.error(`[Icon] ❌ Erreur lors de ${action} de ${appName}`);
      console.error('[Icon] Détails de l\'erreur:', error);
      
      // Réinitialiser l'action en cours
      setPendingAction(null);
      setIsUninstalling(false);

      // Restaurer le statut précédent en cas d'erreur
      if (setAppStatus && appStatusData) {
        console.log(`[Icon] 🔙 Restauration du statut précédent pour ${appName}`);
        setAppStatus(prevStatus => ({
          ...prevStatus,
          [appKey]: appStatusData
        }));
      }
      
      // Message d'erreur détaillé
      let errorMsg = error.response?.data?.message || error.message;
      if (error.code === 'ECONNABORTED') {
        errorMsg = 'Timeout - l\'opération prend plus de 2 minutes';
      } else if (error.response?.status === 404) {
        errorMsg = 'Application non trouvée sur le serveur';
      } else if (error.response?.status === 500) {
        errorMsg = 'Erreur serveur interne';
      }
      
      alert(t('icon.actionError').replace('{action}', action).replace('{appName}', appName).replace('{error}', errorMsg));
    }
  };

  return (
    <>
      {/* Modal de confirmation */}
      <ConfirmModalPortal />

      {/* Modal Réglages de l'app (admin) : onglets adresse publique / comptes / config */}
      {settingsModalOpen && (
        <AppSettingsModal
          appId={appConfig.id || id}
          appName={appConfig.name || id}
          accessMode={accessMode}
          showExposure={showExposure}
          hasAccounts={canManageAccounts}
          hasConfigEditor={canEditConfig}
          onClose={() => setSettingsModalOpen(false)}
          onExposureStart={handleExposureStart}
          onExposureSettled={handleExposureSettled}
          onExposureError={handleExposureError}
        />
      )}

      {!imgError && (
        <div className="icon-container">
          <div
            ref={ref}
            className={`icon ${isUninstalling ? 'icon-uninstalling' : ''} ${isStopped ? 'icon--stopped' : ''} ${isTransitioning ? 'icon--busy' : ''} ${isInstalling ? 'icon--installing' : ''}`}
            style={{
              cursor: isClickable ? 'pointer' : 'not-allowed',
              position: 'relative',
            }}
            onClick={handleIconClick}
            onContextMenu={handleContextMenu}
          >
            {/* Image de base (grisée pendant installation / transition / arrêt via classes) */}
            <img
              className="icon-img"
              src={imgSrc}
              alt={appConfig.name || installInfo?.appName || id}
              onError={handleImageError}
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '20px' }}
            />
            {/* Installation / mise à jour :
                - l'icône garde ses vraies couleurs (pas de filtre)
                - un calque gris recouvre tout SAUF un cercle au centre
                - dans ce cercle, le camembert révèle la couleur (part faite = transparente) */}
            {isInstalling && (
              <>
                <div className="icon-grey-overlay"></div>
                <div className="icon-progress">
                  <div className="icon-progress-disc" style={{ ['--icon-progress' as any]: `${installPercent}%` }}></div>
                </div>
              </>
            )}
            {/* Démarrage / arrêt / redémarrage en cours : spinner indéterminé centré */}
            {isTransitioning && (
              <div className="icon-progress"><div className="icon-spinner-ring"></div></div>
            )}
            {/* Pastille bleue : app installée jamais encore ouverte (disparaît à la 1re ouverture) */}
            {isNew && !isInstalling && (
              <span
                aria-label="nouvelle app"
                style={{
                  position: 'absolute', top: -3, right: -3,
                  width: 13, height: 13, borderRadius: '50%',
                  background: '#2f6bff', border: '2px solid rgba(255,255,255,0.92)',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.45)', zIndex: 6, pointerEvents: 'none',
                }}
              />
            )}
          </div>
          {showName && <p className="icon-name">{appConfig.name || installInfo?.appName || id.replace('.jpeg', '').replace('.png', '').replace('.svg', '')}</p>}
        </div>
      )}
      
      {!imgError && activeContextMenu && activeContextMenu.iconId === id && (
        <ContextMenuPortal x={activeContextMenu.x} y={activeContextMenu.y}>
          {/* Show stop/restart when running OR when in pending state (orange blinking) */}
          {(appStatusData?.status === 'running' || pendingAction === 'starting' || pendingAction === 'stopping') ? (
            <>
              <div 
                className="context-menu-item" 
                onClick={(e) => { 
                  console.log('[Icon] 🖱️ Clic sur Arrêter');
                  e.preventDefault();
                  e.stopPropagation(); 
                  handleAppAction('stop'); 
                }}
              >
                <span className="context-menu-icon context-menu-icon-stop" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <rect x="6" y="6" width="12" height="12" rx="3" ry="3" />
                  </svg>
                </span>
                <span>{t('icon.stop')}</span>
              </div>
              <div className="context-menu-separator" role="separator" />
              <div 
                className="context-menu-item" 
                onClick={(e) => { 
                  console.log('[Icon] 🖱️ Clic sur Redémarrer');
                  e.preventDefault();
                  e.stopPropagation(); 
                  handleAppAction('restart'); 
                }}
              >
                <span className="context-menu-icon context-menu-icon-restart" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M21 12a9 9 0 1 1-3.3-6.9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <polyline points="21 3 21 9 15 9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>{t('icon.restart')}</span>
              </div>
              {canResetOwner && (
                <>
                  <div className="context-menu-separator" role="separator" />
                  <div
                    className="context-menu-item"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleOwnerReset();
                    }}
                  >
                    <span className="context-menu-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M21 12a9 9 0 1 1-3.3-6.9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <polyline points="21 3 21 9 15 9" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="12" cy="12" r="3.2" strokeWidth="2" />
                      </svg>
                    </span>
                    <span>{t('icon.resetAccess')}</span>
                  </div>
                </>
              )}
              {canOpenSettings && (
                <>
                  <div className="context-menu-separator" role="separator" />
                  <div
                    className="context-menu-item"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveContextMenu(null);
                      setSettingsModalOpen(true);
                    }}
                  >
                    <span className="context-menu-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <circle cx="12" cy="12" r="3" strokeWidth="2" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span>{t('icon.settings')}</span>
                  </div>
                </>
              )}
              <div className="context-menu-separator" role="separator" />
              <div
                className="context-menu-item context-menu-item-danger"
                onClick={(e) => {
                  console.log('[Icon] 🖱️ Clic sur Désinstaller');
                  e.preventDefault();
                  e.stopPropagation();
                  handleAppAction('uninstall');
                }}
              >
                <span className="context-menu-icon context-menu-icon-uninstall" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <polyline points="3 6 5 6 21 6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>{t('icon.uninstall')}</span>
              </div>
            </>
          ) : (
            <>
              <div 
                className="context-menu-item" 
                onClick={(e) => { 
                  console.log('[Icon] 🖱️ Clic sur Démarrer');
                  e.preventDefault();
                  e.stopPropagation(); 
                  handleAppAction('start'); 
                }}
              >
                <span className="context-menu-icon context-menu-icon-start" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <polygon points="9 6 19 12 9 18 9 6" />
                  </svg>
                </span>
                <span>{t('icon.start')}</span>
              </div>
              <div className="context-menu-separator" role="separator" />
              <div 
                className="context-menu-item context-menu-item-danger" 
                onClick={(e) => { 
                  console.log('[Icon] 🖱️ Clic sur Désinstaller');
                  e.preventDefault();
                  e.stopPropagation(); 
                  handleAppAction('uninstall'); 
                }}
              >
                <span className="context-menu-icon context-menu-icon-uninstall" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <polyline points="3 6 5 6 21 6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>{t('icon.uninstall')}</span>
              </div>
            </>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
}, (prevProps, nextProps) => {
  // Comparaison personnalisée pour éviter les re-renders inutiles
  // Ne re-render que si les props importantes changent
  return (
    prevProps.id === nextProps.id &&
    prevProps.src === nextProps.src &&
    prevProps.showName === nextProps.showName &&
    prevProps.isNew === nextProps.isNew &&
    prevProps.isAdmin === nextProps.isAdmin &&
    prevProps.accessMode === nextProps.accessMode &&
    JSON.stringify(prevProps.appStatusData) === JSON.stringify(nextProps.appStatusData) &&
    JSON.stringify(prevProps.installInfo) === JSON.stringify(nextProps.installInfo) &&
    prevProps.activeContextMenu === nextProps.activeContextMenu
  );
});

export default Icon;
