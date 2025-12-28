import React from 'react';
import ReactDOM from 'react-dom';
import { useDrag } from 'react-dnd';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';

const { getServerUrl } = urlsConfig;
const ItemTypes = { ICON: 'icon' };

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

// Composant Icon
const Icon = ({ id, src, zoneId, moveIcon, handleClick, showName, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus, accessMode, refreshDesktopIcons }) => {
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

  const getBadgeStyle = () => {
    if (!appConfig.showStatus) {
      return null;
    }

    let backgroundColor = '#dc3545';
    let animation = 'none';

    // Désinstallation en cours: badge rouge avec pulsation
    if (isUninstalling) {
      backgroundColor = '#dc3545';
      animation = 'pulse 1.5s ease-in-out infinite';
    } else if (pendingAction === 'stopping') {
      const currentStatus = appStatusData?.status;
      if (currentStatus === 'stopped') {
        backgroundColor = '#dc3545';
      } else {
        backgroundColor = '#fd7e14';
        animation = 'pulse 1.5s ease-in-out infinite';
      }
    } else if (pendingAction === 'starting') {
      const currentStatus = appStatusData?.status;
      if (currentStatus === 'running') {
        backgroundColor = '#28a745';
      } else {
        backgroundColor = '#ffc107';
        animation = 'pulse 1.5s ease-in-out infinite';
      }
    } else {
      if (appStatusData && appStatusData.status) {
        const { status } = appStatusData;
        
        if (status === 'running') {
          backgroundColor = '#28a745';
        } else if (status === 'starting') {
          backgroundColor = '#ffc107';
          animation = 'pulse 1.5s ease-in-out infinite';
        } else if (status === 'partial') {
          backgroundColor = '#fd7e14';
        }
      }
    }

    return {
      position: 'absolute',
      top: '-5px',
      right: '-5px',
      width: '16px',
      height: '16px',
      borderRadius: '50%',
      backgroundColor,
      border: '2px solid white',
      boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
      animation,
      zIndex: 10
    };
  };

  const badgeStyle = getBadgeStyle();
  
  // Vérifier si l'app est cliquable (seulement si running ou pas de statut à afficher)
  const isClickable = !appConfig.showStatus || (appStatusData && appStatusData.status === 'running');
  
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

  const uninstallSuccessShownRef = React.useRef(false);

  // Fonction pour exécuter la désinstallation (appelée après confirmation)
  const executeUninstall = async (appId, appName, appKey) => {
    if (uninstallSuccessShownRef.current) {
      return;
    }

    setPendingAction('stopping');
    setIsUninstalling(true);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      const uninstallUrl = `${serverUrl}/api/appstore/apps/${appId}/uninstall`;
      console.log(`[Icon] 📡 DELETE ${uninstallUrl}`);
      const response = await axios.delete(uninstallUrl, { timeout: 120000 });
      console.log(`[Icon] ✅ Désinstallation de ${appName} terminée`);

      uninstallSuccessShownRef.current = true;

      setConfirmModal({
        show: true,
        type: 'success',
        title: 'Désinstallation réussie',
        message: `${appName} a été désinstallé avec succès.`,
        onConfirm: async () => {
          setConfirmModal({ show: false, type: '', title: '', message: '', onConfirm: null });
          if (typeof refreshDesktopIcons === 'function') {
            await refreshDesktopIcons();
          }
        }
      });

      setIsUninstalling(false);
    } catch (error) {
      console.error(`[Icon] ❌ Erreur lors de la désinstallation de ${appName}:`, error);
      setIsUninstalling(false);
      setPendingAction(null);
      
      const errorMsg = error.response?.data?.message || error.message;
      setConfirmModal({
        show: true,
        type: 'error',
        title: 'Erreur',
        message: `Erreur lors de la désinstallation de ${appName}: ${errorMsg}`,
        onConfirm: () => setConfirmModal({ show: false, type: '', title: '', message: '', onConfirm: null })
      });
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
    // S'assurer que le clic est bien sur l'overlay et pas sur la modal
    if (e.target === e.currentTarget) {
      e.nativeEvent.stopImmediatePropagation();
      e.stopPropagation();
      e.preventDefault();
      closeModal();
    }
  }, [closeModal]);

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
                  Annuler
                </button>
                <button 
                  className="confirm-modal-btn confirm-modal-btn-danger" 
                  onClick={(e) => { e.stopPropagation(); confirmModal.onConfirm(); }}
                >
                  Désinstaller
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
      alert(`Erreur: ID de l'application manquant pour ${appConfig.name || id}`);
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
        title: `Désinstaller ${appName} ?`,
        message: `Toutes les données seront supprimées définitivement.`,
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
      
      alert(`Erreur ${action} de ${appName}:\n${errorMsg}`);
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
            className={`icon ${isUninstalling ? 'icon-uninstalling' : ''}`}
            style={{
              cursor: isClickable ? 'pointer' : 'not-allowed',
              position: 'relative',
            }}
            onClick={handleIconClick}
            onContextMenu={handleContextMenu}
          >
            <img
              src={imgSrc}
              alt={appConfig.name || id}
              onError={handleImageError}
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '20px' }}
            />
            {badgeStyle && <div className="status-badge" style={badgeStyle}></div>}
          </div>
          {showName && <p className="icon-name">{appConfig.name || id.replace('.jpeg', '').replace('.png', '').replace('.svg', '')}</p>}
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
                <span>Arrêter</span>
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
                <span>Redémarrer</span>
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
                <span>Désinstaller</span>
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
                <span>Démarrer</span>
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
                <span>Désinstaller</span>
              </div>
            </>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
};

export default Icon;
