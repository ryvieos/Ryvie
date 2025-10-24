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
const Icon = ({ id, src, zoneId, moveIcon, handleClick, showName, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus, accessMode }) => {
  const appConfig = appsConfig[id] || {};
  const [imgSrc, setImgSrc] = React.useState(src);
  const [imgError, setImgError] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState(null);
  const isProcessingMenuActionRef = React.useRef(false);
  
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
    
    if (pendingAction === 'stopping') {
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
    
    e.preventDefault();
    e.stopPropagation();
    
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
    
    console.log(`[Icon] 🔄 Action "${action}" sur ${appName} (ID: ${appId})`);
    
    // Définir l'action en cours (pour l'affichage du badge)
    if (action === 'stop') {
      setPendingAction('stopping');
    } else if (action === 'start' || action === 'restart') {
      setPendingAction('starting');
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
      {!imgError && (
        <div className="icon-container">
          <div
            ref={ref}
            className="icon"
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
          {appStatusData?.status === 'running' ? (
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
                ⏹️ Arrêter
              </div>
              <div 
                className="context-menu-item" 
                onClick={(e) => { 
                  console.log('[Icon] 🖱️ Clic sur Redémarrer');
                  e.preventDefault();
                  e.stopPropagation(); 
                  handleAppAction('restart'); 
                }}
              >
                🔄 Redémarrer
              </div>
            </>
          ) : (
            <div 
              className="context-menu-item" 
              onClick={(e) => { 
                console.log('[Icon] 🖱️ Clic sur Démarrer');
                e.preventDefault();
                e.stopPropagation(); 
                handleAppAction('start'); 
              }}
            >
              ▶️ Démarrer
            </div>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
};

export default Icon;
