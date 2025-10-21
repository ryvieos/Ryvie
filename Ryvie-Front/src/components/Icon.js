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
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
  return ReactDOM.createPortal(menu, document.body);
};

// Composant Icon
const Icon = ({ id, src, zoneId, moveIcon, handleClick, showName, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus }) => {
  const appConfig = appsConfig[id] || {};
  const [imgSrc, setImgSrc] = React.useState(src);
  const [imgError, setImgError] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState(null);
  
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
  const isClickable = !appConfig.showStatus || (appStatusData && appStatusData.status === 'running');
  
  const handleIconClick = () => {
    if (!isClickable) {
      return;
    }
    handleClick(id);
  };

  const handleContextMenu = (e) => {
    if (!appConfig.showStatus) return;
    if (!isAdmin) return;
    
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

    setActiveContextMenu({ iconId: id, x, y });
  };

  const handleAppAction = async (action) => {
    setActiveContextMenu(null);
    
    if (!appConfig.id) {
      console.error(`[Icon] Impossible d'effectuer ${action}: appConfig.id manquant pour`, id);
      alert(`Erreur: ID de l'application manquant (${id})`);
      return;
    }
    
    if (action === 'stop') {
      setPendingAction('stopping');
    } else if (action === 'start' || action === 'restart') {
      setPendingAction('starting');
    }
    
    if (setAppStatus && appConfig.id) {
      const appKey = `app-${appConfig.id}`;
      setAppStatus(prevStatus => {
        const newStatus = { ...prevStatus };
        
        if (action === 'stop') {
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'partial',
            progress: 50
          };
        } else if (action === 'start') {
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'starting',
            progress: 50
          };
        } else if (action === 'restart') {
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'starting',
            progress: 50
          };
        }
        
        return newStatus;
      });
    }
    
    try {
      const serverUrl = getServerUrl();
      const url = `${serverUrl}/api/apps/${appConfig.id}/${action}`;
      
      const response = await axios.post(url, {}, { timeout: 120000 });
      console.log(`[Icon] ✓ ${action} ${appConfig.name} terminé:`, response.data);
      
    } catch (error) {
      console.error(`[Icon] ❌ Erreur lors du ${action} de ${appConfig.name}:`, error);
      
      setPendingAction(null);
      
      if (setAppStatus && appConfig.id && appStatusData) {
        setAppStatus(prevStatus => ({
          ...prevStatus,
          [`app-${appConfig.id}`]: appStatusData
        }));
      }
      
      let errorMsg = error.response?.data?.message || error.message;
      if (error.code === 'ECONNABORTED') {
        errorMsg = 'Timeout dépassé - l\'opération prend plus de 2 minutes';
      }
      alert(`Erreur lors du ${action} de ${appConfig.name}: ${errorMsg}`);
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
              <div className="context-menu-item" onClick={() => handleAppAction('stop')}>
                ⏹️ Arrêter
              </div>
              <div className="context-menu-item" onClick={() => handleAppAction('restart')}>
                🔄 Redémarrer
              </div>
            </>
          ) : (
            <div className="context-menu-item" onClick={() => handleAppAction('start')}>
              ▶️ Démarrer
            </div>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
};

export default Icon;
