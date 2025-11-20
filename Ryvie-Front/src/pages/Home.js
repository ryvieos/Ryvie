import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import '../styles/Home.css';
import '../styles/Transitions.css';
import axios from '../utils/setupAxios';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useSocket } from '../contexts/SocketContext';
import { Link, useNavigate } from 'react-router-dom';
import { getCurrentAccessMode, setAccessMode as setGlobalAccessMode } from '../utils/detectAccessMode';
import { isElectron, WindowManager, StorageManager, NotificationManager } from '../utils/platformUtils';
import { endSession, getCurrentUser, getCurrentUserRole, startSession, isSessionActive, getSessionInfo } from '../utils/sessionManager';
import urlsConfig from '../config/urls';
const { getServerUrl, getAppUrl } = urlsConfig;
import { 
  generateAppConfigFromManifests,
  generateDefaultAppsList,
  images 
} from '../config/appConfig';
import GridLauncher from '../components/GridLauncher';
 

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
    
    e.preventDefault();
    e.stopPropagation();
    
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
      alert(`Erreur: ID de l'application manquant (${id})`);
      return;
    }
    
    console.log(`[Icon] ${action} de ${appConfig.name} (ID: ${appConfig.id})...`);
    
    // Confirmation pour la désinstallation
    if (action === 'uninstall') {
      const confirmMsg = `Êtes-vous sûr de vouloir désinstaller "${appConfig.name}" ?\n\nCette action supprimera :\n- Les containers Docker\n- Les données de l'application\n- Les fichiers de configuration\n\nCette action est irréversible.`;
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
      
      // Si désinstallation réussie, recharger la page
      if (action === 'uninstall' && response.data.success) {
        alert(`${appConfig.name} a été désinstallé avec succès.`);
        console.log('[Icon] 🔄 Rechargement de la page pour actualiser les icônes...');
        
        // Attendre un court instant pour que le backend régénère les manifests
        setTimeout(() => {
          // Forcer un rechargement complet avec cache-busting
          window.location.href = window.location.href.split('?')[0] + '?t=' + Date.now();
        }, 1000);
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
        errorMsg = 'Timeout dépassé - l\'opération prend plus de 2 minutes';
      }
      alert(`Erreur lors du ${action} de ${appConfig.name}: ${errorMsg}`);
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
                ⏹️ Arrêter
              </div>
              <div className="context-menu-item" onClick={() => handleAppAction('restart')}>
                🔄 Redémarrer
              </div>
              <div className="context-menu-separator"></div>
              <div className="context-menu-item context-menu-item-danger" onClick={() => handleAppAction('uninstall')}>
                🗑️ Désinstaller
              </div>
            </>
          ) : (
            <>
              <div className="context-menu-item" onClick={() => handleAppAction('start')}>
                ▶️ Démarrer
              </div>
              <div className="context-menu-separator"></div>
              <div className="context-menu-item context-menu-item-danger" onClick={() => handleAppAction('uninstall')}>
                🗑️ Désinstaller
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

// Composant Taskbar
const Taskbar = ({ handleClick, appsConfig, onLoaded }) => {
  // Filtrer les icônes de la barre des tâches à partir de la configuration
  const taskbarApps = Object.entries(appsConfig)
    .filter(([_, config]) => config.isTaskbarApp)
    .map(([iconId, config]) => ({ iconId, config }));

  let total = 0;
  let loaded = 0;
  const handleImgLoad = () => {
    loaded += 1;
    if (loaded === total) {
      try { onLoaded && onLoaded(); } catch {}
    }
  };

  return (
    <div className="taskbar">
      {taskbarApps.map(({ iconId, config }, index) => {
        const imgSrc = images[iconId];
        const label = config?.name || iconId;
        try { console.debug('[Taskbar] Render icon', { iconId, label, hasImage: !!imgSrc, route: config?.route, src: imgSrc }); } catch (_) {}
        if (imgSrc) total += 1;
        const Img = () => (
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
        );

        return (
          <div key={index} className="taskbar-circle" aria-label={label} title={label}>
            {config.route && config.route !== '/userlogin' ? (
              <Link to={config.route} aria-label={label} title={label} style={{ width: '100%', height: '100%' }}>
                {imgSrc ? <Img /> : null}
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
                {imgSrc ? <Img /> : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// Composant principal
const Home = () => {
  const navigate = useNavigate();
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
      location: 'Loading...',
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
  const [overlayTitle, setOverlayTitle] = useState('App Store');

  const [mounted, setMounted] = useState(false);
  const { socket, isConnected: socketConnected, serverStatus, setServerStatus } = useSocket();
  
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
  const [bgDataUrl, setBgDataUrl] = useState(null); // DataURL du fond d'écran mis en cache
  const [bgUrl, setBgUrl] = useState(null);         // URL calculée courante
  const [prevBgUrl, setPrevBgUrl] = useState(null); // URL précédente pour crossfade
  const [bgFadeKey, setBgFadeKey] = useState(0);    // clé pour relancer l'animation
  const [disconnectedSince, setDisconnectedSince] = useState(null); // Timestamp de début de déconnexion
  const launcherSaveRef = React.useRef(null); // debounce save
  const [launcherLayout, setLauncherLayout] = useState(() => {
    // Charger depuis le cache localStorage au montage
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`launcher_${currentUser}`);
        if (cached) {
          const launcher = JSON.parse(cached);
          return launcher.layout || null;
        }
      }
    } catch {}
    return null;
  }); // Layout chargé depuis le backend
  const [launcherAnchors, setLauncherAnchors] = useState(() => {
    // Charger depuis le cache localStorage au montage
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`launcher_${currentUser}`);
        if (cached) {
          const launcher = JSON.parse(cached);
          return launcher.anchors || null;
        }
      }
    } catch {}
    return null;
  }); // Ancres chargées depuis le backend
  const [launcherLoadedFromBackend, setLauncherLoadedFromBackend] = useState(() => {
    // Si on a un cache, considérer comme "chargé" pour affichage immédiat
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`launcher_${currentUser}`);
        return !!cached;
      }
    } catch {}
    return false;
  }); // Indique si les données ont été chargées
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
  // Ancres par défaut si l'utilisateur n'a rien en backend
  const DEFAULT_ANCHORS = React.useMemo(() => ({
    weather: 2,
    'app-rtransfer': 22,
    'app-rdrop': 25,
    'app-rdrive': 23,
    'app-rpictures': 24
  }), []);
  // Générer dynamiquement un layout/apps/ancres par défaut à partir des apps disponibles
  const computeDefaults = React.useCallback((appIds = []) => {
    // Positionner la météo fixe comme demandé
    const layout = {
      weather: { col: 2, row: 0, w: 3, h: 2 }
    };
    const anchors = { ...DEFAULT_ANCHORS };
    // Placer les apps connues en ligne à partir de col=2, row=2
    let col = 2;
    const row = 2;
    let anchor = 22; // suit le même schéma que les demandes précédentes
    const ordered = [];
    // Utiliser toutes les apps connues (triées par id)
    const sourceIds = Object.keys(appsConfig || {}).filter(id => id && id.startsWith('app-')).sort();
    sourceIds.forEach((id) => {
      // Si appsConfig n'est pas encore chargé, ne pas filtrer; sinon ignorer les ids inconnus
      if (appsConfig && Object.keys(appsConfig).length > 0 && !appsConfig[id]) return;
      // Ne pas ajouter météo ni widgets
      if (id === 'weather' || String(id).startsWith('widget-')) return;
      layout[id] = { col, row, w: 1, h: 1 };
      anchors[id] = anchor;
      ordered.push(id);
      col += 1;
      anchor += 1;
    });
    return { layout, anchors, apps: ordered };
  }, [appsConfig, DEFAULT_ANCHORS]);
  const savedDefaultOnceRef = React.useRef(false);
  
  // Fonction pour rafraîchir les icônes du bureau après installation/désinstallation
  const refreshDesktopIcons = React.useCallback(async () => {
    if (!accessMode) return;
    
    try {
      console.log('[Home] 🔄 Rafraîchissement des icônes du bureau...');
      const config = await generateAppConfigFromManifests(accessMode);
      
      if (Object.keys(config).length > 0) {
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
          
          const layoutChanged = Object.keys(cleanedLayout).length !== Object.keys(launcherLayout).length;
          const anchorsChanged = launcherAnchors && Object.keys(cleanedAnchors).length !== Object.keys(launcherAnchors).length;
          
          if (layoutChanged || anchorsChanged) {
            console.log('[Home] 📝 Mise à jour du layout/anchors après nettoyage');
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
                }
              }
            } catch (e) {
              console.warn('[Home] ⚠️ Erreur lors de la sauvegarde du layout nettoyé:', e);
            }
            
            // Sauvegarder aussi dans le backend
            try {
              const serverUrl = getServerUrl(accessMode);
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
      }
    } catch (error) {
      console.error('[Home] ❌ Erreur lors du rafraîchissement des icônes:', error);
    }
  }, [accessMode, launcherLayout, launcherAnchors, widgets]);

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
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [navigate, refreshDesktopIcons]);
  
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
  
  // Charger la config depuis les manifests quand le mode d'accès est défini
  useEffect(() => {
    if (!accessMode) return;
    
    const loadConfigFromManifests = async () => {
      try {
        console.log('[Home] Chargement de la config depuis les manifests...');
        const config = await generateAppConfigFromManifests(accessMode);
        
        if (Object.keys(config).length > 0) {
          console.log('[Home] Config chargée depuis manifests:', Object.keys(config).length, 'apps');
          setAppsConfig(config);
          // Sauvegarder dans le cache
          StorageManager.setItem('appsConfig_cache', config);
          
          // Extraire et mettre à jour les icônes
          const newIconImages = { ...images }; // Commencer avec les icônes par défaut
          Object.keys(config).forEach(iconId => {
            if (config[iconId].icon) {
              newIconImages[iconId] = config[iconId].icon;
            }
          });
          setIconImages(newIconImages);
          StorageManager.setItem('iconImages_cache', newIconImages);
          console.log('[Home] Icônes mises à jour:', Object.keys(newIconImages).length);
          
          // Apps chargées depuis les manifests
        } else {
          console.log('[Home] Aucune app trouvée dans les manifests, utilisation de la config par défaut');
        }
      } catch (error) {
        console.error('[Home] Erreur lors du chargement de la config depuis manifests:', error);
      }
    };
    
    loadConfigFromManifests();
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
  
  // Mettre à jour les statuts quand appsConfig change
  useEffect(() => {
    if (!applications || applications.length === 0 || Object.keys(appsConfig).length === 0) {
      return;
    }
    
    console.log('[Home] Mise à jour des statuts avec appsConfig chargé');
    const newAppStatus = {};
    
    applications.forEach(app => {
      const configEntry = Object.entries(appsConfig).find(([iconId, config]) => {
        const match = config.name?.toLowerCase() === app.name?.toLowerCase() || 
                     iconId.includes(app.name?.toLowerCase()) ||
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
    
    console.log('[Home] Statuts mis à jour:', newAppStatus);
    setAppStatus(newAppStatus);
    // Sauvegarder dans le cache
    StorageManager.setItem('appStatus_cache', newAppStatus);
  }, [appsConfig, applications]);
  
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
        const response = await axios.get(`${appsBase}/api/apps`);
        const apps = response.data.map(app => ({
          ...app,
          port: app.ports && app.ports.length > 0 ? app.ports[0] : null,
          autostart: false
        }));
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
        setApplications(prevApps => {
          return updatedApps.map(updatedApp => {
            const existingApp = prevApps.find(app => app.id === updatedApp.id);
            return {
              ...updatedApp,
              port: updatedApp.ports && updatedApp.ports.length > 0 ? updatedApp.ports[0] : null,
              autostart: existingApp ? existingApp.autostart : false
            };
          });
        });

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
        setAppStatus(newAppStatus);
        // Sauvegarder dans le cache
        StorageManager.setItem('appStatus_cache', newAppStatus);
      };
      
      // Écouter les deux noms d'événement pour compatibilité
      socket.on('appsStatusUpdate', handleAppsStatusUpdate);
      socket.on('apps-status-update', handleAppsStatusUpdate);
      
      return () => {
        socket.off('appsStatusUpdate', handleAppsStatusUpdate);
        socket.off('apps-status-update', handleAppsStatusUpdate);
      };
    }
  }, [accessMode, socket, appsConfig]);
  
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
              if (!navigator.geolocation) return reject(new Error('Geolocation non disponible'));
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

  // Surveiller les changements de serverStatus pour recharger la page si reconnexion après >2s de déconnexion
  useEffect(() => {
    if (!serverStatus) {
      // Serveur déconnecté: enregistrer le timestamp si pas déjà fait
      if (!disconnectedSince) {
        console.log('[Home] Serveur déconnecté, début du compteur');
        setDisconnectedSince(Date.now());
        // Réinitialiser le flag de chargement pour éviter de sauvegarder des données obsolètes
        setLauncherLoadedFromBackend(false);
      }
    } else {
      // Serveur connecté: vérifier si on était déconnecté pendant plus de 2s
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

  // Taskbar prête quand toutes les images locales sont chargées
  useEffect(() => {
    setTaskbarReady(false);
  }, [appsConfig]);

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
        urlWithParams.searchParams.set('ryvie_logout', 'true');
        urlWithParams.searchParams.set('ryvie_clear_session', 'true');
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

  const handleClick = (iconId) => {
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
        setOverlayUrl(url);
        setOverlayTitle('App Store');
        setOverlayVisible(true);
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
        setOverlayUrl(url);
        setOverlayTitle('Nouvelle session utilisateur');
        setOverlayVisible(true);
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
  };

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
          <div className={`server-status ${serverStatus ? 'connected' : 'disconnected'}`}>
            <span className="status-text">
              {serverStatus ? 'Connecté' : 'Déconnecté'}
            </span>
            <span className="mode-indicator">
              {accessMode === 'private' ? 'Local' : 'Public'}
            </span>
            {!isElectron() && (
              <span className="platform-indicator">Web</span>
            )}
          </div>

          {isLoading && (
            <div className="loading-overlay">
              <div className="loading-spinner"></div>
            </div>
          )}

          <Taskbar handleClick={handleClick} appsConfig={appsConfig} onLoaded={() => setTaskbarReady(true)} />
          {currentUserName && (
            <div className="user-chip" title="Utilisateur connecté">
              <div className="avatar">{String(currentUserName).charAt(0).toUpperCase()}</div>
              <div className="name">{currentUserName}</div>
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
          <button className="logout-fab" onClick={handleLogout} title="Déconnexion">
            <span className="icon">⎋</span>
            <span className="label">Déconnexion</span>
          </button>
        </div>
      
      {overlayVisible && (
        <div
          className={`appstore-overlay-backdrop ${closingOverlay ? 'closing' : ''}`}
          onClick={(e) => {
            // fermer uniquement si on clique sur l'arrière-plan (pas à l'intérieur de la modale)
            if (e.target === e.currentTarget) {
              setClosingOverlay(true);
              setTimeout(() => {
                setOverlayVisible(false);
                setClosingOverlay(false);
              }, 250);
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
                onClick={() => {
                  setClosingOverlay(true);
                  setTimeout(() => {
                    setOverlayVisible(false);
                    setClosingOverlay(false);
                  }, 250);
                }}
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
            <iframe
              title={overlayTitle}
              src={overlayUrl}
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          </div>
        </div>
      )}

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
              <h3>Choisir la ville pour la météo</h3>
              <p>Vous pouvez utiliser votre position actuelle (automatique) ou définir une ville.</p>
            </div>
            <div className="weather-modal-body">
              <label htmlFor="city-input">Ville</label>
              <input
                id="city-input"
                type="text"
                placeholder="Ex: Lille, Lyon, Marseille"
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
                title="Utiliser la position actuelle (autoriser la géolocalisation)"
              >
                {savingWeatherCity ? 'En cours…' : 'Utiliser ma position (auto)'}
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
              >Annuler</button>
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
              >Enregistrer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Home;
