import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios'; // Centralized axios instance with interceptors
import '../styles/Welcome.css';
import serverIcon from '../icons/icon.png';
import { setAccessMode as setGlobalAccessMode, getCurrentAccessMode } from '../utils/detectAccessMode';
import { getCurrentUser, getCurrentUserRole, setCurrentUserName, initializeSession, isSessionActive, startSession } from '../utils/sessionManager';
import { generateAppConfigFromManifests } from '../config/appConfig';
import { StorageManager } from '../utils/platformUtils';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { useLanguage } from '../contexts/LanguageContext';

const Welcome = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [unlocked, setUnlocked] = useState(false);
  const [serverIP, setServerIP] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentAccessMode, setCurrentAccessMode] = useState(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const [preloadStatus, setPreloadStatus] = useState('');

  // Restaurer la session depuis les paramètres URL si preserve_session=true
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const preserveSession = urlParams.get('preserve_session');
    const user = urlParams.get('user');
    const role = urlParams.get('role');
    const token = urlParams.get('token');
    const targetMode = urlParams.get('mode');
    
    // Forcer le mode d'accès si spécifié
    if (targetMode) {
      console.log(`[Welcome] Application du mode forcé: ${targetMode}`);
      setGlobalAccessMode(targetMode);
    }
    
    if (preserveSession === 'true' && user && token) {
      console.log(`[Welcome] Restauration de la session pour: ${user}`);
      
      // Restaurer la session
      startSession({
        token: token,
        userId: user,
        userName: user,
        userRole: role || 'User',
        userEmail: ''
      });
      
      setCurrentUser(user);
      
      // Nettoyer les paramètres URL
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Rediriger vers /home si déjà connecté (avec préchargement)
      if (isSessionActive()) {
        const mode = targetMode || getCurrentAccessMode() || 'private';
        preloadHomeData(mode).then(() => {
          navigate('/home', { replace: true });
        });
      }
    }
  }, [navigate]);

  // Initialize session headers and receive user ID from Electron main process
  useEffect(() => {
    // Ensure axios has auth header if a token exists
    initializeSession();

    // Check if electronAPI is available
    if (window.electronAPI && window.electronAPI.onSetCurrentUser) {
      // Add event listener for 'set-current-user'
      const handleSetCurrentUser = (_, userId) => {
        console.log('User ID received from main process:', userId);
        setCurrentUser(userId);
        // Update centralized session user name
        setCurrentUserName(userId);
      };
      
      window.electronAPI.onSetCurrentUser(handleSetCurrentUser);
      
      // In Electron, we typically can't remove IPC listeners the same way
      // The component will be unmounted and garbage collected
      return () => {};
    }
  }, []);

  // Retrieve the current user from session manager
  useEffect(() => {
    const user = getCurrentUser();
    if (user) setCurrentUser(user);
  }, []);

  useEffect(() => {
    // Sync current user at mount
    const user = getCurrentUser();
    if (user) setCurrentUser(user);
    
    // Récupérer le mode d'accès actuel
    const mode = getCurrentAccessMode();
    setCurrentAccessMode(mode);
  }, []);

  useEffect(() => {
    console.log('Recherche d\'un serveur Ryvie...');

    // Fonction de rappel pour traiter les IP reçues
    const handleServerIP = (_, data) => {
      console.log(`IP reçue dans React : ${data.ip}`);
      setServerIP(data.ip);
      setLoading(false);
    };

    // Vérifier si l'API Electron est disponible
    if (window.electronAPI && window.electronAPI.onRyvieIP) {
      // Ajouter le gestionnaire d'événements pour 'ryvie-ip'
      window.electronAPI.onRyvieIP(handleServerIP);

      // Demander l'IP initiale du serveur (au cas où elle a été détectée avant le chargement de ce composant)
      const checkInitialIP = async () => {
        try {
          const ip = await window.electronAPI.requestInitialServerIP();
          if (ip) {
            console.log(`IP initiale récupérée : ${ip}`);
            setServerIP(ip);
            setLoading(false);
          } else {
            // Si aucune IP n'est encore disponible, réessayer après un délai
            console.log('Aucune IP initiale disponible, nouvelle tentative dans 1 seconde...');
            setTimeout(checkInitialIP, 1000);
          }
        } catch (err) {
          console.error('Erreur lors de la récupération de l\'IP initiale:', err);
        }
      };
      
      // Lancer la vérification initiale avec des tentatives répétées
      checkInitialIP();

      // Nettoyage de l'effet
      return () => {
        // In Electron, we typically can't remove IPC listeners the same way
        // The component will be unmounted and garbage collected
      };
    } else {
      // Si l'API n'est pas disponible, simuler un serveur trouvé pour le développement web
      console.log('Mode développement web - API Electron non disponible');
      setServerIP('ryvie.local');
      setLoading(false);
    }

    // Add a delay to the server detection to make it more visible
    const checkServer = async () => {
      try {
        const serverUrl = getServerUrl('private'); // Utiliser la fonction centralisée
        const response = await axios.get(`${serverUrl}/api/server-status`);
        if (response.data.status === 'online') {
          // Add a deliberate delay to show the loading animation
          setTimeout(() => {
            setServerIP('ryvie.local');
            setLoading(false);
          }, 2000); // 2-second delay to make the server detection more visible
        }
      } catch (error) {
        console.error('Erreur lors de la vérification du serveur:', error);
      }
    };

    // Optimize initial loading
    const preloadAssets = () => {
      // Create a hidden image element to preload the server icon
      const img = new Image();
      img.src = serverIcon;
    };
    
    preloadAssets();
    checkServer();
    
    // Longer timeout for server detection to ensure users see the loading animation
    const timeout = setTimeout(() => {
      setLoading(false);
    }, 8000); // Increased from 5000ms to 8000ms
    
    return () => {
      clearTimeout(timeout);
    };
  }, []);

  const handlePrivateAccess = async () => {
    setIsPreloading(true);
    setUnlocked(true);
    
    // Centralized access mode
    setGlobalAccessMode('private');
    setPreloadStatus(t('welcome.loading'));
    
    // Update the session partition without creating a new window
    if (window.electronAPI && currentUser) {
      const userRole = getCurrentUserRole() || 'User';
      await window.electronAPI.invoke('update-session-partition', currentUser, 'private', userRole)
        .then(() => {
          console.log(`Session mise à jour pour ${currentUser} en mode privé avec le rôle ${userRole}`);
        })
        .catch(err => {
          console.error('Erreur lors de la mise à jour de la session:', err);
        });
    }
    
    // Précharger les données avant de naviguer
    await preloadHomeData('private');
    
    // Navigation fluide
    if (isSessionActive()) {
      navigate('/home');
    } else {
      navigate('/login');
    }
  };
  
  // Fonction de préchargement pour optimiser le premier chargement de Home
  const preloadHomeData = async (accessMode) => {
    try {
      console.log('[Welcome] 🚀 Préchargement des données pour Home...');
      const serverUrl = getServerUrl(accessMode);
      const user = getCurrentUser();
      
      setPreloadStatus(t('welcome.loading'));
      
      // 1. Précharger appsConfig et icônes
      try {
        const config = await generateAppConfigFromManifests(accessMode);
        if (Object.keys(config).length > 0) {
          StorageManager.setItem('appsConfig_cache', config);
          console.log('[Welcome] ✅ appsConfig préchargé:', Object.keys(config).length, 'apps');
          
          // Extraire et précharger réellement les icônes
          const iconImages = {};
          const iconPromises = [];
          
          Object.keys(config).forEach(iconId => {
            if (config[iconId].icon) {
              iconImages[iconId] = config[iconId].icon;
              
              // Précharger l'image pour éviter les carrés blancs
              const img = new Image();
              const promise = new Promise((resolve) => {
                img.onload = () => {
                  console.log(`[Welcome] ✅ Icône chargée: ${iconId}`);
                  resolve();
                };
                img.onerror = () => {
                  console.warn(`[Welcome] ⚠️ Erreur chargement icône: ${iconId}`);
                  resolve(); // Continue même en cas d'erreur
                };
                img.src = config[iconId].icon;
              });
              iconPromises.push(promise);
            }
          });
          
          // Attendre que toutes les icônes soient chargées
          setPreloadStatus(t('welcome.loading'));
          await Promise.all(iconPromises);
          
          StorageManager.setItem('iconImages_cache', iconImages);
          console.log('[Welcome] ✅ Toutes les icônes préchargées:', Object.keys(iconImages).length);
        }
      } catch (e) {
        console.warn('[Welcome] ⚠️ Erreur préchargement appsConfig:', e.message);
      }
      
      // 2. Vérifier la connectivité serveur (pour badge Connecté/Déconnecté)
      setPreloadStatus(t('welcome.loading'));
      try {
        const statusResponse = await axios.get(`${serverUrl}/api/apps/manifests`, { timeout: 3000 });
        if (statusResponse.status === 200) {
          StorageManager.setItem('server_status_cache', { 
            connected: true, 
            timestamp: Date.now() 
          });
          console.log('[Welcome] ✅ Serveur accessible (Connecté)');
        }
      } catch (e) {
        StorageManager.setItem('server_status_cache', { 
          connected: false, 
          timestamp: Date.now() 
        });
        console.warn('[Welcome] ⚠️ Serveur non accessible (Déconnecté)');
      }
      
      // 3. Précharger les préférences utilisateur (layout, anchors, widgets, etc.)
      if (user) {
        setPreloadStatus(t('welcome.preloading'));
        try {
          const res = await axios.get(`${serverUrl}/api/user/preferences`);
          
          // Sauvegarder le launcher dans le cache
          if (res.data?.launcher) {
            localStorage.setItem(`launcher_${user}`, JSON.stringify(res.data.launcher));
            console.log('[Welcome] ✅ Launcher préchargé');
          }
          
          // Sauvegarder et précharger le fond d'écran
          if (res.data?.backgroundImage) {
            localStorage.setItem(`ryvie_bg_${user}`, res.data.backgroundImage);
            
            // Précharger l'image de fond
            const bgImg = new Image();
            await new Promise((resolve) => {
              bgImg.onload = () => {
                console.log('[Welcome] ✅ Fond d\'écran préchargé');
                resolve();
              };
              bgImg.onerror = () => resolve();
              bgImg.src = res.data.backgroundImage;
            });
          }
          
          console.log('[Welcome] ✅ Préférences préchargées');
        } catch (e) {
          console.warn('[Welcome] ⚠️ Erreur préchargement préférences:', e.message);
        }
      }
      
      console.log('[Welcome] 🎉 Préchargement terminé');
    } catch (error) {
      console.error('[Welcome] ❌ Erreur lors du préchargement:', error);
    }
  };

  const handlePublicAccess = async () => {
    setIsPreloading(true);
    setUnlocked(true);
    
    // Centralized access mode
    setGlobalAccessMode('remote');
    setPreloadStatus(t('welcome.loading'));
    
    // Update the session partition without creating a new window
    if (window.electronAPI && currentUser) {
      const userRole = getCurrentUserRole() || 'User';
      await window.electronAPI.invoke('update-session-partition', currentUser, 'remote', userRole)
        .then(() => {
          console.log(`Session mise à jour pour ${currentUser} en mode remote avec le rôle ${userRole}`);
        })
        .catch(err => {
          console.error('Erreur lors de la mise à jour de la session:', err);
        });
    }
    
    // Précharger les données avant de naviguer
    await preloadHomeData('remote');
    
    // Navigation fluide
    navigate('/home');
  };
  
  return (
    <div className={`welcome-body ${isPreloading ? 'preloading' : ''}`}>
      <div className={`welcome-overlay ${isPreloading ? 'preloading' : ''}`}>
        <div className="welcome-text-container">
          <h1>{t('welcome.title')} {currentUser} !</h1>
        </div>
        {isPreloading && (
          <div className="preload-spinner-overlay">
            <div className="preload-spinner"></div>
            <p className="preload-status">{preloadStatus || t('welcome.preloading')}</p>
          </div>
        )}
        <div className={`welcome-container ${unlocked ? 'welcome-hidden' : ''}`}>
          {loading && !serverIP ? (
            <>
              <div className="welcome-loading-container">
                <div className="welcome-loading"></div>
              </div>
              <div className="welcome-research-server">
                <p aria-live="polite">{t('welcome.loading')}</p>
              </div>
            </>
          ) : serverIP ? (
            <div className="welcome-server-found">
              <img src={serverIcon} alt="Icône de serveur Ryvie" className="welcome-server-icon" />
              <div className="welcome-server-info">
                <p className="welcome-server-text">{t('welcome.ready')}</p>
                <p className="welcome-server-ip">{serverIP}</p>
              </div>
            </div>
          ) : (
            <div className="welcome-research-server">
              <p>Aucun serveur détecté pour le moment.</p>
            </div>
          )}
        </div>
        <div className="welcome-buttons-container">
          {/* Afficher uniquement le bouton correspondant au mode actuel */}
          {currentAccessMode === 'private' ? (
            <button
              className="welcome-button network-button"
              onClick={handlePrivateAccess}
              disabled={!serverIP}
              aria-label={serverIP ? t('welcome.localNetworkSubtitle') : 'En attente de connexion...'}
            >
              <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 12L5 10M5 10L12 3L19 10M5 10V20C5 20.5523 5.44772 21 6 21H9M19 10L21 12M19 10V20C19 20.5523 18.5523 21 18 21H15M9 21C9.55228 21 10 20.5523 10 20V16C10 15.4477 10.4477 15 11 15H13C13.5523 15 14 15.4477 14 16V20C14 20.5523 14.4477 21 15 21M9 21H15" 
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div className="button-content">
                <span>{t('welcome.localNetwork')}</span>
                <span className="button-subtitle">{t('welcome.localNetworkSubtitle')}</span>
              </div>
            </button>
          ) : currentAccessMode === 'remote' ? (
            <button
              className="welcome-button network-button"
              onClick={handlePublicAccess}
              aria-label={t('welcome.remoteNetworkSubtitle')}
            >
              <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" 
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3.6 9H20.4M3.6 15H20.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 3C14.5013 3 16.5313 7.02944 16.5313 12C16.5313 16.9706 14.5013 21 12 21C9.49874 21 7.46875 16.9706 7.46875 12C7.46875 7.02944 9.49874 3 12 3Z" 
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div className="button-content">
                <span>{t('welcome.remoteNetwork')}</span>
                <span className="button-subtitle">{t('welcome.remoteNetworkSubtitle')}</span>
              </div>
            </button>
          ) : (
            // Si aucun mode n'est défini, afficher les deux boutons
            <>
              <button
                className="welcome-button network-button"
                onClick={handlePrivateAccess}
                disabled={!serverIP}
                aria-label={serverIP ? t('welcome.localNetworkSubtitle') : 'En attente de connexion...'}
              >
                <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3 12L5 10M5 10L12 3L19 10M5 10V20C5 20.5523 5.44772 21 6 21H9M19 10L21 12M19 10V20C19 20.5523 18.5523 21 18 21H15M9 21C9.55228 21 10 20.5523 10 20V16C10 15.4477 10.4477 15 11 15H13C13.5523 15 14 15.4477 14 16V20C14 20.5523 14.4477 21 15 21M9 21H15" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="button-content">
                  <span>{t('welcome.localNetwork')}</span>
                  <span className="button-subtitle">{t('welcome.localNetworkSubtitle')}</span>
                </div>
              </button>
              <button
                className="welcome-button network-button"
                onClick={handlePublicAccess}
                aria-label={t('welcome.remoteNetworkSubtitle')}
              >
                <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3.6 9H20.4M3.6 15H20.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M12 3C14.5013 3 16.5313 7.02944 16.5313 12C16.5313 16.9706 14.5013 21 12 21C9.49874 21 7.46875 16.9706 7.46875 12C7.46875 7.02944 9.49874 3 12 3Z" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="button-content">
                  <span>{t('welcome.remoteNetwork')}</span>
                  <span className="button-subtitle">{t('welcome.remoteNetworkSubtitle')}</span>
                </div>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
  
} 
export default Welcome;