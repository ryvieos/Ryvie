import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import '../styles/Home.css';
import '../styles/Transitions.css';
import axios from '../utils/setupAxios';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { connectRyvieSocket } from '../utils/detectAccessMode';
import { Link, useNavigate } from 'react-router-dom';
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { isElectron, WindowManager, StorageManager, NotificationManager } from '../utils/platformUtils';
import { endSession, getCurrentUser } from '../utils/sessionManager';
import urlsConfig from '../config/urls';
const { getServerUrl, getAppUrl } = urlsConfig;
import { 
  generateAppConfig, 
  generateDefaultZones, 
  generateAppConfigFromManifests,
  generateDefaultZonesFromManifests,
  images 
} from '../config/appConfig';

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
      style={{ position: 'fixed', top: y, left: x, zIndex: 100000 }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
  return ReactDOM.createPortal(menu, document.body);
};

const Icon = ({ id, src, zoneId, moveIcon, handleClick, showName = true, appStatusData, appsConfig, activeContextMenu, setActiveContextMenu }) => {
  const ref = React.useRef(null);
  const appConfig = appsConfig[id] || {};

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
    
    // Si on a des données de statut, utiliser la vraie couleur
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
    // Ne montrer le menu que pour les apps avec showStatus (pas les icônes système)
    if (!appConfig.showStatus) return;
    
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
    
    try {
      const serverUrl = getServerUrl();
      const response = await axios.post(`${serverUrl}/api/apps/${appConfig.id}/${action}`);
      console.log(`[Icon] ${action} ${appConfig.name}:`, response.data);
    } catch (error) {
      console.error(`[Icon] Erreur ${action}:`, error);
    }
  };

  return (
    <>
      <div className="icon-container">
        <div
          ref={ref}
          className="icon"
          style={{
            backgroundImage: `url(${src})`,
            cursor: isClickable ? 'pointer' : 'not-allowed',
            position: 'relative',
          }}
          onClick={handleIconClick}
          onContextMenu={handleContextMenu}
        >
          {badgeStyle && <div className="status-badge" style={badgeStyle}></div>}
        </div>
        {showName && <p className="icon-name">{appConfig.name || id.replace('.jpeg', '').replace('.png', '').replace('.svg', '')}</p>}
      </div>
      
      {/* Menu contextuel - affiché uniquement pour cette icône via portal */}
      {activeContextMenu && activeContextMenu.iconId === id && (
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

// Composant Zone
const Zone = ({ zoneId, iconId, moveIcon, handleClick, showName, appStatus, appsConfig, iconImages, activeContextMenu, setActiveContextMenu }) => {
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.ICON,
    canDrop: () => true,
    drop: (item) => {
      if (item.id !== iconId[0] || item.zoneId !== zoneId) {
        moveIcon(item.id, item.zoneId, zoneId);
        item.zoneId = zoneId;
      }
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
            moveIcon={moveIcon}
            handleClick={handleClick}
            showName={showName}
            appStatusData={appStatus[iconId[0]]}
            appsConfig={appsConfig}
            activeContextMenu={activeContextMenu}
            setActiveContextMenu={setActiveContextMenu}
          />
        )}
      </div>
    </div>
  );
};

// Composant Taskbar
const Taskbar = ({ handleClick, appsConfig }) => {
  // Filtrer les icônes de la barre des tâches à partir de la configuration
  const taskbarApps = Object.entries(appsConfig)
    .filter(([_, config]) => config.isTaskbarApp)
    .map(([iconId, config]) => ({ iconId, config }));

  return (
    <div className="taskbar">
      {taskbarApps.map(({ iconId, config }, index) => {
        const imgSrc = images[iconId];
        const label = config?.name || iconId;
        try { console.debug('[Taskbar] Render icon', { iconId, label, hasImage: !!imgSrc, route: config?.route, src: imgSrc }); } catch (_) {}

        const Img = () => (
          <img
            src={imgSrc}
            alt={label}
            title={label}
            onError={(e) => {
              try { console.warn('[Taskbar] Image failed to load', { iconId, src: imgSrc }); } catch (_) {}
              e.currentTarget.style.display = 'none';
            }}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        );

        return (
          <div key={index} className="taskbar-circle" aria-label={label} title={label}>
            {config.route ? (
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
  const [appsConfig, setAppsConfig] = useState(generateAppConfig()); // Config par défaut
  const [iconImages, setIconImages] = useState(images); // Images locales
  const [backgroundImage, setBackgroundImage] = useState('default'); // Fond d'écran utilisateur
  const [weatherCity, setWeatherCity] = useState(null); // Ville configurée par l'utilisateur
  const [weatherCityLoaded, setWeatherCityLoaded] = useState(false); // Indique si les préférences sont chargées
  const [showWeatherModal, setShowWeatherModal] = useState(false);
  const [closingWeatherModal, setClosingWeatherModal] = useState(false);
  const [tempCity, setTempCity] = useState('');
  const [savingWeatherCity, setSavingWeatherCity] = useState(false);
  
  // Commencer avec des zones vides, elles seront chargées depuis le serveur
  const [zones, setZones] = useState({
    left: [],
    right: [],
    bottom1: [],
    bottom2: [],
    bottom3: [],
    bottom4: [],
    bottom5: [],
    bottom6: [],
    bottom7: [],
    bottom8: [],
    bottom9: [],
    bottom10: []
  });

  const [weather, setWeather] = useState({
    location: 'Loading...',
    temperature: null,
    description: '',
    icon: 'default.png',
  });

  const [serverStatus, setServerStatus] = useState(false);
  const [appStatus, setAppStatus] = useState({});
  const [applications, setApplications] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  // Overlay AppStore
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayUrl, setOverlayUrl] = useState('');

  const [mounted, setMounted] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [currentSocket, setCurrentSocket] = useState(null);
  const [activeContextMenu, setActiveContextMenu] = useState(null); // Menu contextuel global
  
  useEffect(() => {
    const initializeAccessMode = () => {
      // TOUJOURS utiliser le mode stocké - ne jamais faire de détection automatique
      const mode = getCurrentAccessMode(); // peut être null
      setAccessMode(mode);
      console.log(`[Home] Mode d'accès récupéré depuis le stockage: ${mode}`);
    };

    initializeAccessMode();
    // Récupérer l'utilisateur connecté
    try {
      setCurrentUserName(getCurrentUser() || '');
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
          // Les zones seront chargées par le useEffect dédié (depuis le serveur)
        } else {
          console.log('[Home] Aucune app trouvée dans les manifests, utilisation de la config par défaut');
        }
      } catch (error) {
        console.error('[Home] Erreur lors du chargement de la config depuis manifests:', error);
      }
    };
    
    loadConfigFromManifests();
  }, [accessMode]);
  
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
        
      } catch (error) {
        console.error('[Home] Erreur lors de la récupération des applications:', error);
      }
    };

    // Récupérer les applications au chargement
    fetchApplications();
    
    const socket = connectRyvieSocket({
      mode: accessMode,
      onConnect: (s) => {
        console.log(`[Home] Socket.io connecté en mode ${accessMode}`);
        setCurrentSocket(s);
        setSocketConnected(true);
        setServerStatus(true);
      },
      onDisconnect: () => {
        console.log('[Home] Socket.io déconnecté');
        setSocketConnected(false);
        setServerStatus(false);
      },
      onError: (error) => {
        console.log(`[Home] Erreur de connexion Socket.io en mode ${accessMode}:`, error?.message);
        setSocketConnected(false);
        setServerStatus(false);
        if (!isElectron()) {
          console.log('[Home] Mode web - arrêt des tentatives de connexion Socket.io');
        }
      },
      onServerStatus: (data) => {
        console.log('[Home] Statut serveur reçu:', data.status);
        setServerStatus(data.status);
      },
      onAppsStatusUpdate: (updatedApps) => {
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
      },
      timeoutMs: 10000,
    });
    
    return () => {
      try {
        if (socket) socket.disconnect();
        if (currentSocket && currentSocket !== socket) currentSocket.disconnect();
      } catch {}
    };
  }, [accessMode]);
  
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

        let icon = 'sunny.png';
        if (weatherCode >= 1 && weatherCode <= 3) {
          icon = 'cloudy.png';
        } else if ([61, 63, 65].includes(weatherCode)) {
          icon = 'rainy.png';
        }

        setWeather({
          location: cityName,
          temperature: data.current_weather.temperature,
          humidity: data.hourly.relative_humidity_2m[0],
          wind: data.current_weather.windspeed,
          description: weatherCode,
          icon: icon,
        });
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

          setWeather({
            location: 'Paris',
            temperature: pdata.current_weather.temperature,
            humidity: pdata.hourly.relative_humidity_2m?.[0] ?? null,
            wind: pdata.current_weather.windspeed,
            description: pcode,
            icon: picon,
          });
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
  }, [weatherCity, weatherCityLoaded]); // Recharger quand la ville change ou quand les préférences sont chargées

  // Supprimer ce useEffect dupliqué car géré dans le premier useEffect

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  // Fermer le menu contextuel si on clique ailleurs
  useEffect(() => {
    const handleClickOutside = () => setActiveContextMenu(null);
    if (activeContextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [activeContextMenu]);


  // Charger les zones depuis le serveur dès que possible
  useEffect(() => {
    console.log('[Home] useEffect chargement zones - accessMode:', accessMode, 'currentUserName:', currentUserName);
    
    const loadZones = async () => {
      if (!accessMode || !currentUserName) {
        console.log('[Home] ⏳ En attente de accessMode et currentUserName...');
        return;
      }
      
      try {
        const serverUrl = getServerUrl(accessMode);
        console.log('[Home] 🔄 Chargement zones depuis le serveur pour', currentUserName);
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
        }
        
        if (res.data?.zones && Object.keys(res.data.zones).length > 0) {
          console.log('[Home] ✅ Zones chargées depuis le serveur:', res.data.zones);
          
          // Vérifier si les zones sont vraiment vides (tous les tableaux vides)
          const allZonesEmpty = Object.values(res.data.zones).every(
            zone => Array.isArray(zone) && zone.length === 0
          );
          
          if (allZonesEmpty) {
            console.log('[Home] ⚠️ Zones vides détectées, génération depuis manifests');
            const defaultZones = await generateDefaultZonesFromManifests(accessMode);
            setZones(defaultZones);
            // Sauvegarder les zones par défaut sur le serveur
            await axios.patch(`${serverUrl}/api/user/preferences/zones`, { zones: defaultZones });
            StorageManager.setItem(`iconZones_${currentUserName}`, defaultZones);
          } else {
            // Réconciliation: utiliser les apps réelles depuis l'API
            // Récupérer la liste des apps installées
            const appsResponse = await axios.get(`${serverUrl}/api/apps`);
            const installedApps = appsResponse.data || [];
            const validAppIds = new Set(installedApps.map(app => `app-${app.id}`));
            
            console.log('[Home] 📋 Apps installées détectées:', Array.from(validAppIds));
            
            const cleanedZones = {};
            let hasChanges = false;
            
            Object.keys(res.data.zones).forEach(zoneName => {
              const originalIds = res.data.zones[zoneName] || [];
              const filteredIds = originalIds.filter(id => {
                // Garder les IDs qui ne sont pas des apps (ex: icônes taskbar)
                if (!id.startsWith('app-')) {
                  return true;
                }
                
                // Pour les apps, vérifier qu'elles existent
                const isValid = validAppIds.has(id);
                if (!isValid) {
                  console.log(`[Home] 🧹 Retrait de l'app inexistante: ${id} de ${zoneName}`);
                  hasChanges = true;
                }
                return isValid;
              });
              cleanedZones[zoneName] = filteredIds;
            });
            
            // Détecter les nouvelles apps (présentes dans l'API mais pas dans les zones)
            const allZonedApps = new Set();
            Object.values(cleanedZones).forEach(zone => {
              zone.forEach(id => {
                if (id.startsWith('app-')) allZonedApps.add(id);
              });
            });
            
            const newApps = Array.from(validAppIds).filter(id => !allZonedApps.has(id));
            if (newApps.length > 0) {
              console.log('[Home] ➕ Nouvelles apps détectées:', newApps);
              // Placer les nouvelles apps dans les premières zones bottom disponibles
              let bottomIndex = 1;
              newApps.forEach(appId => {
                while (bottomIndex <= 10 && cleanedZones[`bottom${bottomIndex}`].length > 0) {
                  bottomIndex++;
                }
                if (bottomIndex <= 10) {
                  cleanedZones[`bottom${bottomIndex}`].push(appId);
                  console.log(`[Home] ➕ Ajout de ${appId} dans bottom${bottomIndex}`);
                  hasChanges = true;
                  bottomIndex++;
                }
              });
            }
            
            console.log('[Home] 🔄 Application des zones réconciliées:', cleanedZones);
            setZones(cleanedZones);
            
            // Si des apps ont été retirées ou ajoutées, sauvegarder les zones
            if (hasChanges) {
              console.log('[Home] 💾 Sauvegarde des zones réconciliées sur le serveur');
              await axios.patch(`${serverUrl}/api/user/preferences/zones`, { zones: cleanedZones });
            }
            
            // Sauvegarder en cache local
            StorageManager.setItem(`iconZones_${currentUserName}`, cleanedZones);
          }
          
          // Charger le fond d'écran utilisateur
          if (res.data?.backgroundImage) {
            console.log('[Home] 🎨 Fond d\'écran chargé:', res.data.backgroundImage);
            setBackgroundImage(res.data.backgroundImage);
          }
        } else {
          console.log('[Home] ⚠️ Pas de zones sur le serveur, génération depuis manifests');
          const defaultZones = await generateDefaultZonesFromManifests(accessMode);
          setZones(defaultZones);
          // Sauvegarder les zones par défaut sur le serveur
          await axios.patch(`${serverUrl}/api/user/preferences/zones`, { zones: defaultZones });
        }
      } catch (error) {
        console.error('[Home] ❌ Erreur chargement zones:', error.message);
        // Fallback sur localStorage uniquement en cas d'erreur
        const savedZones = StorageManager.getItem(`iconZones_${currentUserName}`);
        if (savedZones) {
          console.log('[Home] 💾 Fallback: zones chargées depuis localStorage');
          setZones(savedZones);
        } else {
          console.log('[Home] 🆕 Génération des zones par défaut depuis manifests');
          const defaultZones = await generateDefaultZonesFromManifests(accessMode);
          setZones(defaultZones);
        }
      }
    };
    
    if (accessMode && currentUserName) {
      loadZones();
    }
  }, [accessMode, currentUserName]);

  // Sauvegarder les zones sur le serveur
  const saveZonesToServer = React.useCallback(async (newZones) => {
    if (!accessMode || !currentUserName) {
      console.log('[Home] Sauvegarde ignorée (pas de mode ou utilisateur)');
      return;
    }
    
    try {
      const serverUrl = getServerUrl(accessMode);
      console.log('[Home] Sauvegarde zones pour', currentUserName, 'vers', serverUrl);
      await axios.patch(`${serverUrl}/api/user/preferences/zones`, { zones: newZones });
      console.log('[Home] Zones sauvegardées sur le serveur');
    } catch (error) {
      console.error('[Home] Erreur sauvegarde zones:', error);
      // Sauvegarder au moins localement
      if (currentUserName) {
        StorageManager.setItem(`iconZones_${currentUserName}`, newZones);
      }
    }
  }, [accessMode, currentUserName]);

  const moveIcon = (id, fromZoneId, toZoneId) => {
    setZones((prevZones) => {
      // Assurer que les zones existent
      const fromIcons = (prevZones[fromZoneId] || []).filter((iconId) => iconId !== id);
      let toIcons = prevZones[toZoneId] || [];

      if (toIcons.length === 0) {
        toIcons = [id];
      } else {
        const [existingIconId] = toIcons;
        toIcons = [id];
        fromIcons.push(existingIconId);
      }

      const newZones = {
        ...prevZones,
        [fromZoneId]: fromIcons,
        [toZoneId]: toIcons,
      };
      
      // Sauvegarder les zones localement (avec nom d'utilisateur) et sur le serveur
      if (currentUserName) {
        StorageManager.setItem(`iconZones_${currentUserName}`, newZones);
      }
      saveZonesToServer(newZones);
      
      return newZones;
    });
  };


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
        setOverlayVisible(true);
      } catch (e) {
        console.warn('[Home] Impossible d\'ouvrir l\'AppStore en overlay, navigation de secours /appstore');
        navigate('/appstore');
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

  // Fonction pour obtenir le style de fond d'écran
  const getBackgroundStyle = () => {
    if (!accessMode) {
      console.log('[Home] accessMode non défini, pas de fond personnalisé');
      return {}; // Utilise le CSS par défaut
    }
    
    console.log('[Home] 🎨 Application du fond:', backgroundImage);
    
    if (backgroundImage?.startsWith('custom-')) {
      // Fond personnalisé uploadé - charger via l'API backend
      const filename = backgroundImage.replace('custom-', '');
      const serverUrl = getServerUrl(accessMode);
      const bgUrl = `${serverUrl}/api/backgrounds/${filename}`;
      console.log('[Home] 🎨 Fond personnalisé:', bgUrl);
      return {
        background: `url(${bgUrl}) no-repeat center center fixed`,
        backgroundSize: 'cover'
      };
    }
    
    // Si c'est un fond prédéfini (preset-filename.ext) - charger via API backend
    if (backgroundImage?.startsWith('preset-')) {
      if (!accessMode) return {};
      const filename = backgroundImage.replace('preset-', '');
      const serverUrl = getServerUrl(accessMode);
      console.log('[Home] 🎨 Fond prédéfini via API:', filename);
      
      return {
        background: `url(${serverUrl}/api/backgrounds/presets/${filename}) no-repeat center center fixed`,
        backgroundSize: 'cover'
      };
    }
    
    // Fond par défaut - charger via API backend
    if (!accessMode) return {};
    const serverUrl = getServerUrl(accessMode);
    console.log('[Home] 🎨 Fond par défaut via API');
    return {
      background: `url(${serverUrl}/api/backgrounds/presets/default.webp) no-repeat center center fixed`,
      backgroundSize: 'cover'
    };
  };

  return (
    <div className={`home-container ${mounted ? 'slide-enter-active' : 'slide-enter'}`}>
      <DndProvider backend={HTML5Backend}>
        <div className="background" style={getBackgroundStyle()}>
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

          <Taskbar handleClick={handleClick} appsConfig={appsConfig} />
          {currentUserName && (
            <div className="user-chip" title="Utilisateur connecté">
              <div className="avatar">{String(currentUserName).charAt(0).toUpperCase()}</div>
              <div className="name">{currentUserName}</div>
            </div>
          )}
          <div className="content">
            <h1 className="title">Bienvenue dans votre Cloud</h1>
            <div className="main-content">
              <div className="top-zones">
                <Zone
                  zoneId="left"
                  iconId={zones['left']}
                  moveIcon={moveIcon}
                  handleClick={handleClick}
                  appStatus={appStatus}
                  appsConfig={appsConfig}
                  iconImages={iconImages}
                  activeContextMenu={activeContextMenu}
                  setActiveContextMenu={setActiveContextMenu}
                />
              </div>
              <div 
                className="widget" 
                style={{ backgroundImage: weatherImages[`./${weather.icon}`] ? `url(${weatherImages[`./${weather.icon}`]})` : 'none', cursor: 'pointer' }}
                onClick={() => {
                  setTempCity((weatherCity || weather.location || '').toString());
                  setClosingWeatherModal(false);
                  setShowWeatherModal(true);
                }}
                title="Cliquez pour changer de ville"
              >
                <div className="weather-info">
                  <p className="weather-city">{weather.location ? weather.location : 'Localisation non disponible'}</p>
                  <p className="weather-temperature">
                    {weather.temperature ? `${Math.round(weather.temperature)}°C` : '...'}
                  </p>
                  <div className="weather-humidity">
                    <img src={weatherIcons['./humidity.png']} alt="Humidity Icon" className="weather-icon" />
                    {weather.humidity ? `${weather.humidity}%` : '...'}
                  </div>
                  <div className="weather-wind">
                    <img src={weatherIcons['./wind.png']} alt="Wind Icon" className="weather-icon" />
                    {weather.wind ? `${Math.round(weather.wind)} km/h` : '...'}
                  </div>
                </div>
              </div>
              <div className="top-zones">
                <Zone
                  zoneId="right"
                  iconId={zones['right']}
                  moveIcon={moveIcon}
                  handleClick={handleClick}
                  appStatus={appStatus}
                  appsConfig={appsConfig}
                  iconImages={iconImages}
                  activeContextMenu={activeContextMenu}
                  setActiveContextMenu={setActiveContextMenu}
                  className="zone-right"
                />
              </div>
            </div>
            <div className="bottom-zones">
              {Array.from({ length: 10 }, (_, i) => (
                <Zone
                  key={`bottom${i + 1}`}
                  zoneId={`bottom${i + 1}`}
                  iconId={zones[`bottom${i + 1}`]}
                  moveIcon={moveIcon}
                  handleClick={handleClick}
                  appStatus={appStatus}
                  appsConfig={appsConfig}
                  iconImages={iconImages}
                  activeContextMenu={activeContextMenu}
                  setActiveContextMenu={setActiveContextMenu}
                />
              ))}
            </div>
          </div>
          {/* Bouton de déconnexion fixe en bas à gauche */}
          <button className="logout-fab" onClick={handleLogout} title="Déconnexion">
            <span className="icon">⎋</span>
            <span className="label">Déconnexion</span>
          </button>
        </div>
      
      {overlayVisible && (
        <div
          className="appstore-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(2px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={(e) => {
            // fermer uniquement si on clique sur l'arrière-plan (pas à l'intérieur de la modale)
            if (e.target === e.currentTarget) {
              setOverlayVisible(false);
            }
          }}
        >
          <div
            style={{
              width: '92vw',
              height: '86vh',
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
              overflow: 'hidden',
              position: 'relative'
            }}
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
                onClick={() => setOverlayVisible(false)}
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
              title="App Store"
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
