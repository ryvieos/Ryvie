import React, { useState, useEffect } from 'react';
import './styles/Home.css';
import './styles/Transitions.css';
import axios from 'axios';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { io } from 'socket.io-client';
import { Link, useNavigate } from 'react-router-dom';
import { getCurrentAccessMode } from './utils/detectAccessMode';
import { isElectron, WindowManager, StorageManager, NotificationManager } from './utils/platformUtils';
import { endSession } from './utils/sessionManager';
const { getServerUrl, getAppUrl } = require('./config/urls');
import { generateAppConfig, generateDefaultZones, images } from './config/appConfig';

// Fonction pour importer toutes les images du dossier weather_icons
function importAll(r) {
  let images = {};
  r.keys().forEach((item) => {
    images[item.replace('./', '')] = r(item);
  });
  return images;
}
localStorage.removeItem('iconZones');
// Importer les icônes météo
const weatherImages = importAll(require.context('./weather_icons', false, /\.(png|jpe?g|svg)$/));
const weatherIcons = importAll(require.context('./weather_icons', false, /\.(png|jpe?g|svg)$/));

// Configuration dynamique des applications
const APPS_CONFIG = generateAppConfig();

// Types pour react-dnd
const ItemTypes = {
  ICON: 'icon',
};

// Composant pour chaque icône
const Icon = ({ id, src, zoneId, moveIcon, handleClick, showName = true, isActive, isSpinning }) => {
  const ref = React.useRef(null);
  const appConfig = APPS_CONFIG[id] || {};

  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.ICON,
    item: { id, zoneId },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  drag(ref);

  return (
    <div className="icon-container">
      <div
        ref={ref}
        className="icon"
        style={{
          backgroundImage: `url(${src})`,
          opacity: isDragging ? 0.5 : 1,
          cursor: 'pointer',
          position: 'relative',
        }}
        onClick={() => handleClick(id)}
      >
        {appConfig.showStatus && (
          <div
            className="status-badge"
            style={{
              position: 'absolute',
              top: '-5px',
              right: '-5px',
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              backgroundColor: isActive ? 'green' : 'red',
              border: '2px solid white',
            }}
          ></div>
        )}
        {isSpinning && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.15)'
            }}
          >
            <div className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }}></div>
          </div>
        )}
      </div>
      {showName && <p className="icon-name">{appConfig.name || id.replace('.jpeg', '').replace('.png', '').replace('.svg', '')}</p>}
    </div>
  );
};

// Composant Zone
const Zone = ({ zoneId, iconId, moveIcon, handleClick, showName, appStatus, appSpinners }) => {
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

  return (
    <div ref={drop} className={`zone ${isActive ? 'zone-active' : ''}`}>
      <div className="icon-container">
        {iconId.length > 0 && (
          <Icon
            id={iconId[0]}
            src={images[iconId[0]]}
            zoneId={zoneId}
            moveIcon={moveIcon}
            handleClick={handleClick}
            showName={showName}
            isActive={appStatus[iconId[0]]}
            isSpinning={appSpinners[iconId[0]]}
          />
        )}
      </div>
    </div>
  );
};

// Composant Taskbar
const Taskbar = ({ handleClick }) => {
  // Filtrer les icônes de la barre des tâches à partir de la configuration
  const taskbarApps = Object.entries(APPS_CONFIG)
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
  const [zones, setZones] = useState(() => {
    // Essayer de récupérer les zones depuis StorageManager
    const savedZones = StorageManager.getItem('iconZones');
    console.log("Zones sauvegardées:", savedZones);
    if (savedZones) {
      try {
        const parsedZones = typeof savedZones === 'string' ? JSON.parse(savedZones) : savedZones;
        console.log("Zones analysées:", parsedZones);
        
        // Migration automatique des anciens noms vers les nouveaux
        let migrationNeeded = false;
        const migrationMap = {
          'AppStore.jpeg': 'app-AppStore.jpeg',
          'Portainer.png': 'app-Portainer.png',
          'rDrive.svg': 'app-rDrive.svg',
          'rPictures.svg': 'app-rPictures.svg',
          'rDrop.png': 'app-rDrop.png',
          'rCloud.png': 'app-rDrive.svg',
          'user.svg': 'task-user.svg',
          'transfer.svg': 'task-transfer.svg',
          'settings.svg': 'task-settings.svg'
        };
        
        Object.keys(parsedZones).forEach(zoneKey => {
          parsedZones[zoneKey] = parsedZones[zoneKey].map(iconId => {
            if (migrationMap[iconId]) {
              console.log(`Migration: ${iconId} -> ${migrationMap[iconId]}`);
              migrationNeeded = true;
              return migrationMap[iconId];
            }
            return iconId;
          });
        });
        
        if (migrationNeeded) {
          console.log("Migration effectuée, sauvegarde des nouvelles zones");
          StorageManager.setItem('iconZones', parsedZones);
        }
        
        return parsedZones;
      } catch (error) {
        console.error('Erreur lors de la récupération des zones:', error);
      }
    }
    
    // Utiliser la génération dynamique des zones par défaut
    return generateDefaultZones();
  });

  const [weather, setWeather] = useState({
    location: 'Loading...',
    temperature: null,
    description: '',
    icon: 'default.png',
  });

  const [serverStatus, setServerStatus] = useState(false);
  const [appStatus, setAppStatus] = useState({});
  const [appSpinners, setAppSpinners] = useState({});
  const [applications, setApplications] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  // Overlay AppStore
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayUrl, setOverlayUrl] = useState('');

  const [mounted, setMounted] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [currentSocket, setCurrentSocket] = useState(null);
  
  useEffect(() => {
    const initializeAccessMode = () => {
      // TOUJOURS utiliser le mode stocké - ne jamais faire de détection automatique
      const mode = getCurrentAccessMode(); // peut être null
      setAccessMode(mode);
      console.log(`[Home] Mode d'accès récupéré depuis le stockage: ${mode}`);
    };

    initializeAccessMode();
  }, []);
  
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
        const response = await axios.get(`${getServerUrl(accessMode)}/api/apps`);
        const apps = response.data.map(app => ({
          ...app,
          port: app.ports && app.ports.length > 0 ? app.ports[0] : null,
          autostart: false
        }));
        setApplications(apps);
        
        // Mettre à jour le statut des applications pour Home.js
        const newAppStatus = {};
        const newAppSpinners = {};
        //console.log('[Home] Applications reçues:', apps.map(app => ({ name: app.name, running: app.running, fullApp: app })));
        //console.log('[Home] APPS_CONFIG disponible:', Object.entries(APPS_CONFIG).map(([id, config]) => ({ id, name: config.name })));
        
        apps.forEach(app => {
          // Trouver la configuration correspondante dans APPS_CONFIG
          const configEntry = Object.entries(APPS_CONFIG).find(([iconId, config]) => {
            const match = config.name.toLowerCase() === app.name.toLowerCase() || 
                         iconId.includes(app.name.toLowerCase());
            //console.log(`[Home] Comparaison: ${app.name} vs ${config.name} (${iconId}) = ${match}`);
            return match;
          });
          
          if (configEntry) {
            const [iconId] = configEntry;
            //console.log(`[Home] Mapping trouvé: ${app.name} (status: ${app.status}) -> ${iconId}`);
            newAppStatus[iconId] = (app.status === 'running' && app.progress > 0);
            newAppSpinners[iconId] = !!(app.starting || app.stopping);
          } else {
           // console.log(`[Home] Aucun mapping trouvé pour: ${app.name}`);
          }
        });
        
        console.log('[Home] Nouveau statut calculé:', newAppStatus);
        setAppStatus(newAppStatus);
        setAppSpinners(newAppSpinners);
        
      } catch (error) {
        console.error('[Home] Erreur lors de la récupération des applications:', error);
      }
    };

    // Récupérer les applications au chargement
    fetchApplications();
    
    const connectSocket = () => {
      try {
        if (currentSocket) {
          currentSocket.disconnect();
        }
        
        console.log(`[Home] Tentative de connexion Socket.io vers: ${serverUrl}`);
        
        const newSocket = io(serverUrl, {
          transports: ['websocket', 'polling'],
          timeout: 10000,
          forceNew: true
        });

        newSocket.on('connect', () => {
          console.log(`[Home] Socket.io connecté en mode ${accessMode}`);
          setCurrentSocket(newSocket);
          setSocketConnected(true);
          setServerStatus(true); // Marquer le serveur comme connecté
        });

        newSocket.on('disconnect', () => {
          console.log('[Home] Socket.io déconnecté');
          setSocketConnected(false);
          setServerStatus(false); // Marquer le serveur comme déconnecté
        });

        newSocket.on('connect_error', (error) => {
          console.log(`[Home] Erreur de connexion Socket.io en mode ${accessMode}:`, error.message);
          setSocketConnected(false);
          setServerStatus(false); // Marquer le serveur comme déconnecté en cas d'erreur
          
          // En mode web, ne jamais essayer le fallback
          if (!isElectron()) {
            console.log('[Home] Mode web - arrêt des tentatives de connexion Socket.io');
            if (newSocket) {
              newSocket.disconnect();
            }
            return;
          }
          
          // Ne jamais changer de mode automatiquement - respecter le mode établi
          console.log('[Home] Connexion Socket.io échouée - mode d\'accès maintenu:', accessMode);
        });

        newSocket.on('server-status', (data) => {
          console.log('[Home] Statut serveur reçu:', data.status);
          setServerStatus(data.status);
        });

        // Écouter les mises à jour des statuts d'applications (comme dans Settings.js)
        newSocket.on('apps-status-update', (updatedApps) => {
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

          // Mettre à jour le statut des applications pour Home.js
          const newAppStatus = {};
          const newAppSpinners = {};
          console.log('[Home] Mise à jour apps reçues:', updatedApps.map(app => ({ name: app.name, running: app.running })));
          
          updatedApps.forEach(app => {
            // Trouver la configuration correspondante dans APPS_CONFIG
            const configEntry = Object.entries(APPS_CONFIG).find(([iconId, config]) => {
              const match = config.name.toLowerCase() === app.name.toLowerCase() || 
                           iconId.includes(app.name.toLowerCase());
              console.log(`[Home] Mise à jour - Comparaison: ${app.name} vs ${config.name} (${iconId}) = ${match}`);
              return match;
            });
            
            if (configEntry) {
              const [iconId] = configEntry;
              console.log(`[Home] Mise à jour - Mapping trouvé: ${app.name} (status: ${app.status}) -> ${iconId}`);
              newAppStatus[iconId] = (app.status === 'running' && app.progress > 0);
              newAppSpinners[iconId] = !!(app.starting || app.stopping);
            } else {
              console.log(`[Home] Mise à jour - Aucun mapping trouvé pour: ${app.name}`);
            }
          });
          
          console.log('[Home] Mise à jour - Nouveau statut calculé:', newAppStatus);
          setAppStatus(newAppStatus);
          setAppSpinners(newAppSpinners);
        });
        
      } catch (error) {
        console.error('[Home] Erreur lors de la création de la connexion Socket.io:', error);
      }
    };
    
    connectSocket();
    
    return () => {
      if (currentSocket) {
        currentSocket.disconnect();
      }
    };
  }, [accessMode]);
  
  useEffect(() => {
    const fetchWeatherData = async () => {
      try {
        // 1) Essayer d'abord la géolocalisation du navigateur (position réelle de l'utilisateur)
        const getPosition = () =>
          new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('Geolocation non disponible'));
            navigator.geolocation.getCurrentPosition(
              (pos) => resolve(pos),
              (err) => reject(err),
              { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 }
            );
          });

        let latitude = null;
        let longitude = null;
        let cityName = null;

        try {
          const pos = await getPosition();
          latitude = pos.coords.latitude;
          longitude = pos.coords.longitude;

          // Reverse geocoding pour obtenir le nom de la ville depuis les coordonnées
          try {
            const reverseUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=fr`;
            const rev = await axios.get(reverseUrl);
            cityName = rev?.data?.city || rev?.data?.locality || rev?.data?.principalSubdivision || 'Votre position';
          } catch (e) {
            cityName = 'Votre position';
          }
        } catch (geoErr) {
          // 2) Repli: géolocalisation par IP (HTTPS)
          try {
            const ipResp = await axios.get('https://ipapi.co/json/');
            latitude = ipResp.data.latitude;
            longitude = ipResp.data.longitude;
            cityName = ipResp.data.city || 'Votre position';
          } catch (ipErr) {
            throw new Error('Impossible de récupérer la localisation');
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
        console.error('Erreur lors de la récupération de la localisation', error);
        setWeather({
          location: 'Localisation non disponible',
          temperature: null,
          humidity: null,
          wind: null,
          description: '',
          icon: 'default.png',
        });
      }
    };

    fetchWeatherData();
    const intervalId = setInterval(fetchWeatherData, 300000);
    return () => clearInterval(intervalId);
  }, []);

  // Supprimer ce useEffect dupliqué car géré dans le premier useEffect

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const moveIcon = (id, fromZoneId, toZoneId) => {
    setZones((prevZones) => {
      const fromIcons = prevZones[fromZoneId].filter((iconId) => iconId !== id);
      let toIcons = prevZones[toZoneId];

      if (!toIcons) toIcons = [];

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
      
      // Sauvegarder les zones dans StorageManager après chaque modification
      StorageManager.setItem('iconZones', newZones);
      
      return newZones;
    });
  };


  const openAppWindow = (url, useOverlay = true, appName = '') => {
    console.log(`[Home] Ouverture de l'application: ${url}`);
    
    const currentUser = StorageManager.getItem('currentUser');
    
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
    
    const appConfig = APPS_CONFIG[iconId];
    
    if (!appConfig) {
      console.log("Pas de configuration trouvée pour cette icône :", iconId);
      console.log("Configuration disponible:", Object.keys(APPS_CONFIG));
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

  return (
    <div className={`home-container ${mounted ? 'slide-enter-active' : 'slide-enter'}`}>
      <DndProvider backend={HTML5Backend}>
        <div className="background">
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

          <Taskbar handleClick={handleClick} />
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
                  appSpinners={appSpinners}
                />
              </div>
              <div className="widget" style={{ backgroundImage: `url(${weatherImages[weather.icon]})` }}>
                <div className="weather-info">
                  <p className="weather-city">{weather.location ? weather.location : 'Localisation non disponible'}</p>
                  <p className="weather-temperature">
                    {weather.temperature ? `${Math.round(weather.temperature)}°C` : '...'}
                  </p>
                  <div className="weather-humidity">
                    <img src={weatherIcons['humidity.png']} alt="Humidity Icon" className="weather-icon" />
                    {weather.humidity ? `${weather.humidity}%` : '...'}
                  </div>
                  <div className="weather-wind">
                    <img src={weatherIcons['wind.png']} alt="Wind Icon" className="weather-icon" />
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
                  appSpinners={appSpinners}
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
                  appSpinners={appSpinners}
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
    </div>
  );
};

export default Home;
