import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import '../styles/Home.css';
import '../styles/Transitions.css';
import axios from '../utils/setupAxios';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useSocket } from '../contexts/SocketContext';
import { Link, useNavigate } from 'react-router-dom';
import { getCurrentAccessMode, setAccessMode as setGlobalAccessMode } from '../utils/detectAccessMode';
import { loadInstallState, saveInstallState, updateInstallation, removeInstallation } from '../utils/installStateManager';
import { isElectron, WindowManager, StorageManager, NotificationManager } from '../utils/platformUtils';
import { endSession, getCurrentUser, getCurrentUserRole, startSession, isSessionActive, getSessionInfo } from '../utils/sessionManager';
import urlsConfig from '../config/urls';
const { getServerUrl, getAppUrl, setLocalIP, registerAppPort } = urlsConfig;
import { 
  generateAppConfigFromManifests,
  generateDefaultAppsList,
  images 
} from '../config/appConfig';
import { useLanguage } from '../contexts/LanguageContext';
import GridLauncher from '../components/GridLauncher';
import InstallIndicator from '../components/InstallIndicator';
import OnboardingOverlay from '../components/OnboardingOverlay';
 

// Fonction pour importer toutes les images du dossier weather_icons
function importAll(r) {
  let images = {};
  r.keys().forEach((key) => (images[key] = r(key)));
  return images;
}
const weatherImages = importAll(require.context('../weather_icons', false, /\.(png|jpe?g|svg)$/));
const weatherIcons = importAll(require.context('../weather_icons', false, /\.(png|jpe?g|svg)$/));

// Types pour react-dnd
const ItemTypes = {
  ICON: 'icon',
};

// Composant pour chaque icône
// Menu contextuel rendu via portal pour s'afficher au-dessus de tout
const ContextMenuPortal = ({ children, x, y, onClose }) => {
  const menu = (
    <div
      className="context-menu"
      style={{ position: 'fixed', left: `${x}px`, top: `${y}px`, zIndex: 10000 }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
  return ReactDOM.createPortal(menu, document.body);
};
// Composant Icon (legacy - non utilisé, conservé pour compatibilité)
const Icon = ({ id, src, zoneId, handleClick, showName, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus }) => {
  const appConfig = appsConfig[id] || {};
  const [imgSrc, setImgSrc] = React.useState(src);
  const [imgError, setImgError] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState(null); // 'stopping', 'starting', null
  
  // Mettre à jour l'image source quand elle change
  React.useEffect(() => {
    setImgSrc(src);
    setImgError(false);
  }, [src]);
  
  // Réinitialiser pendingAction quand le statut final est atteint
  React.useEffect(() => {
    if (pendingAction === 'stopping' && appStatusData?.status === 'stopped') {
      console.log(`[Icon] ${appConfig.name} - Arrêt terminé, reset pendingAction`);
      setPendingAction(null);
    } else if (pendingAction === 'starting' && appStatusData?.status === 'running') {
      console.log(`[Icon] ${appConfig.name} - Démarrage terminé, reset pendingAction`);
      setPendingAction(null);
    }
  }, [appStatusData?.status, pendingAction, appConfig.name]);
  
  // Gérer les erreurs de chargement d'image
  const handleImageError = () => {
    if (imgError) return;
    console.log(`[Icon] Erreur de chargement pour ${id}, on masque l'image (pas de fallback local)`);
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

  // Déterminer la couleur et l'animation du badge selon le statut
  const getBadgeStyle = () => {
    // Ne pas afficher de badge pour les icônes de la taskbar
    if (!appConfig.showStatus) {
      return null;
    }

    // Toujours afficher un badge (rouge par défaut si pas de données)
    let backgroundColor = '#dc3545'; // Rouge par défaut (stopped ou pas de données)
    let animation = 'none';
    
    // Si on a une action en cours, forcer certains statuts
    if (pendingAction === 'stopping') {
      // Pendant un arrêt, ne jamais revenir au vert
      const currentStatus = appStatusData?.status;
      if (currentStatus === 'stopped') {
        backgroundColor = '#dc3545'; // Rouge (arrêté)
      } else {
        backgroundColor = '#fd7e14'; // Orange foncé (arrêt en cours)
        animation = 'pulse 1.5s ease-in-out infinite';
      }
    } else if (pendingAction === 'starting') {
      // Pendant un démarrage/restart
      const currentStatus = appStatusData?.status;
      if (currentStatus === 'running') {
        backgroundColor = '#28a745'; // Vert (démarré)
      } else {
        backgroundColor = '#ffc107'; // Orange (démarrage)
        animation = 'pulse 1.5s ease-in-out infinite';
      }
    } else {
      // Pas d'action en cours, utiliser le statut réel
      if (appStatusData && appStatusData.status) {
        const { status } = appStatusData;
        
        if (status === 'running') {
          backgroundColor = '#28a745'; // Vert (tous les containers healthy)
        } else if (status === 'starting') {
          backgroundColor = '#ffc107'; // Orange (démarrage)
          animation = 'pulse 1.5s ease-in-out infinite';
        } else if (status === 'partial') {
          backgroundColor = '#fd7e14'; // Orange foncé (partiellement running)
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
  
  // Vérifier si l'app est cliquable (seulement si running)
  const isClickable = !appConfig.showStatus || (appStatusData && appStatusData.status === 'running');
  
  const handleIconClick = () => {
    // Ne rien faire si l'app n'est pas running (rouge ou orange)
    if (!isClickable) {
      console.log('[Icon] App non disponible:', id, 'Status:', appStatusData?.status);
      return;
    }
    handleClick(id);
  };

  const handleContextMenu = (e) => {
    // IMPORTANT: Toujours empêcher le menu natif du navigateur en premier
    e.preventDefault();
    e.stopPropagation();
    
    console.log(`[Icon] Clic droit sur ${appConfig.name}`, { 
      showStatus: appConfig.showStatus, 
      isAdmin,
      appConfig 
    });
    
    // Ne montrer le menu que pour les apps avec showStatus (pas les icônes système)
    if (!appConfig.showStatus) {
      console.log(`[Icon] Menu non affiché: showStatus = false`);
      return;
    }
    
    // Ne montrer le menu que pour les admins
    if (!isAdmin) {
      console.log(`[Icon] Menu non affiché: utilisateur non admin`);
      return;
    }
    
    // Positionner le menu collé à l'icône (à droite par défaut)
    const iconRect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 110;

    // Option droite-centre
    let x = iconRect.right + 8;
    let y = iconRect.top + iconRect.height / 2 - menuHeight / 2;

    // Si dépasse à droite, basculer à gauche
    if (x + menuWidth > window.innerWidth) {
      x = iconRect.left - menuWidth - 8;
    }
    // Empêcher dépassement vertical
    if (y < 8) y = 8;
    if (y + menuHeight > window.innerHeight - 8) y = window.innerHeight - menuHeight - 8;

    setActiveContextMenu({ iconId: id, x, y });
  };

  const handleAppAction = async (action) => {
    setActiveContextMenu(null);
    
    // Vérifier que l'ID existe
    if (!appConfig.id) {
      console.error(`[Icon] Impossible d'effectuer ${action}: appConfig.id manquant pour`, id);
      console.error('[Icon] appConfig:', appConfig);
      alert(t('home.errorMissingAppId', { id }));
      return;
    }
    
    console.log(`[Icon] ${action} de ${appConfig.name} (ID: ${appConfig.id})...`);
    
    // Confirmation pour la désinstallation
    if (action === 'uninstall') {
      const confirmMsg = t('home.confirmUninstall', { appName: appConfig.name });
      if (!window.confirm(confirmMsg)) {
        console.log(`[Icon] Désinstallation de ${appConfig.name} annulée par l'utilisateur`);
        return;
      }
    }
    
    // Définir l'action en cours pour verrouiller les transitions de statut
    if (action === 'stop') {
      setPendingAction('stopping');
    } else if (action === 'start' || action === 'restart') {
      setPendingAction('starting');
    } else if (action === 'uninstall') {
      setPendingAction('stopping'); // Utiliser stopping pour la désinstallation
    }
    
    // MISE À JOUR OPTIMISTE IMMÉDIATE - AVANT l'appel API
    if (setAppStatus && appConfig.id) {
      const appKey = `app-${appConfig.id}`;
      setAppStatus(prevStatus => {
        const newStatus = { ...prevStatus };
        
        if (action === 'stop') {
          console.log(`[Icon] ⏹️  ${appConfig.name} - Changement IMMÉDIAT du statut vers "partial" (arrêt en cours)`);
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'partial', // Orange (arrêt en cours)
            progress: 50
          };
        } else if (action === 'start') {
          console.log(`[Icon] ▶️  ${appConfig.name} - Changement IMMÉDIAT du statut vers "starting"`);
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'starting', // Orange (en cours de démarrage)
            progress: 50
          };
        } else if (action === 'restart') {
          console.log(`[Icon] 🔄 ${appConfig.name} - Changement IMMÉDIAT du statut vers "starting"`);
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'starting', // Orange (en cours de redémarrage)
            progress: 50
          };
        } else if (action === 'uninstall') {
          console.log(`[Icon] 🗑️  ${appConfig.name} - Changement IMMÉDIAT du statut vers "stopped" (désinstallation en cours)`);
          newStatus[appKey] = {
            ...newStatus[appKey],
            status: 'stopped', // Rouge (désinstallation en cours)
            progress: 0
          };
        }
        
        return newStatus;
      });
    }
    
    // Puis faire l'appel API en arrière-plan
    try {
      const serverUrl = getServerUrl();
      let url, method;
      
      if (action === 'uninstall') {
        url = `${serverUrl}/api/appstore/apps/${appConfig.id}/uninstall`;
        method = 'delete';
      } else {
        url = `${serverUrl}/api/apps/${appConfig.id}/${action}`;
        method = 'post';
      }
      
      console.log(`[Icon] Appel API: ${method.toUpperCase()} ${url}`);
      
      // Timeout de 120 secondes pour les opérations start/stop/restart/uninstall
      const response = await axios[method](url, {}, { timeout: 120000 });
      console.log(`[Icon] ✓ ${action} ${appConfig.name} terminé:`, response.data);
      
      // Si désinstallation, recharger la page
      if (action === 'uninstall') {
        alert(t('home.uninstallSuccess', { appName: appConfig.name }));
        console.log('[Icon] 🔄 Rechargement de la page (F5)...');
        window.location.reload();
      }
      
    } catch (error) {
      console.error(`[Icon] ❌ Erreur lors du ${action} de ${appConfig.name}:`, error);
      console.error(`[Icon] Détails:`, error.response?.data || error.message);
      
      // Réinitialiser l'action en cours
      setPendingAction(null);
      
      // En cas d'erreur, remettre le statut précédent
      if (setAppStatus && appConfig.id && appStatusData) {
        console.log(`[Icon] Restauration du statut précédent suite à l'erreur`);
        setAppStatus(prevStatus => ({
          ...prevStatus,
          [`app-${appConfig.id}`]: appStatusData
        }));
      }
      
      // Message d'erreur plus détaillé
      let errorMsg = error.response?.data?.message || error.message;
      if (error.code === 'ECONNABORTED') {
        errorMsg = t('home.timeoutError');
      }
      alert(t('home.actionError', { action, appName: appConfig.name, error: errorMsg }));
    }
  };

  return (
    <>
      {/* Ne pas afficher l'icône si le chargement a échoué */}
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
            {/* Afficher uniquement l'image backend */}
            <img
              src={imgSrc}
              alt={appConfig.name || id}
              onError={handleImageError}
              style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '20px' }}
            />
            {badgeStyle && <div className="status-badge" style={badgeStyle}></div>}
          </div>
          {showName && (
            <p
              className="icon-name"
              title={appConfig.name || id.replace('.jpeg', '').replace('.png', '').replace('.svg', '')}
            >
              {appConfig.name || id.replace('.jpeg', '').replace('.png', '').replace('.svg', '')}
            </p>
          )}
        </div>
      )}
      
      {/* Menu contextuel - affiché uniquement pour cette icône via portal */}
      {!imgError && activeContextMenu && activeContextMenu.iconId === id && (
        <ContextMenuPortal x={activeContextMenu.x} y={activeContextMenu.y}>
          {appStatusData?.status === 'running' ? (
            <>
              <div className="context-menu-item" onClick={() => handleAppAction('stop')}>
                ⏹️ {t('home.stop')}
              </div>
              <div className="context-menu-item" onClick={() => handleAppAction('restart')}>
                🔄 {t('home.restart')}
              </div>
              <div className="context-menu-separator"></div>
              <div className="context-menu-item context-menu-item-danger" onClick={() => handleAppAction('uninstall')}>
                🗑️ {t('home.uninstall')}
              </div>
            </>
          ) : (
            <>
              <div className="context-menu-item" onClick={() => handleAppAction('start')}>
                ▶️ {t('home.start')}
              </div>
              <div className="context-menu-separator"></div>
              <div className="context-menu-item context-menu-item-danger" onClick={() => handleAppAction('uninstall')}>
                🗑️ {t('home.uninstall')}
              </div>
            </>
          )}
        </ContextMenuPortal>
      )}
    </>
  );
};

// Composant Zone (legacy - non utilisé, conservé pour compatibilité)
const Zone = ({ zoneId, iconId, handleClick, showName, appStatus, appsConfig, iconImages, activeContextMenu, setActiveContextMenu, isAdmin, setAppStatus }) => {
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.ICON,
    canDrop: () => true,
    drop: (item) => {
      // Legacy - ne fait plus rien
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  const isActive = canDrop && isOver;
  
  // Utiliser l'icône depuis la config (URL backend) ou fallback sur images locales
  const getIconSrc = (id) => {
    const config = appsConfig[id];
    if (config && config.icon) {
      return config.icon; // URL du backend
    }
    return iconImages[id] || images[id]; // Fallback sur icônes locales
  };

  return (
    <div ref={drop} className={`zone ${isActive ? 'zone-active' : ''}`}>
      <div className="icon-container">
        {iconId && iconId.length > 0 && (
          <Icon
            id={iconId[0]}
            src={getIconSrc(iconId[0])}
            zoneId={zoneId}
            handleClick={handleClick}
            showName={showName}
            appStatusData={appStatus[iconId[0]]}
            appsConfig={appsConfig}
            activeContextMenu={activeContextMenu}
            setActiveContextMenu={setActiveContextMenu}
            isAdmin={isAdmin}
            setAppStatus={setAppStatus}
          />
        )}
      </div>
    </div>
  );
};

// Composant Taskbar - Mémorisé pour éviter les re-renders inutiles
const Taskbar = React.memo(({ handleClick, appsConfig, onLoaded }) => {
  // Filtrer les icônes de la barre des tâches à partir de la configuration
  const taskbarApps = React.useMemo(() => {
    return Object.entries(appsConfig)
      .filter(([_, config]) => config.isTaskbarApp)
      .map(([iconId, config]) => ({ iconId, config }));
  }, [appsConfig]);

  const loadedRef = React.useRef(false);
  const totalRef = React.useRef(0);
  const loadedCountRef = React.useRef(0);

  React.useEffect(() => {
    // Compter le nombre total d'images à charger
    totalRef.current = taskbarApps.filter(({ iconId }) => images[iconId]).length;
    loadedCountRef.current = 0;
    loadedRef.current = false;
  }, [taskbarApps]);

  const handleImgLoad = React.useCallback(() => {
    if (loadedRef.current) return;
    loadedCountRef.current += 1;
    if (loadedCountRef.current === totalRef.current) {
      loadedRef.current = true;
      try { onLoaded && onLoaded(); } catch {}
    }
  }, [onLoaded]);

  return (
    <div className="taskbar">
      {taskbarApps.map(({ iconId, config }, index) => {
        const imgSrc = images[iconId];
        const label = config?.name || iconId;

        // Ajouter un fond blanc uniquement pour les icônes User et Transfer
        const isUserOrTransfer =
          iconId === 'task-user.svg' ||
          iconId === 'task-user.png' ||
          iconId === 'task-transfer.svg' ||
          iconId === 'task-transfer.png';
        const circleClassName = `taskbar-circle${isUserOrTransfer ? ' taskbar-circle--white' : ''}`;

        return (
          <div key={iconId} className={circleClassName} aria-label={label} title={label}>
            {config.route && config.route !== '/userlogin' ? (
              <Link to={config.route} aria-label={label} title={label} style={{ width: '100%', height: '100%' }}>
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={label}
                    title={label}
                    onLoad={handleImgLoad}
                    onError={(e) => {
                      try { console.warn('[Taskbar] Image failed to load', { iconId, src: imgSrc }); } catch (_) {}
                      e.currentTarget.style.display = 'none';
                    }}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : null}
              </Link>
            ) : (
              <div
                onClick={() => handleClick(iconId)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handleClick(iconId)}
                role="button"
                tabIndex={0}
                aria-label={label}
                title={label}
                style={{ width: '100%', height: '100%' }}
              >
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={label}
                    title={label}
                    onLoad={handleImgLoad}
                    onError={(e) => {
                      try { console.warn('[Taskbar] Image failed to load', { iconId, src: imgSrc }); } catch (_) {}
                      e.currentTarget.style.display = 'none';
                    }}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}, (prevProps, nextProps) => {
  // Comparaison personnalisée: ne re-render que si les apps de la taskbar changent
  const prevTaskbarApps = Object.entries(prevProps.appsConfig)
    .filter(([_, config]) => config.isTaskbarApp)
    .map(([iconId]) => iconId)
    .sort()
    .join(',');
  const nextTaskbarApps = Object.entries(nextProps.appsConfig)
    .filter(([_, config]) => config.isTaskbarApp)
    .map(([iconId]) => iconId)
    .sort()
    .join(',');
  
  return prevTaskbarApps === nextTaskbarApps;
});

// Composant principal
const Home = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [accessMode, setAccessMode] = useState(null); 
  const [currentUserName, setCurrentUserName] = useState('');
  const [userRole, setUserRole] = useState('User');
  const isAdmin = String(userRole || '').toLowerCase() === 'admin';
  const [appsConfig, setAppsConfig] = useState(() => {
    // Charger depuis le cache au démarrage
    const cached = StorageManager.getItem('appsConfig_cache');
    return cached || {}; // Sera chargé depuis les manifests
  });
  const [iconImages, setIconImages] = useState(() => {
    // Charger depuis le cache au démarrage
    const cached = StorageManager.getItem('iconImages_cache');
    return cached || images;
  }); // Images locales
  const [backgroundImage, setBackgroundImage] = useState(() => {
    // Charger le fond depuis le cache localStorage par utilisateur
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`ryvie_bg_${currentUser}`);
        if (cached && typeof cached === 'string') return cached;
      }
    } catch {}
    return 'default';
  }); // Fond d'écran utilisateur
  const [weatherCity, setWeatherCity] = useState(null); // Ville configurée par l'utilisateur
  const [weatherCityLoaded, setWeatherCityLoaded] = useState(false); // Indique si les préférences sont chargées
  const [showWeatherModal, setShowWeatherModal] = useState(false);
  const [closingWeatherModal, setClosingWeatherModal] = useState(false);
  const [tempCity, setTempCity] = useState('');
  const [savingWeatherCity, setSavingWeatherCity] = useState(false);

  const [weather, setWeather] = useState(() => {
    // Charger depuis le cache au démarrage
    const cached = StorageManager.getItem('weather_cache');
    return cached || {
      location: t('home.loading'),
      temperature: null,
      description: '',
      icon: 'sunny.png',
    };
  });

  // serverStatus vient maintenant du contexte socket
  const [appStatus, setAppStatus] = useState(() => {
    // Charger depuis le cache au démarrage
    const cached = StorageManager.getItem('appStatus_cache');
    return cached || {};
  });
  const [applications, setApplications] = useState(() => {
    // Charger depuis le cache au démarrage
    const cached = StorageManager.getItem('applications_cache');
    return cached || [];
  });
  const [isLoading, setIsLoading] = useState(false);
  // Overlay AppStore et Userlogin
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayUrl, setOverlayUrl] = useState('');
  const [closingOverlay, setClosingOverlay] = useState(false);
  const [overlayTitle, setOverlayTitle] = useState(t('home.appStore'));
  const [appStoreMounted, setAppStoreMounted] = useState(false);
  const [appStoreInstalling, setAppStoreInstalling] = useState(false);
  // Map des installations en cours: { appId: { appName, progress } }
  // Charger l'état depuis localStorage au montage
  const [installingApps, setInstallingApps] = useState(() => loadInstallState());
  const [pendingUnmount, setPendingUnmount] = useState(false);

  const [mounted, setMounted] = useState(false);
  const { socket, isConnected: socketConnected, serverStatus, setServerStatus } = useSocket();
  const [displayServerStatus, setDisplayServerStatus] = useState(true); // État d'affichage avec délai
  const disconnectionTimeoutRef = useRef(null); // Ref pour le timeout de déconnexion
  const [updateNotificationShown, setUpdateNotificationShown] = useState(false);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState(null);
  const [updateBannerClosing, setUpdateBannerClosing] = useState(false);
  const [notification, setNotification] = useState({ show: false, message: '', type: 'info' });
  
  // Appliquer le darkMode depuis localStorage au montage (avant le chargement backend)
  React.useLayoutEffect(() => {
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`ryvie_dark_mode_${currentUser}`);
        if (cached === 'true') {
          document.body.classList.add('dark-mode');
        } else if (cached === 'false') {
          document.body.classList.remove('dark-mode');
        }
      }
    } catch {}
  }, []);
  const [activeContextMenu, setActiveContextMenu] = useState(null); // Menu contextuel global
  const [taskbarReady, setTaskbarReady] = useState(false); // Animations taskbar quand les icônes de la barre sont chargées
  const taskbarLoadedOnceRef = React.useRef(false); // Assure que l'animation ne se joue qu'une seule fois
  const taskbarTimeoutRef = React.useRef(null); // Timeout de secours pour forcer l'affichage
  const [bgDataUrl, setBgDataUrl] = useState(null); // DataURL du fond d'écran mis en cache
  const [bgUrl, setBgUrl] = useState(null);         // URL calculée courante
  const [showOnboarding, setShowOnboarding] = useState(false); // Afficher l'overlay d'onboarding
  const [prevBgUrl, setPrevBgUrl] = useState(null); // URL précédente pour crossfade
  const [bgFadeKey, setBgFadeKey] = useState(0);    // clé pour relancer l'animation
  const [disconnectedSince, setDisconnectedSince] = useState(null); // Timestamp de début de déconnexion
  const launcherSaveRef = React.useRef(null); // debounce save
  // NE PAS charger depuis localStorage au montage - attendre le backend (source de vérité)
  // Le localStorage sera mis à jour après le chargement du backend
  const [launcherLayout, setLauncherLayout] = useState(null); // Layout chargé depuis le backend
  const [launcherAnchors, setLauncherAnchors] = useState(null); // Ancres chargées depuis le backend
  const [launcherLoadedFromBackend, setLauncherLoadedFromBackend] = useState(false); // Indique si les données ont été chargées
  const launcherInitialLoadDone = React.useRef(false); // Flag pour savoir si le chargement initial est terminé
  const [widgets, setWidgets] = useState(() => {
    // Charger depuis le cache localStorage au montage
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`launcher_${currentUser}`);
        if (cached) {
          const launcher = JSON.parse(cached);
          return launcher.widgets || [];
        }
      }
    } catch {}
    return [];
  }); // Liste des widgets ajoutés par l'utilisateur
  const widgetIdCounter = React.useRef(0); // Compteur pour générer des IDs uniques
  // Ancres par défaut si l'utilisateur n'a rien en backend (alignées avec le backend)
  const DEFAULT_ANCHORS = React.useMemo(() => ({
    weather: 3, // row 0 * 12 + col 3
    'widget-cpu-ram-0': 6, // row 0 * 12 + col 6
    'widget-storage-1': 30 // row 2 * 12 + col 6
  }), []);
  // Générer dynamiquement un layout/apps/ancres par défaut à partir des apps disponibles
  const computeDefaults = React.useCallback((appIds = []) => {
    // Layout par défaut avec widgets weather, cpu-ram et storage
    const layout = {
      weather: { col: 3, row: 0, w: 3, h: 2 },
      'widget-cpu-ram-0': { col: 6, row: 0, w: 2, h: 2 },
      'widget-storage-1': { col: 6, row: 2, w: 2, h: 2 }
    };
    const anchors = { ...DEFAULT_ANCHORS };
    // Placer les apps dans la zone à gauche du widget Storage (évite les collisions)
    // Zone apps: cols 0..5 (6 colonnes), à partir de row=2, avec wrap sur les lignes suivantes
    const APP_COL_START = 0;
    const APP_COL_END = 5;
    const APP_COLS = APP_COL_END - APP_COL_START + 1;
    let i = 0;
    const rowStart = 2;
    const ordered = [];
    // Utiliser toutes les apps connues (triées par id)
    const sourceIds = Object.keys(appsConfig || {}).filter(id => id && id.startsWith('app-')).sort();
    sourceIds.forEach((id) => {
      // Si appsConfig n'est pas encore chargé, ne pas filtrer; sinon ignorer les ids inconnus
      if (appsConfig && Object.keys(appsConfig).length > 0 && !appsConfig[id]) return;
      // Ne pas ajouter météo ni widgets
      if (id === 'weather' || String(id).startsWith('widget-')) return;
      const col = APP_COL_START + (i % APP_COLS);
      const row = rowStart + Math.floor(i / APP_COLS);
      layout[id] = { col, row, w: 1, h: 1 };
      anchors[id] = row * 12 + col;
      ordered.push(id);
      i += 1;
    });
    return { layout, anchors, apps: ordered };
  }, [appsConfig, DEFAULT_ANCHORS]);
  const savedDefaultOnceRef = React.useRef(false);
  const refreshTimeoutRef = React.useRef(null);
  
  // Fonction pour rafraîchir les icônes du bureau après installation/désinstallation
  const refreshDesktopIcons = React.useCallback(async () => {
    // Debounce: annuler le refresh précédent s'il est en attente
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
    
    // Attendre 300ms avant de rafraîchir pour grouper les appels multiples
    return new Promise((resolve) => {
      refreshTimeoutRef.current = setTimeout(async () => {
        await performRefresh();
        resolve();
      }, 300);
    });
  }, [accessMode, launcherLayout, launcherAnchors, widgets]);
  
  // Fonction interne qui fait le vrai rafraîchissement
  const performRefresh = React.useCallback(async () => {
    // Être plus robuste: si accessMode n'est pas encore initialisé,
    // retomber sur la détection actuelle.
    const mode = accessMode || getCurrentAccessMode() || 'private';
    
    try {
      console.log('[Home] 🔄 Rafraîchissement des icônes du bureau...', { mode });
      const config = await generateAppConfigFromManifests(mode);
      
      // Vérifier que la config contient au moins une app (hors taskbar)
      const appKeys = Object.keys(config).filter(k => k.startsWith('app-'));
      if (appKeys.length > 0) {
        console.log('[Home] ✅ Config rechargée:', Object.keys(config).length, 'apps');
        setAppsConfig(config);
        StorageManager.setItem('appsConfig_cache', config);
        
        // Mettre à jour les icônes
        const newIconImages = { ...images };
        Object.keys(config).forEach(iconId => {
          if (config[iconId].icon) {
            newIconImages[iconId] = config[iconId].icon;
          }
        });
        setIconImages(newIconImages);
        StorageManager.setItem('iconImages_cache', newIconImages);
        
        // Nettoyer le layout et les anchors pour supprimer les apps désinstallées
        // ET détecter les nouvelles apps à ajouter
        if (launcherLayout && Object.keys(launcherLayout).length > 0) {
          const cleanedLayout = {};
          Object.keys(launcherLayout).forEach(id => {
            // Garder la météo et les widgets, et les apps qui existent encore
            if (id === 'weather' || id.startsWith('widget-') || config[id]) {
              cleanedLayout[id] = launcherLayout[id];
            } else {
              console.log(`[Home] 🧹 Suppression de ${id} du layout (app désinstallée)`);
            }
          });
          
          // Nettoyer aussi les anchors
          const cleanedAnchors = {};
          if (launcherAnchors && Object.keys(launcherAnchors).length > 0) {
            Object.keys(launcherAnchors).forEach(id => {
              if (id === 'weather' || id.startsWith('widget-') || config[id]) {
                cleanedAnchors[id] = launcherAnchors[id];
              } else {
                console.log(`[Home] 🧹 Suppression de ${id} des anchors (app désinstallée)`);
              }
            });
          }
          
          // Détecter les nouvelles apps (présentes dans config mais pas dans le layout)
          const newApps = Object.keys(config).filter(id => 
            id.startsWith('app-') && !cleanedLayout[id]
          );
          
          if (newApps.length > 0) {
            console.log(`[Home] 🆕 Nouvelles apps détectées (seront placées par le backend):`, newApps);
            // Le backend s'occupe de placer les nouvelles apps via la réconciliation
            // On recharge les préférences pour récupérer les positions calculées par le backend
            // Le délai permet au backend de terminer la réconciliation
            const reloadPreferences = () => {
              console.log('[Home] 🔄 Rechargement des préférences pour récupérer les positions du backend...');
              const serverUrl = getServerUrl(mode);
              axios.get(`${serverUrl}/api/user/preferences`, {
                headers: { Authorization: `Bearer ${sessionStorage.getItem('token')}` }
              }).then(res => {
                if (res.data?.launcher) {
                  const backendLayout = res.data.launcher.layout || {};
                  const backendAnchors = res.data.launcher.anchors || {};
                  
                  // Vérifier que toutes les nouvelles apps ont une position
                  const missingPositions = newApps.filter(appId => !backendLayout[appId]);
                  if (missingPositions.length > 0) {
                    console.log('[Home] ⏳ Certaines apps n\'ont pas encore de position, nouvelle tentative dans 1s:', missingPositions);
                    setTimeout(reloadPreferences, 1000);
                    return;
                  }
                  
                  setLauncherLayout(backendLayout);
                  setLauncherAnchors(backendAnchors);
                  console.log('[Home] ✅ Layout mis à jour depuis le backend:', Object.keys(backendLayout).length, 'items');
                  
                  // Mettre à jour le localStorage
                  try {
                    const currentUser = getCurrentUser();
                    if (currentUser) {
                      const cached = localStorage.getItem(`launcher_${currentUser}`);
                      const launcher = cached ? JSON.parse(cached) : {};
                      launcher.layout = backendLayout;
                      launcher.anchors = backendAnchors;
                      localStorage.setItem(`launcher_${currentUser}`, JSON.stringify(launcher));
                    }
                  } catch (e) {}
                }
              }).catch(err => {
                console.error('[Home] ❌ Erreur rechargement préférences:', err);
              });
            };
            
            // Premier appel après un court délai
            setTimeout(reloadPreferences, 500);
          }
          
          const layoutChanged = Object.keys(cleanedLayout).length !== Object.keys(launcherLayout).length;
          const anchorsChanged = launcherAnchors && Object.keys(cleanedAnchors).length !== Object.keys(launcherAnchors).length;
          
          if (layoutChanged || anchorsChanged) {
            console.log('[Home] 📝 Mise à jour du layout/anchors après rafraîchissement');
            console.log('[Home] Layout avant:', Object.keys(launcherLayout || {}));
            console.log('[Home] Layout après:', Object.keys(cleanedLayout));
            
            setLauncherLayout(cleanedLayout);
            if (anchorsChanged) {
              setLauncherAnchors(cleanedAnchors);
            }
            
            // Sauvegarder le layout et anchors nettoyés dans localStorage
            try {
              const currentUser = getCurrentUser();
              if (currentUser) {
                const cached = localStorage.getItem(`launcher_${currentUser}`);
                if (cached) {
                  const launcher = JSON.parse(cached);
                  launcher.layout = cleanedLayout;
                  if (anchorsChanged) {
                    launcher.anchors = cleanedAnchors;
                  }
                  localStorage.setItem(`launcher_${currentUser}`, JSON.stringify(launcher));
                  console.log('[Home] 💾 Layout sauvegardé dans localStorage');
                }
              }
            } catch (e) {
              console.warn('[Home] ⚠️ Erreur lors de la sauvegarde du layout nettoyé:', e);
            }
            
            // Sauvegarder aussi dans le backend
            try {
              const serverUrl = getServerUrl(mode);
              const appsList = Object.entries(cleanedLayout)
                .filter(([id, pos]) => id && config[id] && id !== 'weather' && !String(id).startsWith('widget-') && pos)
                .sort((a, b) => (a[1].row - b[1].row) || (a[1].col - b[1].col))
                .map(([id]) => id);
              
              const payload = {
                launcher: {
                  anchors: anchorsChanged ? cleanedAnchors : (launcherAnchors || {}),
                  layout: cleanedLayout,
                  widgets: widgets || [],
                  apps: appsList
                }
              };
              
              axios.patch(`${serverUrl}/api/user/preferences/launcher`, payload)
                .then(() => console.log('[Home] 💾 Layout nettoyé sauvegardé dans le backend'))
                .catch(async (e) => {
                  console.warn('[Home] ⚠️ Fallback save launcher après nettoyage:', e?.message);
                  try {
                    await axios.patch(`${serverUrl}/api/user/preferences`, payload);
                  } catch (e2) {
                    console.error('[Home] ❌ Échec de sauvegarde du layout nettoyé:', e2?.message);
                  }
                });
            } catch (e) {
              console.warn('[Home] ⚠️ Erreur lors de la sauvegarde backend du layout nettoyé:', e);
            }
          }
        }
        
        console.log('[Home] ✅ Icônes du bureau rafraîchies');
        
        // Récupérer les statuts des apps depuis l'API pour mettre à jour les badges
        try {
          const serverUrl = getServerUrl(mode);
          const response = await axios.get(`${serverUrl}/api/apps`, { timeout: 30000 });
          const apps = response.data.map(app => ({
            ...app,
            // Utiliser mainPort (port du proxy) au lieu de ports[0] (port interne du container)
            port: app.mainPort || (app.ports && app.ports.length > 0 ? app.ports[0] : null),
            autostart: false
          }));
          setApplications(apps);
          console.log('[Home] ✅ Statuts des apps actualisés:', apps.length, 'apps');
        } catch (appsError) {
          console.warn('[Home] ⚠️ Impossible de récupérer les statuts des apps:', appsError.message);
        }
      } else {
        console.warn('[Home] ⚠️ Config vide reçue, conservation de la config actuelle');
      }
    } catch (error) {
      console.error('[Home] ❌ Erreur lors du rafraîchissement des icônes:', error);
      console.warn('[Home] ⚠️ Conservation de la config actuelle en raison de l\'erreur');
      // Ne rien faire - conserver la config actuelle au lieu de la vider
    }
  }, [accessMode, launcherLayout, launcherAnchors, widgets]);
  
  // Cleanup du timeout au démontage
  React.useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) {
        clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  // Écouteur de messages pour fermer l'overlay depuis l'iframe
  useEffect(() => {
    // Si les données sont chargées et que les ancres utilisées sont les défauts (backend vide),
    // persister une fois ces valeurs dans le backend pour créer le bloc launcher
    if (!launcherLoadedFromBackend) return;
    // Attendre que la config des apps soit chargée
    if (!appsConfig || Object.keys(appsConfig).length === 0) return;
    if (savedDefaultOnceRef.current) return;
    if (!accessMode || !currentUserName) return;
    const anchorsAreDefaults = launcherAnchors && Object.keys(launcherAnchors).length > 0 &&
      Object.keys(DEFAULT_ANCHORS).every(k => launcherAnchors[k] === DEFAULT_ANCHORS[k]);
    const layoutIsEmpty = !launcherLayout || Object.keys(launcherLayout).length === 0;
    if (anchorsAreDefaults || layoutIsEmpty) {
      savedDefaultOnceRef.current = true;
      const serverUrl = getServerUrl(accessMode);
      // Construire les defaults dynamiques si layout vide
      const defaults = { layout: launcherLayout || {}, anchors: launcherAnchors || {}, apps: [] };
      const baseLayout = defaults.layout || launcherLayout || {};
      const appsList = defaults.apps.length > 0
        ? defaults.apps
        : Object.entries(baseLayout)
            .filter(([id, pos]) => id && appsConfig[id] && id !== 'weather' && !String(id).startsWith('widget-') && pos)
            .sort((a, b) => (a[1].row - b[1].row) || (a[1].col - b[1].col))
            .map(([id]) => id);
      const payload = {
        launcher: {
          anchors: defaults.anchors || launcherAnchors || DEFAULT_ANCHORS,
          layout: baseLayout || {},
          widgets: widgets || [],
          apps: appsList
        }
      };
      axios.patch(`${serverUrl}/api/user/preferences/launcher`, payload)
        .then(() => console.log('[Home] 💾 Defaults launcher persistés (ancres par défaut)'))
        .catch(async (e) => {
          console.warn('[Home] ⚠️ Fallback save launcher après defaults:', e?.message);
          try {
            await axios.patch(`${serverUrl}/api/user/preferences`, payload);
          } catch (e2) {
            console.error('[Home] ❌ Échec de persistance des defaults launcher:', e2?.message);
          }
        });
    }
  }, [launcherLoadedFromBackend, accessMode, currentUserName, launcherAnchors, launcherLayout, widgets, appsConfig]);

  useEffect(() => {
    const handleMessage = (event) => {
      // Vérifier l'origine du message pour la sécurité (optionnel mais recommandé)
      // if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === 'CLOSE_OVERLAY') {
        console.log('[Home] Réception du message CLOSE_OVERLAY');
        setClosingOverlay(true);
        setTimeout(() => {
          setOverlayVisible(false);
          setClosingOverlay(false);
        }, 250);
      } else if (event.data && event.data.type === 'CLOSE_OVERLAY_AND_NAVIGATE') {
        console.log('[Home] Réception du message CLOSE_OVERLAY_AND_NAVIGATE', event.data.path);
        setClosingOverlay(true);
        setTimeout(() => {
          setOverlayVisible(false);
          setClosingOverlay(false);
          if (event.data.path) {
            navigate(event.data.path);
          }
        }, 250);
      } else if (event.data && event.data.type === 'REFRESH_DESKTOP_ICONS') {
        console.log('[Home] Réception du message REFRESH_DESKTOP_ICONS');
        refreshDesktopIcons();
      } else if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        // Afficher une notification toast
        const { notification } = event.data;
        if (notification) {
          setNotification({
            show: true,
            message: notification.message,
            type: notification.type || 'info'
          });
          // Masquer après 4 secondes
          setTimeout(() => {
            setNotification({ show: false, message: '', type: 'info' });
          }, 4000);
        }
      } else if (event.data && event.data.type === 'APPSTORE_INSTALL_STATUS') {
        const { installing, appName, appId, progress, error, cancelled } = event.data;
        console.log('[Home] Réception du statut d\'installation:', installing, appName, appId, { progress, error, cancelled });
        setAppStoreInstalling(installing);
        
        if (installing && appId && appName) {
          // Ajouter ou mettre à jour l'installation - TOUJOURS maintenir l'état
          setInstallingApps(prev => {
            const updated = {
              ...prev,
              [appId]: { 
                appName, 
                progress: progress || prev[appId]?.progress || 0 // Conserver la progression existante si pas de nouvelle valeur
              }
            };
            saveInstallState(updated);
            return updated;
          });
        } else if (!installing && appId) {
          // Installation terminée, annulée ou échouée
          // Attendre un peu avant de supprimer pour que l'utilisateur voie la notification finale
          const delay = error || cancelled ? 3000 : 2000;
          setTimeout(() => {
            setInstallingApps(prev => {
              const newApps = { ...prev };
              delete newApps[appId];
              saveInstallState(newApps);
              removeInstallation(appId);
              return newApps;
            });
          }, delay);
          
          // Rafraîchir immédiatement les icônes - le manifest est généré AVANT 100%
          console.log('[Home] Installation terminée, rafraîchissement immédiat des icônes');
          refreshDesktopIcons();
        }
        
        // Si on attendait la fin d'une installation pour démonter
        if (pendingUnmount && !installing) {
          // Vérifier s'il reste des installations en cours
          setInstallingApps(prev => {
            const remaining = Object.keys(prev).filter(id => id !== appId);
            if (remaining.length === 0) {
              console.log('[Home] Toutes les installations terminées, démontage de l\'AppStore');
              setTimeout(() => {
                setAppStoreMounted(false);
                setOverlayUrl('');
                setPendingUnmount(false);
              }, 1000);
            }
            return prev;
          });
        }
      } else if (event.data && event.data.type === 'APPSTORE_INSTALL_PROGRESS') {
        // Mise à jour de la progression uniquement
        const { appId, appName, progress } = event.data;
        if (appId) {
          setInstallingApps(prev => {
            // TOUJOURS maintenir l'entrée, même si la progression ne change pas
            let updated = prev;
            if (prev[appId]) {
              // Mettre à jour la progression existante
              updated = {
                ...prev,
                [appId]: { 
                  ...prev[appId], 
                  progress: typeof progress === 'number' ? progress : (prev[appId].progress || 0)
                }
              };
            } else if (appName) {
              // Nouvelle app pas encore enregistrée - l'ajouter immédiatement
              updated = {
                ...prev,
                [appId]: { appName, progress: progress || 0 }
              };
            }
            // Toujours sauvegarder pour maintenir la persistance
            saveInstallState(updated);
            return updated;
          });
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate, refreshDesktopIcons, pendingUnmount]);
  
  // Vérifier et restaurer les installations en cours au montage
  useEffect(() => {
    const activeEventSources = [];
    
    const checkOngoingInstallations = async () => {
      const savedInstalls = loadInstallState();
      const installIds = Object.keys(savedInstalls);
      
      if (installIds.length === 0) return;
      
      console.log('[Home] Vérification des installations en cours:', installIds);
      
      try {
        const mode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(mode);
        
        // Vérifier les installations actives côté backend
        const activeResponse = await axios.get(`${serverUrl}/api/appstore/active-installations`, { timeout: 20000 });
        const activeInstalls = activeResponse.data?.installations || [];
        
        console.log('[Home] Installations actives côté backend:', activeInstalls);
        
        // Vérifier les apps installées
        const appsResponse = await axios.get(`${serverUrl}/api/apps`, { timeout: 30000 });
        const installedApps = appsResponse.data || [];
        
        // Synchroniser l'état
        for (const appId of installIds) {
          const isActive = activeInstalls.includes(appId);
          const isInstalled = installedApps.some(app => app.id === appId);
          
          if (isInstalled) {
            // L'installation est terminée, nettoyer
            console.log(`[Home] Installation de ${appId} terminée, nettoyage`);
            removeInstallation(appId);
            setInstallingApps(prev => {
              const updated = { ...prev };
              delete updated[appId];
              return updated;
            });
          } else if (!isActive) {
            // L'installation n'est plus active et l'app n'est pas installée
            // Probablement échouée ou annulée
            console.log(`[Home] Installation de ${appId} n'est plus active, nettoyage`);
            removeInstallation(appId);
            setInstallingApps(prev => {
              const updated = { ...prev };
              delete updated[appId];
              return updated;
            });
          } else {
            // L'installation est toujours en cours, reconnecter au SSE
            console.log(`[Home] Installation de ${appId} toujours en cours, reconnexion SSE`);
            
            // Restaurer l'état de l'installation dans le state pour afficher la notification
            setInstallingApps(prev => ({
              ...prev,
              [appId]: savedInstalls[appId]
            }));
            
            const progressUrl = `${serverUrl}/api/appstore/progress/${appId}`;
            const eventSource = new EventSource(progressUrl);
            activeEventSources.push(eventSource);
            
            eventSource.onmessage = (event) => {
              try {
                const data = JSON.parse(event.data);
                console.log(`[Home] SSE Progress pour ${appId}:`, data.progress, data.message);
                
                // Mettre à jour la progression
                setInstallingApps(prev => {
                  const appData = savedInstalls[appId];
                  if (!appData) {
                    console.warn(`[Home] Pas de données pour ${appId} dans savedInstalls`);
                    return prev;
                  }
                  
                  const updated = {
                    ...prev,
                    [appId]: { 
                      appName: appData.appName,
                      progress: data.progress || 0 
                    }
                  };
                  saveInstallState(updated);
                  return updated;
                });
                
                // Si terminé avec succès
                if (data.progress >= 100 || data.stage === 'complete') {
                  console.log(`[Home] Installation de ${appId} terminée via SSE`);
                  eventSource.close();
                  // Rafraîchir immédiatement car le manifest est généré AVANT 100%
                  removeInstallation(appId);
                  setInstallingApps(prev => {
                    const updated = { ...prev };
                    delete updated[appId];
                    return updated;
                  });
                  refreshDesktopIcons();
                }
                
                // Si erreur
                if (data.stage === 'error') {
                  console.error(`[Home] Erreur installation ${appId}:`, data.message);
                  eventSource.close();
                  
                  // Récupérer le nom de l'app depuis le state
                  const appName = savedInstalls[appId]?.appName || appId;
                  
                  removeInstallation(appId);
                  setInstallingApps(prev => {
                    const updated = { ...prev };
                    delete updated[appId];
                    return updated;
                  });
                  
                  // Afficher une notification d'erreur
                  setNotification({
                    show: true,
                    message: t('appStore.notifications.uninstall.error').replace('{appName}', appName).replace('{error}', data.message || t('common.errorUnknown')),
                    type: 'error'
                  });
                  setTimeout(() => {
                    setNotification({ show: false, message: '', type: 'info' });
                  }, 6000);
                }
              } catch (error) {
                console.warn(`[Home] Erreur parsing SSE pour ${appId}:`, error);
              }
            };
            
            eventSource.onerror = (error) => {
              console.warn(`[Home] Erreur SSE pour ${appId}:`, error);
              eventSource.close();
            };
          }
        }
        
        // Rafraîchir les icônes pour afficher les apps installées
        refreshDesktopIcons();
      } catch (error) {
        console.warn('[Home] Erreur vérification installations:', error);
        // En cas d'erreur, garder l'état local
      }
    };
    
    checkOngoingInstallations();
    
    // Cleanup: fermer les EventSources au démontage
    return () => {
      activeEventSources.forEach(es => es.close());
    };
  }, []);
  
  // Polling séparé pour vérifier les installations terminées
  useEffect(() => {
    // Polling périodique toutes les 10 secondes pour vérifier les installations
    const pollInterval = setInterval(async () => {
      const savedInstalls = loadInstallState();
      const installIds = Object.keys(savedInstalls);
      
      if (installIds.length === 0) return;
      
      try {
        const mode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(mode);
        
        const [activeResponse, appsResponse] = await Promise.all([
          axios.get(`${serverUrl}/api/appstore/active-installations`, { timeout: 20000 }),
          axios.get(`${serverUrl}/api/apps`, { timeout: 30000 })
        ]);
        
        const activeInstalls = activeResponse.data?.installations || [];
        const installedApps = appsResponse.data || [];
        
        let hasChanges = false;
        
        for (const appId of installIds) {
          const isActive = activeInstalls.includes(appId);
          const isInstalled = installedApps.some(app => app.id === appId);
          const installData = savedInstalls[appId];
          const progress = installData?.progress || 0;
          
          // Ne nettoyer que si:
          // 1. L'app est installée ET la progression est à 100%
          // 2. OU l'installation n'est plus active ET la dernière mise à jour date de plus de 30 secondes
          const lastUpdate = installData?.lastUpdate || Date.now();
          const timeSinceUpdate = Date.now() - lastUpdate;
          const isStale = timeSinceUpdate > 30000; // 30 secondes
          
          if ((isInstalled && progress >= 100) || (!isActive && isStale)) {
            console.log(`[Home] Polling: Installation de ${appId} terminée (progress: ${progress}%, active: ${isActive}, stale: ${isStale}), nettoyage`);
            removeInstallation(appId);
            setInstallingApps(prev => {
              const updated = { ...prev };
              delete updated[appId];
              return updated;
            });
            hasChanges = true;
          } else if (!isActive) {
            console.log(`[Home] Polling: Installation de ${appId} inactive mais récente (progress: ${progress}%, age: ${Math.round(timeSinceUpdate/1000)}s), maintien`);
          }
        }
        
        if (hasChanges) {
          refreshDesktopIcons();
        }
      } catch (error) {
        console.warn('[Home] Erreur polling installations:', error);
      }
    }, 15000);
    
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, []);

  // Vérifier si l'utilisateur doit voir l'onboarding
  useEffect(() => {
    const checkOnboarding = async () => {
      try {
        const accessMode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/user/onboarding-status`);
        
        if (response.data && response.data.isFirstLogin) {
          console.log('[Home] Premier login détecté - affichage de l\'onboarding');
          setShowOnboarding(true);
        }
      } catch (error) {
        console.error('[Home] Erreur vérification onboarding:', error);
      }
    };
    
    checkOnboarding();
  }, []);

  useEffect(() => {
    const initializeAccessMode = () => {
      // TOUJOURS utiliser le mode stocké - ne jamais faire de détection automatique
      const mode = getCurrentAccessMode(); // peut être null
      setAccessMode(mode);
      console.log(`[Home] Mode d'accès récupéré depuis le stockage: ${mode}`);
    };

    // Restaurer la session depuis les paramètres URL si preserve_session=true
    const urlParams = new URLSearchParams(window.location.search);
    const preserveSession = urlParams.get('preserve_session');
    const user = urlParams.get('user');
    const role = urlParams.get('role');
    const token = urlParams.get('token');
    const targetMode = urlParams.get('mode');
    
    // Forcer le mode d'accès si spécifié (avant initializeAccessMode)
    if (targetMode) {
      console.log(`[Home] Application du mode forcé: ${targetMode}`);
      setGlobalAccessMode(targetMode);
      setAccessMode(targetMode);
    } else {
      initializeAccessMode();
    }
    
    if (preserveSession === 'true' && user && token) {
      console.log(`[Home] Restauration de la session pour: ${user}`);
      
      // Restaurer la session
      startSession({
        token: token,
        userId: user,
        userName: user,
        userRole: role || 'User',
        userEmail: ''
      });
      
      // Nettoyer les paramètres URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Récupérer l'utilisateur connecté
    try {
      setCurrentUserName(getCurrentUser() || '');
      setUserRole(getCurrentUserRole() || 'User');
    } catch (_) {}
  }, []);
  
  // Charger l'IP locale ET la config depuis les manifests en parallèle (optimisation)
  useEffect(() => {
    if (!accessMode) return;
    
    const loadInitialData = async () => {
      const serverUrl = getServerUrl(accessMode);
      
      // Lancer les deux requêtes en parallèle pour réduire le temps de chargement
      const promises = [];
      
      // 1. Récupérer l'IP locale (mode privé uniquement)
      if (accessMode === 'private') {
        promises.push(
          axios.get(`${serverUrl}/status`)
            .then(response => {
              if (response.data?.ip) {
                setLocalIP(response.data.ip);
                console.log('[Home] IP locale récupérée:', response.data.ip);
              }
            })
            .catch(err => console.warn('[Home] IP locale non disponible:', err.message))
        );
      }
      
      // 2. Charger la config depuis les manifests
      promises.push(
        generateAppConfigFromManifests(accessMode)
          .then(config => {
            // Vérifier que la config contient au moins une app (hors taskbar)
            const appKeys = Object.keys(config).filter(k => k.startsWith('app-'));
            if (appKeys.length > 0) {
              console.log('[Home] Config chargée:', Object.keys(config).length, 'apps');
              setAppsConfig(config);
              StorageManager.setItem('appsConfig_cache', config);
              
              // Mettre à jour les icônes
              const newIconImages = { ...images };
              Object.keys(config).forEach(iconId => {
                if (config[iconId].icon) {
                  newIconImages[iconId] = config[iconId].icon;
                }
              });
              setIconImages(newIconImages);
              StorageManager.setItem('iconImages_cache', newIconImages);
            } else {
              console.warn('[Home] Config vide reçue lors du chargement initial, utilisation du cache');
              // Essayer de charger depuis le cache
              const cachedConfig = StorageManager.getItem('appsConfig_cache');
              const cachedImages = StorageManager.getItem('iconImages_cache');
              if (cachedConfig) {
                setAppsConfig(cachedConfig);
                console.log('[Home] Config restaurée depuis le cache:', Object.keys(cachedConfig).length, 'apps');
              }
              if (cachedImages) {
                setIconImages(cachedImages);
              }
            }
          })
          .catch(err => {
            console.error('[Home] Erreur config manifests:', err);
            // En cas d'erreur, essayer de charger depuis le cache
            const cachedConfig = StorageManager.getItem('appsConfig_cache');
            const cachedImages = StorageManager.getItem('iconImages_cache');
            if (cachedConfig) {
              setAppsConfig(cachedConfig);
              console.log('[Home] Config restaurée depuis le cache après erreur:', Object.keys(cachedConfig).length, 'apps');
            }
            if (cachedImages) {
              setIconImages(cachedImages);
            }
          })
      );
      
      // Attendre toutes les requêtes en parallèle
      await Promise.allSettled(promises);
    };
    
    loadInitialData();
  }, [accessMode]);

  // Handler: sauvegarder layout/anchors du launcher pour l'utilisateur
  const handleLauncherLayoutChange = React.useCallback((snapshot, isManualChange = false) => {
    try {
      // Ne sauvegarder que si:
      // 1. Les données ont déjà été chargées depuis le backend
      // 2. C'est un changement MANUEL (drag utilisateur) OU le chargement initial est terminé
      if (!launcherLoadedFromBackend) {
        console.log('[Home] ⏸️  Sauvegarde launcher ignorée: données pas encore chargées depuis le backend');
        return;
      }
      
      // Si ce n'est pas un changement manuel et que le chargement initial n'est pas terminé, ignorer
      if (!isManualChange && !launcherInitialLoadDone.current) {
        console.log('[Home] ⏸️  Sauvegarde launcher ignorée: chargement initial en cours');
        return;
      }
      if (!accessMode || !currentUserName) return;
      const serverUrl = getServerUrl(accessMode);
      if (launcherSaveRef.current) clearTimeout(launcherSaveRef.current);
      // Construire la liste des apps selon l'ordre actuel de la grille (snapshot.layout)
      // Tri par row puis col, en gardant uniquement les apps présentes dans appsConfig
      const appsList = snapshot && snapshot.layout
        ? Object.entries(snapshot.layout)
            .filter(([id, pos]) => id && appsConfig[id] && id !== 'weather' && !String(id).startsWith('widget-') && pos)
            .sort((a, b) => (a[1].row - b[1].row) || (a[1].col - b[1].col))
            .map(([id]) => id)
        : Object.keys(appsConfig || {}).filter(id => id && id.startsWith('app-'));
      const payload = {
        launcher: {
          anchors: snapshot?.anchors || {},
          layout: snapshot?.layout || {},
          widgets: widgets, // Sauvegarder la liste des widgets
          apps: appsList
        }
      };
      launcherSaveRef.current = setTimeout(async () => {
        try {
          // Tentative endpoint dédié
          await axios.patch(`${serverUrl}/api/user/preferences/launcher`, payload);
          console.log('[Home] ✅ Launcher sauvegardé sur le backend');
        } catch (e) {
          // Fallback: endpoint générique si /launcher n'existe pas
          try {
            await axios.patch(`${serverUrl}/api/user/preferences`, payload);
            console.log('[Home] ✅ Launcher sauvegardé sur le backend (fallback)');
          } catch (e2) {
            console.error('[Home] ❌ Sauvegarde launcher échouée:', e2?.message || e?.message);
          }
        }
      }, 300);
    } catch (_) {}
  }, [accessMode, currentUserName, appsConfig, launcherLoadedFromBackend, widgets]);
  
  // Handler: ajouter un widget (empêcher les doublons)
  const handleAddWidget = React.useCallback((widgetType) => {
    console.log('[Home] Tentative d\'ajout d\'un widget:', widgetType);
    
    // Vérifier si un widget de ce type existe déjà
    setWidgets(prev => {
      const alreadyExists = prev.some(w => w.type === widgetType);
      
      if (alreadyExists) {
        console.log('[Home] ⚠️ Un widget de type', widgetType, 'existe déjà');
        return prev; // Ne rien faire
      }
      
      console.log('[Home] ✅ Ajout du widget:', widgetType);
      const newWidget = {
        id: `widget-${widgetType}-${widgetIdCounter.current++}`,
        type: widgetType
      };
      
      return [...prev, newWidget];
    });
  }, []);
  
  // Handler: supprimer un widget
  const handleRemoveWidget = React.useCallback((widgetId) => {
    console.log('[Home] Suppression du widget:', widgetId);
    setWidgets(prev => prev.filter(w => w.id !== widgetId));
  }, []);
  
  // Référence pour appsConfig (évite les re-renders en cascade)
  const appsConfigRef = React.useRef(appsConfig);
  React.useEffect(() => { appsConfigRef.current = appsConfig; }, [appsConfig]);
  
  // Mettre à jour les statuts quand applications change (optimisé)
  useEffect(() => {
    if (!applications || applications.length === 0) return;
    
    const currentConfig = appsConfigRef.current;
    if (Object.keys(currentConfig).length === 0) return;
    
    // Utiliser requestIdleCallback pour ne pas bloquer le rendu
    const updateStatus = () => {
      const newAppStatus = {};
      
      applications.forEach(app => {
        const configEntry = Object.entries(currentConfig).find(([iconId, config]) => {
          return config.name?.toLowerCase() === app.name?.toLowerCase() || 
                 iconId.includes(app.name?.toLowerCase()) ||
                 (config.id && config.id === app.id);
        });
        
        if (configEntry) {
          const [iconId] = configEntry;
          newAppStatus[iconId] = {
            status: app.status,
            progress: app.progress,
            containersTotal: app.containersTotal,
            containersRunning: app.containersRunning,
            containersHealthy: app.containersHealthy,
            containersStarting: app.containersStarting,
            containersUnhealthy: app.containersUnhealthy,
            containersStopped: app.containersStopped
          };
        }
      });
      
      setAppStatus(newAppStatus);
      StorageManager.setItem('appStatus_cache', newAppStatus);
    };
    
    // Utiliser requestIdleCallback si disponible, sinon setTimeout
    if ('requestIdleCallback' in window) {
      requestIdleCallback(updateStatus, { timeout: 100 });
    } else {
      setTimeout(updateStatus, 0);
    }
  }, [applications]);
  
  useEffect(() => {
    if (!accessMode) {
      console.log('[Home] Aucun mode défini - aucune tentative de connexion Socket.io');
      return; // Attendre que le mode d'accès soit initialisé
    }

    // En mode web sous HTTPS, ne pas tenter de connexion en mode private (Mixed Content / réseau local)
    if (!isElectron() && typeof window !== 'undefined' && window.location?.protocol === 'https:' && accessMode === 'private') {
      console.log('[Home] Contexte HTTPS Web + mode private -> on évite les tentatives Socket.io pour prévenir les timeouts');
      setSocketConnected(false);
      setServerStatus(false);
      return;
    }
    
    const serverUrl = getServerUrl(accessMode);
    
    const fetchApplications = async () => {
      try {
        const appsBase = getServerUrl(accessMode);
        console.log('[Home] Récupération des apps depuis:', appsBase, 'mode =', accessMode);
        const response = await axios.get(`${appsBase}/api/apps`, { timeout: 30000 });
        const apps = response.data.map(app => ({
          ...app,
          // Utiliser mainPort (port du proxy) au lieu de ports[0] (port interne du container)
          port: app.mainPort || (app.ports && app.ports.length > 0 ? app.ports[0] : null),
          autostart: false
        }));
        
        // Enregistrer les ports et infos HTTPS des applications
        apps.forEach(app => {
          if (app.id && app.port) {
            const requiresHttps = app.requiresHttps || false;
            try {
              registerAppPort(app.id, app.port, requiresHttps);
              if (requiresHttps) {
                console.log(`[Home] ${app.id} nécessite HTTPS sur le port ${app.port}`);
              }
            } catch (e) {
              console.warn(`[Home] Impossible d'enregistrer le port pour ${app.id}:`, e);
            }
          }
        });
        
        setApplications(apps);
        
        // Mettre à jour le statut des applications pour Home.js
        const newAppStatus = {};
        console.log('[Home] Apps reçues de l\'API:', apps.map(a => ({ id: a.id, name: a.name, status: a.status })));
        console.log('[Home] appsConfig disponible:', Object.keys(appsConfig));
        
        apps.forEach(app => {
          // Trouver la configuration correspondante dans appsConfig
          const configEntry = Object.entries(appsConfig).find(([iconId, config]) => {
            const match = config.name.toLowerCase() === app.name.toLowerCase() || 
                         iconId.includes(app.name.toLowerCase()) ||
                         (config.id && config.id === app.id);
            return match;
          });
          
          if (configEntry) {
            const [iconId] = configEntry;
            // Stocker l'objet complet avec status, progress, etc.
            newAppStatus[iconId] = {
              status: app.status,
              progress: app.progress,
              containersTotal: app.containersTotal,
              containersRunning: app.containersRunning,
              containersHealthy: app.containersHealthy,
              containersStarting: app.containersStarting,
              containersUnhealthy: app.containersUnhealthy,
              containersStopped: app.containersStopped
            };
          }
        });
        
        console.log('[Home] Nouveau statut calculé:', newAppStatus);
        setAppStatus(newAppStatus);
        // Sauvegarder dans le cache
        StorageManager.setItem('appStatus_cache', newAppStatus);
        StorageManager.setItem('applications_cache', apps);
        
      } catch (error) {
        console.error('[Home] Erreur lors de la récupération des applications:', error);
      }
    };

    // Récupérer les applications au chargement
    fetchApplications();
    
    // Écouter les événements du socket partagé
    if (socket) {
      const handleAppsStatusUpdate = (updatedApps) => {
        console.log('[Home] Mise à jour des applications reçue:', updatedApps);
        
        // Comparer avec l'état actuel pour éviter les re-renders inutiles
        setApplications(prevApps => {
          const newApps = updatedApps.map(updatedApp => {
            const existingApp = prevApps.find(app => app.id === updatedApp.id);
            return {
              ...updatedApp,
              // Utiliser mainPort (port du proxy) au lieu de ports[0] (port interne du container)
              port: updatedApp.mainPort || (updatedApp.ports && updatedApp.ports.length > 0 ? updatedApp.ports[0] : null),
              autostart: existingApp ? existingApp.autostart : false
            };
          });
          
          // Vérifier si les données ont vraiment changé
          if (JSON.stringify(prevApps) === JSON.stringify(newApps)) {
            console.log('[Home] Aucun changement détecté dans applications, skip update');
            return prevApps; // Retourner l'ancien état pour éviter le re-render
          }
          
          return newApps;
        });

        setAppStatus(prevStatus => {
          const newAppStatus = {};
          updatedApps.forEach(app => {
            const configEntry = Object.entries(appsConfig).find(([iconId, config]) => {
              const match = config.name.toLowerCase() === app.name.toLowerCase() || 
                           iconId.includes(app.name.toLowerCase()) ||
                           (config.id && config.id === app.id);
              return match;
            });
            if (configEntry) {
              const [iconId] = configEntry;
              newAppStatus[iconId] = {
                status: app.status,
                progress: app.progress,
                containersTotal: app.containersTotal,
                containersRunning: app.containersRunning,
                containersHealthy: app.containersHealthy,
                containersStarting: app.containersStarting,
                containersUnhealthy: app.containersUnhealthy,
                containersStopped: app.containersStopped
              };
            }
          });
          
          // Vérifier si le statut a vraiment changé
          if (JSON.stringify(prevStatus) === JSON.stringify(newAppStatus)) {
            console.log('[Home] Aucun changement détecté dans appStatus, skip update');
            return prevStatus; // Retourner l'ancien état pour éviter le re-render
          }
          
          // Sauvegarder dans le cache seulement si changement
          StorageManager.setItem('appStatus_cache', newAppStatus);
          return newAppStatus;
        });
      };
      
      // Écouter les deux noms d'événement pour compatibilité
      socket.on('appsStatusUpdate', handleAppsStatusUpdate);
      socket.on('apps-status-update', handleAppsStatusUpdate);
      
      // Écouter l'événement de désinstallation terminée
      const handleAppUninstalled = (data: any) => {
        console.log('[Home] 📡 Événement app-uninstalled reçu:', data);
        if (data.success && data.appId) {
          console.log('[Home] ✅ Traitement de la désinstallation de', data.appId);
          
          // Afficher la notification toast
          setNotification({
            show: true,
            message: t('appStore.notifications.uninstall.success').replace('{appId}', data.appId),
            type: 'success'
          });
          setTimeout(() => {
            setNotification({ show: false, message: '', type: 'info' });
          }, 4000);
          
          // Attendre un peu que le backend termine toutes les opérations (manifest, etc.)
          // puis rafraîchir le bureau pour supprimer l'icône
          setTimeout(() => {
            console.log('[Home] 🔄 Rafraîchissement du bureau après désinstallation de', data.appId);
            refreshDesktopIcons();
          }, 500);
        } else {
          console.warn('[Home] ⚠️ Événement app-uninstalled reçu mais données invalides:', data);
        }
      };
      
      console.log('[Home] 🎧 Enregistrement du listener Socket.IO pour app-uninstalled');
      socket.on('app-uninstalled', handleAppUninstalled);
      
      return () => {
        socket.off('appsStatusUpdate', handleAppsStatusUpdate);
        socket.off('apps-status-update', handleAppsStatusUpdate);
        socket.off('app-uninstalled', handleAppUninstalled);
      };
    }
  }, [accessMode, socket, appsConfig, refreshDesktopIcons]);
  
  useEffect(() => {
    // Attendre que les préférences soient chargées avant de récupérer la météo
    if (!weatherCityLoaded) {
      console.log('[Home] ⏳ En attente du chargement des préférences météo...');
      return;
    }
    
    const fetchWeatherData = async () => {
      try {
        let latitude = null;
        let longitude = null;
        let cityName = null;

        // Si l'utilisateur a configuré une ville, l'utiliser en priorité
        if (weatherCity && accessMode) {
          console.log('[Home] 🌍 Utilisation de la ville configurée:', weatherCity);
          try {
            // Géocoder la ville via le backend pour éviter CORS
            const serverUrl = getServerUrl(accessMode);
            const geocodeResp = await axios.get(`${serverUrl}/api/geocode/${encodeURIComponent(weatherCity)}`);
            if (geocodeResp.data) {
              latitude = geocodeResp.data.latitude;
              longitude = geocodeResp.data.longitude;
              cityName = geocodeResp.data.name;
              console.log('[Home] 📍 Ville géocodée:', cityName, latitude, longitude);
            } else {
              console.warn('[Home] ⚠️  Ville non trouvée, fallback sur géolocalisation');
              throw new Error('Ville non trouvée');
            }
          } catch (geocodeErr) {
            console.error('[Home] ❌ Erreur géocodage:', geocodeErr.message);
            // Continuer avec la géolocalisation automatique
          }
        }

        // Si pas de ville configurée ou géocodage échoué, utiliser la géolocalisation
        if (!latitude || !longitude) {
          const getPosition = () =>
            new Promise((resolve, reject) => {
              if (!navigator.geolocation) return reject(new Error(t('home.geolocationUnavailable')));
              navigator.geolocation.getCurrentPosition(
                (pos) => resolve(pos),
                (err) => reject(err),
                { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 }
              );
            });

          try {
            const pos = await getPosition();
            latitude = pos.coords.latitude;
            longitude = pos.coords.longitude;
            console.log('[Home] 📍 Géolocalisation navigateur réussie:', latitude, longitude);

            // Reverse geocoding pour obtenir le nom de la ville depuis les coordonnées
            try {
              const reverseUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=fr`;
              const rev = await axios.get(reverseUrl);
              cityName = rev?.data?.city || rev?.data?.locality || rev?.data?.principalSubdivision || 'Votre position';
              console.log('[Home] 🏙️  Ville détectée:', cityName);
            } catch (e) {
              console.warn('[Home] ⚠️  Reverse geocoding échoué:', e.message);
              cityName = 'Votre position';
            }
          } catch (geoErr) {
            console.warn('[Home] ⚠️  Géolocalisation navigateur échouée:', geoErr.message);
            // Fallback: géolocalisation par IP via le backend
            if (!latitude || !longitude && accessMode) {
              try {
                console.log('[Home] 🔄 Tentative géolocalisation par IP via backend...');
                const serverUrl = getServerUrl(accessMode);
                const geoResp = await axios.get(`${serverUrl}/api/geolocate`);
                if (geoResp.data) {
                  latitude = geoResp.data.latitude;
                  longitude = geoResp.data.longitude;
                  cityName = geoResp.data.city;
                  console.log('[Home] 📍 Géolocalisation IP réussie:', cityName, latitude, longitude);
                }
              } catch (ipErr) {
                console.error('[Home] ❌ Géolocalisation IP échouée:', ipErr.message);
                // Dernier fallback: Paris
                latitude = 48.8566;
                longitude = 2.3522;
                cityName = 'Paris';
              }
            }
          }
        }

        // 3) Appel météo Open-Meteo avec les coordonnées trouvées
        const weatherApiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&hourly=temperature_2m,weathercode,relative_humidity_2m,windspeed_10m&timezone=auto`;
        const weatherResponse = await axios.get(weatherApiUrl);
        const data = weatherResponse.data;
        const weatherCode = data.current_weather.weathercode;

        let icon = 'cloudy.png';
        if (weatherCode === 0) {
          icon = 'sunny.png';
        } else if (
          (weatherCode >= 1 && weatherCode <= 3) ||
          [45, 48, 71, 73, 75, 85, 86].includes(weatherCode)
        ) {
          icon = 'cloudy.png';
        } else if (
          [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(weatherCode)
        ) {
          icon = 'rainy.png';
        }

        const newWeather = {
          location: cityName,
          temperature: data.current_weather.temperature,
          humidity: data.hourly.relative_humidity_2m[0],
          wind: data.current_weather.windspeed,
          description: weatherCode,
          icon: icon,
        };
        setWeather(newWeather);
        StorageManager.setItem('weather_cache', newWeather);
      } catch (error) {
        console.error('Erreur lors de la récupération météo, fallback sur Paris', error);
        // Fallback: tenter de charger Paris pour avoir de vraies données
        try {
          const parisLat = 48.8566;
          const parisLon = 2.3522;
          const parisApiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${parisLat}&longitude=${parisLon}&current_weather=true&hourly=temperature_2m,weathercode,relative_humidity_2m,windspeed_10m&timezone=auto`;
          const parisResp = await axios.get(parisApiUrl);
          const pdata = parisResp.data;
          const pcode = pdata.current_weather.weathercode;
          let picon = 'cloudy.png';
          if (pcode === 0) picon = 'sunny.png';
          else if ([61, 63, 65].includes(pcode)) picon = 'rainy.png';

          const parisWeather = {
            location: 'Paris',
            temperature: pdata.current_weather.temperature,
            humidity: pdata.hourly.relative_humidity_2m?.[0] ?? null,
            wind: pdata.current_weather.windspeed,
            description: pcode,
            icon: picon,
          };
          setWeather(parisWeather);
          StorageManager.setItem('weather_cache', parisWeather);
        } catch (e) {
          // Si vraiment tout échoue: fallback statique Paris nuageux
          setWeather({
            location: 'Paris',
            temperature: null,
            humidity: null,
            wind: null,
            description: 'cloudy',
            icon: 'cloudy.png',
          });
        }
      }
    };

    fetchWeatherData();
    const intervalId = setInterval(fetchWeatherData, 300000);
    return () => clearInterval(intervalId);
  }, [weatherCity, weatherCityLoaded, weatherRefreshTick]);

  const [weatherRefreshTick, setWeatherRefreshTick] = useState(0);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        // Rafraîchir météo
        setWeatherRefreshTick(t => t + 1);
        // Synchroniser le fond depuis le cache per-user
        try {
          const currentUser = getCurrentUser();
          if (currentUser) {
            const cachedBg = localStorage.getItem(`ryvie_bg_${currentUser}`);
            if (cachedBg && cachedBg !== backgroundImage) {
              setBackgroundImage(cachedBg);
            }
          }
        } catch {}
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Écouter les changements de cache (autre onglet/page) et appliquer instantanément
  useEffect(() => {
    const handler = (e) => {
      try {
        const currentUser = getCurrentUser();
        if (!currentUser) return;
        if (e.key === `ryvie_bg_${currentUser}` && e.newValue && e.newValue !== backgroundImage) {
          setBackgroundImage(e.newValue);
        }
      } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [backgroundImage]);

  // Écouter l'évènement custom intra-onglet pour mise à jour immédiate (Settings -> Home)
  useEffect(() => {
    const onBgChanged = (e) => {
      try {
        const next = e && e.detail;
        if (typeof next === 'string' && next && next !== backgroundImage) {
          setBackgroundImage(next);
        }
      } catch {}
    };
    window.addEventListener('ryvie:background-changed', onBgChanged);
    return () => window.removeEventListener('ryvie:background-changed', onBgChanged);
  }, [backgroundImage]);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Gérer l'affichage du statut de connexion avec délai de 3s avant d'afficher "Déconnecté"
  useEffect(() => {
    if (!serverStatus) {
      // Serveur déconnecté: attendre 3s avant d'afficher "Déconnecté"
      if (!disconnectionTimeoutRef.current) {
        console.log('[Home] Serveur déconnecté, attente de 3s avant affichage...');
        disconnectionTimeoutRef.current = setTimeout(() => {
          console.log('[Home] 3s écoulées, affichage "Déconnecté"');
          setDisplayServerStatus(false);
          disconnectionTimeoutRef.current = null;
        }, 3000);
      }
      
      // Enregistrer le timestamp si pas déjà fait
      if (!disconnectedSince) {
        setDisconnectedSince(Date.now());
        // Réinitialiser le flag de chargement pour éviter de sauvegarder des données obsolètes
        setLauncherLoadedFromBackend(false);
      }
    } else {
      // Serveur connecté: annuler le timeout et afficher "Connecté" immédiatement
      if (disconnectionTimeoutRef.current) {
        console.log('[Home] Reconnexion avant 3s, annulation du timeout');
        clearTimeout(disconnectionTimeoutRef.current);
        disconnectionTimeoutRef.current = null;
      }
      setDisplayServerStatus(true);
      
      if (disconnectedSince) {
        const disconnectedDuration = Date.now() - disconnectedSince;
        console.log(`[Home] Serveur reconnecté après ${disconnectedDuration}ms de déconnexion`);
        
        if (disconnectedDuration > 2000) {
          console.log('[Home] Déconnexion > 2s détectée, rechargement de la page...');
          window.location.reload();
        } else {
          // Réinitialiser le compteur si reconnexion rapide
          setDisconnectedSince(null);
        }
      }
    }
    
    // Cleanup au démontage
    return () => {
      if (disconnectionTimeoutRef.current) {
        clearTimeout(disconnectionTimeoutRef.current);
        disconnectionTimeoutRef.current = null;
      }
    };
  }, [serverStatus, disconnectedSince]);

  // Charger et mettre en cache le fond d'écran sélectionné comme dataURL pour un affichage hors-ligne
  useEffect(() => {
    const loadAndCacheBackground = async () => {
      try {
        if (!accessMode || !backgroundImage) return;
        const cacheKey = `bgCache_${backgroundImage}`;

        // Construire l'URL source comme dans getBackgroundStyle
        let srcUrl = null;
        const serverUrl = getServerUrl(accessMode);

        if (backgroundImage.startsWith('custom-')) {
          const filename = backgroundImage.replace('custom-', '');
          srcUrl = `${serverUrl}/api/backgrounds/${filename}`;
        } else if (backgroundImage.startsWith('preset-')) {
          const filename = backgroundImage.replace('preset-', '');
          srcUrl = `${serverUrl}/api/backgrounds/presets/${filename}`;
        } else {
          // défaut
          srcUrl = `${serverUrl}/api/backgrounds/presets/default.webp`;
        }

        // Tenter de télécharger et de convertir en dataURL
        const resp = await axios.get(srcUrl, { responseType: 'blob', timeout: 8000 });
        const blob = resp.data;
        const reader = new FileReader();
        reader.onloadend = () => {
          try {
            const dataUrl = reader.result;
            setBgDataUrl(dataUrl);
            StorageManager.setItem(cacheKey, dataUrl);
          } catch (_) {}
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        // Si le backend est down, tenter d'utiliser le cache existant
        try {
          const cacheKey = `bgCache_${backgroundImage}`;
          const cached = StorageManager.getItem(cacheKey);
          if (cached) setBgDataUrl(cached);
        } catch (_) {}
      }
    };

    loadAndCacheBackground();
  }, [backgroundImage, accessMode]);

  // Taskbar prête quand toutes les images locales sont chargées (une seule fois)
  // Timeout de secours pour forcer l'affichage si les images ne se chargent pas
  useEffect(() => {
    // Forcer l'affichage de la taskbar après 500ms maximum
    taskbarTimeoutRef.current = setTimeout(() => {
      if (!taskbarLoadedOnceRef.current) {
        console.log('[Home] ⏰ Timeout taskbar - forçage de l\'affichage');
        taskbarLoadedOnceRef.current = true;
        setTaskbarReady(true);
      }
    }, 500);

    return () => {
      if (taskbarTimeoutRef.current) {
        clearTimeout(taskbarTimeoutRef.current);
      }
    };
  }, []);

  // Fermer le menu contextuel si on clique ailleurs
  useEffect(() => {
    const handleClickOutside = (e) => {
      // Ne pas fermer si on clique sur le menu contextuel lui-même
      if (e.target.closest('.context-menu')) {
        console.log('[Home] 🖱️ Clic dans le menu contextuel, ne pas fermer');
        return;
      }
      console.log('[Home] 🖱️ Clic en dehors du menu, fermeture');
      setActiveContextMenu(null);
    };
    if (activeContextMenu) {
      // Utiliser mousedown au lieu de click pour capturer l'événement avant le onClick du bouton
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [activeContextMenu]);


  // Charger les préférences utilisateur depuis le serveur
  useEffect(() => {
    console.log('[Home] useEffect chargement préférences - accessMode:', accessMode, 'currentUserName:', currentUserName);
    
    const loadPreferences = async () => {
      if (!accessMode || !currentUserName) {
        console.log('[Home] ⏳ En attente de accessMode et currentUserName...');
        return;
      }
      
      try {
        const serverUrl = getServerUrl(accessMode);
        console.log('[Home] 🔄 Chargement préférences depuis le serveur pour', currentUserName);
        const res = await axios.get(`${serverUrl}/api/user/preferences`);
        
        // Charger la ville météo configurée
        if (res.data?.weatherCity) {
          console.log('[Home] 🌍 Ville météo chargée:', res.data.weatherCity);
          setWeatherCity(res.data.weatherCity);
        } else {
          console.log('[Home] 🌍 Pas de ville configurée, mode auto');
        }
        setWeatherCityLoaded(true); // Marquer les préférences comme chargées
        
        // Charger le fond d'écran
        if (res.data?.backgroundImage) {
          console.log('[Home] 🎨 Fond d\'écran chargé:', res.data.backgroundImage);
          setBackgroundImage(res.data.backgroundImage);
          // Mettre à jour le cache localStorage pour synchroniser avec Settings
          try {
            const currentUser = getCurrentUser();
            if (currentUser) {
              localStorage.setItem(`ryvie_bg_${currentUser}`, res.data.backgroundImage);
            }
          } catch {}
        }
        
        // Charger layout/anchors de la grille depuis le backend (source de vérité)
        if (res.data?.launcher) {
          try {
            const { layout, anchors, widgets: savedWidgets } = res.data.launcher || {};
            console.log('[Home] 🎮 Launcher chargé depuis le backend:', { layout, anchors, widgets: savedWidgets });
            
            setLauncherLayout(layout || {});
            setLauncherAnchors(anchors || {});
            
            // Charger les widgets sauvegardés
            if (savedWidgets && Array.isArray(savedWidgets)) {
              console.log('[Home] 📊 Widgets chargés:', savedWidgets);
              setWidgets(savedWidgets);
              widgetIdCounter.current = savedWidgets.length; // Initialiser le compteur
            }
            
            // Mettre à jour le localStorage avec les données du backend (source de vérité)
            try {
              const currentUser = getCurrentUser();
              if (currentUser) {
                localStorage.setItem(`launcher_${currentUser}`, JSON.stringify({
                  layout: layout || {},
                  anchors: anchors || {},
                  widgets: savedWidgets || []
                }));
                console.log('[Home] 💾 Layout du backend sauvegardé dans localStorage');
              }
            } catch (e) {
              console.warn('[Home] ⚠️ Erreur sauvegarde localStorage:', e);
            }
            
            setLauncherLoadedFromBackend(true); // Marquer comme chargé
            // Marquer le chargement initial comme terminé après un délai pour laisser la grille se positionner
            setTimeout(() => {
              launcherInitialLoadDone.current = true;
              console.log('[Home] ✅ Chargement initial launcher terminé, sauvegarde auto activée');
            }, 1000);
          } catch (e) {
            console.error('[Home] Erreur chargement launcher:', e);
            setLauncherLayout({});
            setLauncherAnchors({});
            setWidgets([]);
            setLauncherLoadedFromBackend(true); // Marquer comme chargé même si vide
            setTimeout(() => {
              launcherInitialLoadDone.current = true;
            }, 1000);
          }
        } else {
          // Pas de launcher sauvegardé, initialiser vide
          console.log('[Home] 🎮 Pas de launcher sauvegardé, initialisation vide');
          setLauncherLayout({});
          setLauncherAnchors({});
          setWidgets([]);
          setLauncherLoadedFromBackend(true); // Marquer comme chargé (vide = OK)
          setTimeout(() => {
            launcherInitialLoadDone.current = true;
          }, 1000);
        }
      } catch (error) {
        console.error('[Home] ❌ Erreur chargement préférences:', error.message);
      }
    };
    
    if (accessMode && currentUserName) {
      loadPreferences();
    }
  }, [accessMode, currentUserName]);

  // Vérifier les mises à jour disponibles au chargement (une seule fois par session)
  useEffect(() => {
    if (!accessMode || !currentUserName || updateNotificationShown) {
      return;
    }

    const checkForUpdates = async () => {
      try {
        const serverUrl = getServerUrl(accessMode);
        const res = await axios.get(`${serverUrl}/api/settings/updates`);
        
        if (res.data?.ryvie?.updateAvailable) {
          console.log('[Home] 🔔 Mise à jour Ryvie disponible:', res.data.ryvie.latestVersion);
          setAvailableUpdate(res.data.ryvie);
          setShowUpdateBanner(true);
          setUpdateNotificationShown(true);
        }
      } catch (error) {
        console.error('[Home] Erreur vérification mises à jour:', error.message);
      }
    };

    // Vérifier après un court délai pour ne pas ralentir le chargement initial
    const timeoutId = setTimeout(checkForUpdates, 2000);
    return () => clearTimeout(timeoutId);
  }, [accessMode, currentUserName, updateNotificationShown]);



  const openAppWindow = (url, useOverlay = true, appName = '') => {
    console.log(`[Home] Ouverture de l'application: ${url}`);
    
    const currentUser = getCurrentUser();
    
    if (isElectron()) {
      // En Electron, utiliser le comportement existant
      window.open(url, '_blank', 'width=1000,height=700');
    } else {
      // En mode web: ouvrir en nouvel onglet, pas en fenêtre séparée
      const urlWithParams = new URL(url);
      if (currentUser) {
        urlWithParams.searchParams.set('ryvie_user', currentUser);
      }
      urlWithParams.searchParams.set('t', Date.now().toString());
      window.open(urlWithParams.toString(), '_blank');
    }
  };

  const handleLogout = () => {
    try {
      if (currentSocket) {
        currentSocket.disconnect();
      }
    } catch (e) {
      console.warn('[Home] Erreur lors de la déconnexion du socket:', e);
    }
    endSession();
    navigate('/login', { replace: true });
  };

  // Fonction pour fermer l'overlay AppStore intelligemment
  const closeAppStoreOverlay = () => {
    setClosingOverlay(true);
    setTimeout(() => {
      setOverlayVisible(false);
      setClosingOverlay(false);
      
      // Démonter l'AppStore si aucune installation n'est en cours
      if (!appStoreInstalling) {
        console.log('[Home] Aucune installation en cours, démontage immédiat de l\'AppStore');
        setAppStoreMounted(false);
        setOverlayUrl('');
      } else {
        console.log('[Home] Installation en cours, démontage différé de l\'AppStore');
        setPendingUnmount(true);
      }
    }, 250);
  };

  const handleClick = React.useCallback((iconId) => {
    console.log("handleClick appelé avec iconId:", iconId);
    
    const appConfig = appsConfig[iconId];
    
    if (!appConfig) {
      console.log("Pas de configuration trouvée pour cette icône :", iconId);
      console.log("Configuration disponible:", Object.keys(appsConfig));
      return;
    }
    
    // Cas spécial: AppStore -> ouvrir un overlay plein écran avec l'App Store
    const appNameLower = (appConfig.name || '').toLowerCase();
    if (appNameLower === 'appstore' || appConfig.urlKey === 'APPSTORE') {
      try {
        const base = window.location.origin + window.location.pathname;
        const url = `${base}#/appstore`;
        
        // Monter l'iframe si elle n'est pas déjà montée
        if (!appStoreMounted) {
          setOverlayUrl(url);
          setAppStoreMounted(true);
        }
        
        setOverlayTitle(t('home.appStore'));
        setOverlayVisible(true);
        setPendingUnmount(false); // Annuler tout démontage en attente
      } catch (e) {
        console.warn('[Home] Impossible d\'ouvrir l\'AppStore en overlay, navigation de secours /appstore');
        navigate('/appstore');
      }
      return;
    }
    
    // Cas spécial: Userlogin (transfer) -> ouvrir un overlay plein écran
    if (appConfig.route === '/userlogin') {
      try {
        const base = window.location.origin + window.location.pathname;
        const url = `${base}#/userlogin`;
        
        // Monter l'iframe si elle n'est pas déjà montée
        if (!appStoreMounted) {
          setOverlayUrl(url);
          setAppStoreMounted(true);
        }
        
        setOverlayTitle('Nouvelle session utilisateur');
        setOverlayVisible(true);
        setPendingUnmount(false); // Annuler tout démontage en attente
      } catch (e) {
        console.warn('[Home] Impossible d\'ouvrir Userlogin en overlay, navigation de secours /userlogin');
        navigate('/userlogin');
      }
      return;
    }
    
    // Si c'est une route interne (taskbar)
    if (appConfig.route) {
      // Cette logique sera gérée par le composant Link dans Taskbar
      return;
    }
    
    // Si c'est une application avec URL
    if (appConfig.urlKey) {
      const appUrl = getAppUrl(appConfig.urlKey, accessMode);
      
      if (appUrl) {
        openAppWindow(appUrl, !appConfig.useDirectWindow, appConfig.name);
      } else {
        console.log("Pas d'URL trouvée pour cette icône :", iconId);
      }
    }
  }, [appsConfig, appStoreMounted, accessMode, navigate]);

  // Construit l'URL de fond d'écran à partir de l'état courant
  const buildBackgroundUrl = () => {
    if (!accessMode) {
      console.log('[Home] accessMode non défini, pas de fond personnalisé');
      // Utiliser une dataURL si on en a une en cache
      if (bgDataUrl) {
        return `url(${bgDataUrl})`;
      }
      return null; // Utilise le CSS par défaut
    }
    
    console.log('[Home] 🎨 Application du fond:', backgroundImage);
    // Priorité au cache dataURL pour l'affichage offline
    if (bgDataUrl) {
      return `url(${bgDataUrl})`;
    }

    if (backgroundImage?.startsWith('custom-')) {
      // Fond personnalisé uploadé - charger via l'API backend
      const filename = backgroundImage.replace('custom-', '');
      const serverUrl = getServerUrl(accessMode);
      const bgUrl = `${serverUrl}/api/backgrounds/${filename}`;
      console.log('[Home] 🎨 Fond personnalisé:', bgUrl);
      return `url(${bgUrl})`;
    }
    
    // Si c'est un fond prédéfini (preset-filename.ext) - charger via API backend
    if (backgroundImage?.startsWith('preset-')) {
      if (!accessMode) return {};
      const filename = backgroundImage.replace('preset-', '');
      const serverUrl = getServerUrl(accessMode);
      console.log('[Home] 🎨 Fond prédéfini via API:', filename);
      return `url(${serverUrl}/api/backgrounds/presets/${filename})`;
    }
    
    // Fond par défaut - via API (le cache prendra le relais si disponible)
    if (!accessMode) return {};
    const serverUrl = getServerUrl(accessMode);
    console.log('[Home] 🎨 Fond par défaut via API');
    return `url(${serverUrl}/api/backgrounds/presets/default.webp)`;
  };

  // Mettre à jour les URLs de fond et déclencher un crossfade quand la source change
  useEffect(() => {
    const newUrl = buildBackgroundUrl();
    setPrevBgUrl((prev) => (prev === newUrl ? null : bgUrl));
    setBgUrl(newUrl);
    setBgFadeKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundImage, bgDataUrl, accessMode]);

  return (
    <div className={`home-container ${mounted ? 'slide-enter-active' : 'slide-enter'} ${taskbarReady ? 'taskbar-ready' : ''}`}>
      <DndProvider backend={HTML5Backend}>
        <div className="background">
          {/* Calques de fond pour crossfade */}
          {prevBgUrl && (
            <div
              key={`prev-${bgFadeKey}`}
              className="bg-layer"
              style={{ backgroundImage: prevBgUrl, opacity: 1 }}
            />
          )}
          <div
            key={`curr-${bgFadeKey}`}
            className={`bg-layer visible`}
            style={{ backgroundImage: bgUrl || undefined }}
          />
          <div className={`server-status ${displayServerStatus ? 'connected' : 'disconnected'}`}>
            <span className="status-text">
              {displayServerStatus ? t('home.connectionStatus.connected') : t('home.connectionStatus.disconnected')}
            </span>
            <span className="mode-indicator">
              {accessMode === 'private' ? t('home.connectionStatus.local') : t('home.connectionStatus.remote')}
            </span>
            {!isElectron() && (
              <span className="platform-indicator">{t('home.connectionStatus.web')}</span>
            )}
          </div>

          {isLoading && (
            <div className="loading-overlay">
              <div className="loading-spinner"></div>
            </div>
          )}

          <Taskbar
            handleClick={handleClick}
            appsConfig={appsConfig}
            onLoaded={() => {
              if (taskbarLoadedOnceRef.current) return;
              taskbarLoadedOnceRef.current = true;
              setTaskbarReady(true);
              // Annuler le timeout de secours si les images se chargent normalement
              if (taskbarTimeoutRef.current) {
                clearTimeout(taskbarTimeoutRef.current);
                taskbarTimeoutRef.current = null;
              }
            }}
          />
          {currentUserName && (
            <div className="user-chip" title={t('home.connectedUser')}>
              <div className="avatar">{String(currentUserName).charAt(0).toUpperCase()}</div>
              <div className="name">{currentUserName}</div>
            </div>
          )}
          
          {/* Bannière de notification de mise à jour */}
          {showUpdateBanner && availableUpdate && (
            <div
              style={{
                position: 'fixed',
                top: '18px',
                right: '18px',
                zIndex: 9999,
                fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif",
                background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
                backdropFilter: 'blur(20px)',
                borderRadius: '14px',
                padding: '14px 14px 12px',
                boxShadow: '0 16px 32px rgba(0, 0, 0, 0.10), 0 3px 10px rgba(0, 0, 0, 0.06)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                width: '320px',
                animation: updateBannerClosing
                  ? 'slideOutRight 0.32s cubic-bezier(0.4, 0, 1, 1) forwards'
                  : 'slideInRight 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
                border: '1px solid rgba(15, 23, 42, 0.08)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <div
                  style={{
                    width: '34px',
                    height: '34px',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.08) 0%, rgba(15, 23, 42, 0.04) 100%)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '18px',
                    flexShrink: 0
                  }}
                >
                  🔔
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: '#111827',
                      marginBottom: '2px',
                      letterSpacing: '-0.01em'
                    }}
                  >
                    {t('home.updateAvailable')}
                  </div>
                  <div
                    style={{
                      fontSize: '12px',
                      color: '#6b7280',
                      lineHeight: '1.45',
                      letterSpacing: '-0.005em'
                    }}
                  >
                    {t('home.versionAvailable', { version: availableUpdate.latestVersion })}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (updateBannerClosing) return;
                    setUpdateBannerClosing(true);
                    setTimeout(() => {
                      setShowUpdateBanner(false);
                      setUpdateBannerClosing(false);
                    }, 320);
                  }}
                  style={{
                    padding: '6px',
                    borderRadius: '10px',
                    border: 'none',
                    background: 'transparent',
                    color: 'rgba(15, 23, 42, 0.4)',
                    fontSize: '16px',
                    cursor: 'pointer',
                    lineHeight: 1,
                    transition: 'all 0.2s',
                    flexShrink: 0
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(15, 23, 42, 0.06)';
                    e.currentTarget.style.color = 'rgba(15, 23, 42, 0.7)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'rgba(15, 23, 42, 0.4)';
                  }}
                  title={t('home.close')}
                >
                  ✕
                </button>
              </div>
              <button
                onClick={() => {
                  if (updateBannerClosing) return;
                  navigate('/settings#updates');
                }}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  boxShadow: '0 2px 8px rgba(15, 23, 42, 0.14)',
                  letterSpacing: '-0.01em'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(15, 23, 42, 0.25)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(15, 23, 42, 0.15)';
                }}
              >
                {t('home.updateNow')}
              </button>
            </div>
          )}
          
          <div className="content">
            <GridLauncher
              apps={(function() {
                const hasLayout = launcherLayout && typeof launcherLayout === 'object' && Object.keys(launcherLayout).length > 0;
                const allAppIds = Object.keys(appsConfig || {}).filter(id => id && id.startsWith('app-'));
                if (!hasLayout) return allAppIds;
                const orderedFromLayout = Object.entries(launcherLayout)
                  .filter(([id, pos]) => id && appsConfig[id] && id !== 'weather' && !String(id).startsWith('widget-') && pos)
                  .sort((a, b) => (a[1].row - b[1].row) || (a[1].col - b[1].col))
                  .map(([id]) => id);
                const missing = allAppIds.filter(id => !orderedFromLayout.includes(id));
                return [...orderedFromLayout, ...missing];
              })()}
              weather={weather}
              weatherImages={weatherImages}
              weatherIcons={weatherIcons}
              weatherCity={weatherCity}
              iconImages={iconImages}
              appsConfig={appsConfig}
              appStatus={appStatus}
              handleClick={handleClick}
              setShowWeatherModal={setShowWeatherModal}
              setTempCity={setTempCity}
              setClosingWeatherModal={setClosingWeatherModal}
              activeContextMenu={activeContextMenu}
              setActiveContextMenu={setActiveContextMenu}
              isAdmin={isAdmin}
              setAppStatus={setAppStatus}
              onLayoutChange={handleLauncherLayoutChange}
              initialLayout={launcherLayout}
              initialAnchors={launcherAnchors}
              accessMode={accessMode}
              widgets={widgets}
              onAddWidget={handleAddWidget}
              onRemoveWidget={handleRemoveWidget}
              refreshDesktopIcons={refreshDesktopIcons}
            />
          </div>
          {/* Bouton de déconnexion fixe en bas à gauche */}
          <button className="logout-fab" onClick={handleLogout} title={t('home.logout')}>
            <span className="icon">⎋</span>
            <span className="label">{t('home.logout')}</span>
          </button>
        </div>
      
      {/* Overlay AppStore - toujours monté mais masqué quand non visible */}
      <div
        className={`appstore-overlay-backdrop ${closingOverlay ? 'closing' : ''}`}
        style={{
          display: overlayVisible ? 'flex' : 'none'
        }}
        onClick={(e) => {
          // fermer uniquement si on clique sur l'arrière-plan (pas à l'intérieur de la modale)
          if (e.target === e.currentTarget) {
            closeAppStoreOverlay();
          }
        }}
      >
        <div
          className={`appstore-overlay-window ${closingOverlay ? 'closing' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 20,
              display: 'flex',
              gap: 8,
              zIndex: 2
            }}
          >
            <button
              onClick={closeAppStoreOverlay}
              title="Fermer"
              style={{
                border: '1px solid #ddd',
                background: '#fff',
                borderRadius: 8,
                padding: '6px 10px',
                cursor: 'pointer'
              }}
            >
              ✕
            </button>
          </div>
          {appStoreMounted && overlayUrl && (
            <iframe
              title={overlayTitle}
              src={overlayUrl}
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          )}
        </div>
      </div>

      </DndProvider>
      
      {/* Modal changement de ville météo */}
      {showWeatherModal && (
        <div
          className={`weather-modal-backdrop ${closingWeatherModal ? 'closing' : 'open'}`}
          onClick={() => {
            if (savingWeatherCity) return;
            setClosingWeatherModal(true);
            setTimeout(() => {
              setShowWeatherModal(false);
              setClosingWeatherModal(false);
            }, 220);
          }}
        >
          <div
            className={`weather-modal ${closingWeatherModal ? 'closing' : 'open'}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="weather-modal-header">
              <h3>{t('home.chooseWeatherCity')}</h3>
              <p>{t('home.weatherCityDescription')}</p>
            </div>
            <div className="weather-modal-body">
              <label htmlFor="city-input">{t('home.city')}</label>
              <input
                id="city-input"
                type="text"
                placeholder={t('home.cityPlaceholder')}
                value={tempCity}
                onChange={(e) => setTempCity(e.target.value)}
                autoFocus
              />
            </div>
            <div className="weather-modal-actions">
              <button
                className="btn success"
                onClick={async () => {
                  if (!accessMode) return;
                  try {
                    setSavingWeatherCity(true);
                    const serverUrl = getServerUrl(accessMode);
                    await axios.patch(`${serverUrl}/api/user/preferences/weather-city`, { weatherCity: '__auto__' });
                    setWeatherCity(null);
                    setWeatherCityLoaded(true);
                    setClosingWeatherModal(true);
                    setTimeout(() => {
                      setShowWeatherModal(false);
                      setClosingWeatherModal(false);
                    }, 220);
                  } catch (e) {
                    console.error('[Home] ❌ Erreur mise en auto:', e);
                  } finally { setSavingWeatherCity(false); }
                }}
                disabled={savingWeatherCity}
                  title={t('home.useCurrentPosition')}
              >
                {savingWeatherCity ? t('home.inProgress') : t('home.useMyPosition')}
              </button>
              <div className="spacer" />
              <button
                className="btn ghost"
                onClick={() => {
                  if (savingWeatherCity) return;
                  setClosingWeatherModal(true);
                  setTimeout(() => {
                    setShowWeatherModal(false);
                    setClosingWeatherModal(false);
                  }, 220);
                }}
                disabled={savingWeatherCity}
              >{t('home.cancel')}</button>
              <button
                className="btn primary"
                onClick={async () => {
                  if (!accessMode || !tempCity.trim()) return;
                  try {
                    setSavingWeatherCity(true);
                    const serverUrl = getServerUrl(accessMode);
                    await axios.patch(`${serverUrl}/api/user/preferences/weather-city`, { weatherCity: tempCity.trim() });
                    setWeatherCity(tempCity.trim());
                    setClosingWeatherModal(true);
                    setTimeout(() => {
                      setShowWeatherModal(false);
                      setClosingWeatherModal(false);
                    }, 220);
                  } catch (e) {
                    console.error('[Home] ❌ Erreur sauvegarde ville:', e);
                  } finally { setSavingWeatherCity(false); }
                }}
                disabled={savingWeatherCity || !tempCity.trim()}
              >{t('home.save')}</button>
            </div>
          </div>
        </div>
      )}
      
      {/* Indicateur d'installation moderne - supporte plusieurs installations */}
      {Object.keys(installingApps).length > 0 && (
        <InstallIndicator installations={installingApps} />
      )}

      {/* Toast de notification */}
      {notification.show && (
        <div
          style={{
            position: 'fixed',
            top: '24px',
            right: '24px',
            background: 'white',
            padding: '16px 24px',
            borderRadius: '12px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            zIndex: 10000,
            animation: 'slideInFromTop 0.3s',
            maxWidth: '400px',
            borderLeft: `4px solid ${
              notification.type === 'success' ? '#4caf50' :
              notification.type === 'error' ? '#f44336' :
              notification.type === 'warning' ? '#ff9800' : '#2196f3'
            }`
          }}
        >
          <span style={{ fontSize: '20px' }}>
            {notification.type === 'success' ? '✓' : 
             notification.type === 'error' ? '✕' :
             notification.type === 'warning' ? '⚠' : 'ℹ'}
          </span>
          <span style={{ fontSize: '14px', color: '#333' }}>
            {notification.message}
          </span>
        </div>
      )}

      {/* Overlay d'onboarding pour les nouveaux utilisateurs */}
      {showOnboarding && (
        <OnboardingOverlay 
          onComplete={() => {
            setShowOnboarding(false);
            console.log('[Home] Onboarding complété');
          }}
        />
      )}
    </div>
  );
};

export default Home;
