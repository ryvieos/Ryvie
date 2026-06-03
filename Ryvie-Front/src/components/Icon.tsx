import React from 'react';
import ReactDOM from 'react-dom';
import { useDrag } from 'react-dnd';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
import { useLanguage } from '../contexts/LanguageContext';

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
const Icon = React.memo(({ id, src, installInfo, zoneId, moveIcon, handleClick, showName, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus, accessMode, refreshDesktopIcons }) => {
  const { t } = useLanguage();
  const appConfig = appsConfig[id] || {};
  const [imgSrc, setImgSrc] = React.useState(src);
  const [imgError, setImgError] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState(null);
  const [isUninstalling, setIsUninstalling] = React.useState(false);
  const isProcessingMenuActionRef = React.useRef(false);
  const [confirmModal, setConfirmModal] = React.useState({ show: false, type: '', title: '', message: '', onConfirm: null });
  
  React.useEffect(() => {
    setImgSrc(src);
    setImgError(false);
  }, [src]);
  
  React.useEffect(() => {
    if (pendingAction === 'stopping' && appStatusData?.status === 'stopped') {
      setPendingAction(null);
    } else if (pendingAction === 'starting' && appStatusData?.status === 'running') {
      setPendingAction(null);
    }
  }, [appStatusData?.status, pendingAction]);
  
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
  const installPercent = isInstalling
    ? Math.max(0, Math.min(100, Math.round(installInfo.progress || 0)))
    : 0;

  // États transitoires (démarrage/arrêt/redémarrage) hors installation -> grise + spinner
  const isTransitioning = !isInstalling && appConfig.showStatus && (
    isUninstalling ||
    pendingAction === 'starting' || pendingAction === 'stopping' ||
    status === 'starting' || status === 'partial'
  );

  // App arrêtée -> grise fixe
  const isStopped = !isInstalling && !isTransitioning && appConfig.showStatus &&
    (!status || status !== 'running');

  // L'icône doit-elle être assombrie/grisée ?
  const isDimmed = isInstalling || isTransitioning || isStopped;

  // Vérifier si l'app est cliquable (seulement si running, et jamais pendant une installation)
  const isClickable = !isInstalling && (!appConfig.showStatus || status === 'running');
  
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
                  {t('common.uninstall')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
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

      // L'opération backend est terminée : l'app est réellement prête/arrêtée.
      // On passe immédiatement au statut final (optimiste) au lieu d'attendre le
      // prochain cycle de polling, pour ne pas laisser tourner le spinner alors
      // que l'app est déjà accessible.
      if (setAppStatus) {
        const finalStatus = action === 'stop' ? 'stopped' : 'running';
        setAppStatus(prevStatus => ({
          ...prevStatus,
          [appKey]: {
            ...(prevStatus[appKey] || {}),
            status: finalStatus,
            progress: finalStatus === 'running' ? 100 : 0
          }
        }));
      }
      setPendingAction(null);

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
    prevProps.isAdmin === nextProps.isAdmin &&
    prevProps.accessMode === nextProps.accessMode &&
    JSON.stringify(prevProps.appStatusData) === JSON.stringify(nextProps.appStatusData) &&
    JSON.stringify(prevProps.installInfo) === JSON.stringify(nextProps.installInfo) &&
    prevProps.activeContextMenu === nextProps.activeContextMenu
  );
});

export default Icon;
