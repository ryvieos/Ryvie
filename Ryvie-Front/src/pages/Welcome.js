import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios'; // Centralized axios instance with interceptors
import '../styles/Welcome.css';
import serverIcon from '../icons/lettre-r.png';
import { setAccessMode as setGlobalAccessMode, getCurrentAccessMode } from '../utils/detectAccessMode';
import { getCurrentUser, getCurrentUserRole, setCurrentUserName, initializeSession, isSessionActive, startSession } from '../utils/sessionManager';

const Welcome = () => {
  const navigate = useNavigate();
  const [unlocked, setUnlocked] = useState(false);
  const [serverIP, setServerIP] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentAccessMode, setCurrentAccessMode] = useState(null);

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
      
      // Rediriger vers /home si déjà connecté
      if (isSessionActive()) {
        navigate('/home', { replace: true });
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
        const response = await axios.get('http://ryvie.local:3002/api/server-status');
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

  const handlePrivateAccess = () => {
    // Centralized access mode
    setGlobalAccessMode('private');
    
    // Update the session partition without creating a new window
    if (window.electronAPI && currentUser) {
      // Récupérer le rôle de l'utilisateur via session manager
      const userRole = getCurrentUserRole() || 'User';
      
      // Get the current session's cookies and update the partition
      window.electronAPI.invoke('update-session-partition', currentUser, 'private', userRole)
        .then(() => {
          console.log(`Session mise à jour pour ${currentUser} en mode privé avec le rôle ${userRole}`);
        })
        .catch(err => {
          console.error('Erreur lors de la mise à jour de la session:', err);
        });
    }
    
    setUnlocked(true);
    setTimeout(() => {
      if (isSessionActive()) {
        navigate('/home');
      } else {
        navigate('/login');
      }
    }, 10);
  };
  
  const handlePublicAccess = () => {
    // Centralized access mode
    setGlobalAccessMode('public');
    

    // Update the session partition without creating a new window
    if (window.electronAPI && currentUser) {
      // Récupérer le rôle de l'utilisateur via session manager
      const userRole = getCurrentUserRole() || 'User';
      
      // Get the current session's cookies and update the partition
      window.electronAPI.invoke('update-session-partition', currentUser, 'public', userRole)
        .then(() => {
          console.log(`Session mise à jour pour ${currentUser} en mode public avec le rôle ${userRole}`);
        })
        .catch(err => {
          console.error('Erreur lors de la mise à jour de la session:', err);
        });
    }
    
    setUnlocked(true);
    setTimeout(() => {
      navigate('/home');
    }, 10);
  };
  
  return (
    <div className="welcome-body">
      <div className="welcome-overlay">
        <div className="welcome-text-container">
          <h1>Bonjour {currentUser} !</h1>
        </div>
        <div className={`welcome-container ${unlocked ? 'welcome-hidden' : ''}`}>
          {loading && !serverIP ? (
            <>
              <div className="welcome-loading-container">
                <div className="welcome-loading"></div>
              </div>
              <div className="welcome-research-server">
                <p aria-live="polite">Recherche d'un serveur Ryvie en cours...</p>
              </div>
            </>
          ) : serverIP ? (
            <div className="welcome-server-found">
              <img src={serverIcon} alt="Icône de serveur Ryvie" className="welcome-server-icon" />
              <div className="welcome-server-info">
                <p className="welcome-server-text">Connexion Ryvie établie</p>
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
              aria-label={serverIP ? 'Accès depuis la maison' : 'En attente de connexion...'}
            >
              <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 12L5 10M5 10L12 3L19 10M5 10V20C5 20.5523 5.44772 21 6 21H9M19 10L21 12M19 10V20C19 20.5523 18.5523 21 18 21H15M9 21C9.55228 21 10 20.5523 10 20V16C10 15.4477 10.4477 15 11 15H13C13.5523 15 14 15.4477 14 16V20C14 20.5523 14.4477 21 15 21M9 21H15" 
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div className="button-content">
                <span>Réseau Local</span>
                <span className="button-subtitle">Accès depuis la maison</span>
              </div>
            </button>
          ) : currentAccessMode === 'public' ? (
            <button
              className="welcome-button network-button"
              onClick={handlePublicAccess}
              aria-label="Accès distant"
            >
              <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" 
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3.6 9H20.4M3.6 15H20.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M12 3C14.5013 3 16.5313 7.02944 16.5313 12C16.5313 16.9706 14.5013 21 12 21C9.49874 21 7.46875 16.9706 7.46875 12C7.46875 7.02944 9.49874 3 12 3Z" 
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div className="button-content">
                <span>Réseau Externe</span>
                <span className="button-subtitle">Accès depuis l'extérieur</span>
              </div>
            </button>
          ) : (
            // Si aucun mode n'est défini, afficher les deux boutons
            <>
              <button
                className="welcome-button network-button"
                onClick={handlePrivateAccess}
                disabled={!serverIP}
                aria-label={serverIP ? 'Accès depuis la maison' : 'En attente de connexion...'}
              >
                <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3 12L5 10M5 10L12 3L19 10M5 10V20C5 20.5523 5.44772 21 6 21H9M19 10L21 12M19 10V20C19 20.5523 18.5523 21 18 21H15M9 21C9.55228 21 10 20.5523 10 20V16C10 15.4477 10.4477 15 11 15H13C13.5523 15 14 15.4477 14 16V20C14 20.5523 14.4477 21 15 21M9 21H15" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="button-content">
                  <span>Réseau Local</span>
                  <span className="button-subtitle">Accès depuis la maison</span>
                </div>
              </button>
              <button
                className="welcome-button network-button"
                onClick={handlePublicAccess}
                aria-label="Accès distant"
              >
                <svg className="button-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3.6 9H20.4M3.6 15H20.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M12 3C14.5013 3 16.5313 7.02944 16.5313 12C16.5313 16.9706 14.5013 21 12 21C9.49874 21 7.46875 16.9706 7.46875 12C7.46875 7.02944 9.49874 3 12 3Z" 
                    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="button-content">
                  <span>Réseau Externe</span>
                  <span className="button-subtitle">Accès depuis l'extérieur</span>
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