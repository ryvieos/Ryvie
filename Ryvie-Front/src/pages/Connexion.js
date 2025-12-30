import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/connexion.css';
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { isElectron, WindowManager } from '../utils/platformUtils';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { startSession, getCurrentUser, getCurrentUserRole, getSessionInfo } from '../utils/sessionManager';

const Userlogin = () => {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info'); // 'info', 'success', 'error'
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [accessMode, setAccessMode] = useState('private');
  const [selectedUser, setSelectedUser] = useState(null);
  const [password, setPassword] = useState('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [detectingMode, setDetectingMode] = useState(true);
  const currentUser = getCurrentUser();
  const currentUserRole = getCurrentUserRole();

  useEffect(() => {
    const initializeApp = async () => {
      try {
        // Détecter automatiquement le mode d'accès si on est en web
        let detectedMode;
        if (isElectron()) {
          // En Electron, utiliser le mode stocké
          detectedMode = getCurrentAccessMode();
        } else {
          detectedMode = getCurrentAccessMode();
        }
        
        setAccessMode(detectedMode);
        setDetectingMode(false);
        
        // Charger les utilisateurs avec le mode détecté
        await fetchUsers(detectedMode);
      } catch (err) {
        console.error('Erreur lors de l\'initialisation:', err);
        setDetectingMode(false);
        setError('Erreur lors de l\'initialisation de l\'application.');
        setLoading(false);
      }
    };

    const fetchUsers = async (mode) => {
      try {
        const serverUrl = getServerUrl(mode);
        console.log(`[Connexion] Chargement des utilisateurs depuis: ${serverUrl}`);
        
        // Essayer l'endpoint protégé si un token existe (pas seulement Admin). En cas d'échec 401/403, fallback remote.
        const session = getSessionInfo() || {};
        const token = session.token;
        let response;
        if (token) {
          try {
            response = await axios.get(`${serverUrl}/api/users`, {
              timeout: 5000,
              headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
              }
            });
          } catch (e) {
            if (e?.response?.status === 401 || e?.response?.status === 403) {
              console.warn('[Connexion] Accès refusé à /api/users, bascule sur /api/users-remote');
              response = await axios.get(`${serverUrl}/api/users-public`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
              });
            } else {
              throw e;
            }
          }
        } else {
          response = await axios.get(`${serverUrl}/api/users-public`, {
            timeout: 5000,
            headers: { 'Accept': 'application/json' }
          });
        }
        
        const sessionUser = (getCurrentUser() || '').trim().toLowerCase();
        const sessionRole = getCurrentUserRole();
        const ldapUsers = (response.data || []).map(user => {
          const u = {
            name: user.name || user.uid,
            id: user.uid,
            email: user.email || 'Non défini',
            // Préserver le rôle si fourni; sinon, si c'est l'utilisateur courant, afficher son rôle de session
            role: user.role || ''
          };
          const matchById = String(u.id || '').trim().toLowerCase() === sessionUser;
          const matchByName = String(u.name || '').trim().toLowerCase() === sessionUser;
          if (!u.role && (matchById || matchByName) && sessionRole) {
            u.role = sessionRole;
          }
          return u;
        });
        
        setUsers(ldapUsers);
        setLoading(false);
        console.log(`[Connexion] ${ldapUsers.length} utilisateurs chargés`);
      } catch (err) {
        console.error('Erreur lors du chargement des utilisateurs:', err);
        
        // Si on est en web et qu'on a échoué en mode privé, forcer le mode privé (pas de serveur remote pour les tests)
        if (!isElectron() && mode === 'private') {
          console.log('[Connexion] Échec en mode privé, mais on reste en mode privé (pas de serveur remote de test)');
          setError('Impossible de se connecter au serveur local ryvie.local:3002. Vérifiez que le serveur est démarré et accessible.');
          setLoading(false);
          return;
        }
        
        setError('Erreur lors du chargement des utilisateurs. Veuillez vérifier votre connexion au serveur.');
        setLoading(false);
      }
    };

    initializeApp();
  }, []);

  const selectUser = (userId, userName) => {
    const userObj = users.find(user => user.id === userId);
    setSelectedUser(userObj);
    setShowPasswordModal(true);
    setMessage('');
  };

  // Helper: check if a given list user matches the current session user (by id or name)
  const isCurrentSessionUser = (u) => {
    const cu = (getCurrentUser() || '').trim().toLowerCase();
    if (!cu) return false;
    const byId = String(u?.id || '').trim().toLowerCase() === cu;
    const byName = String(u?.name || '').trim().toLowerCase() === cu;
    return byId || byName;
  };

  const authenticateUser = async () => {
    if (!selectedUser || !password) {
      setMessage('Veuillez entrer un mot de passe');
      setMessageType('error');
      return;
    }

    setAuthenticating(true);
    setMessage('');

    try {
      // Utiliser l'URL du serveur en fonction du mode d'accès
      const serverUrl = getServerUrl(accessMode);
      // Ne pas inclure l'ancien token Authorization pour les nouvelles authentifications
      const response = await axios.post(`${serverUrl}/api/authenticate`, {
        uid: selectedUser.id,
        password: password
      }, {
        withCredentials: false,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': undefined
        }
      });

      if (response.data && response.data.token) {
        // Authentification réussie, démarrer une session centralisée
        startSession({
          token: response.data.token,
          userId: selectedUser.id,
          userName: selectedUser.name || selectedUser.id,
          userRole: response.data.user.role || 'User',
          userEmail: response.data.user.email || ''
        });
        
        setMessage('Authentification réussie. Ouverture d\'une nouvelle session...');
        setMessageType('success');
        
        // Fermer le modal
        setShowPasswordModal(false);
        setPassword('');
        setLoginAttempts(0);
        
        // Ouvrir une nouvelle fenêtre pour l'utilisateur en utilisant l'API Electron
        await openUserWindow(
          selectedUser.id, 
          selectedUser.name, 
          response.data.user.role || 'User',
          response.data.token
        );
      } else {
        setLoginAttempts(prev => prev + 1);
        setMessage('Échec de l\'authentification. Réponse du serveur invalide.');
        setMessageType('error');
      }
    } catch (error) {
      console.error('Erreur d\'authentification:', error);
      setLoginAttempts(prev => {
        const newAttempts = prev + 1;
        
        // Close modal and show blocking message after 5 attempts
        if (newAttempts >= 5) {
          setShowPasswordModal(false);
          setMessage('Trop de tentatives échouées pour cet utilisateur. Veuillez réessayer plus tard.');
          setMessageType('error');
          
          // Block this user for 5 minutes (shorter than main login)
          setTimeout(() => {
            setMessage('');
            setLoginAttempts(0);
          }, 5 * 60 * 1000);
        }
        
        return newAttempts;
      });
      
      // Gestion détaillée des erreurs
      if (error.response) {
        // Le serveur a répondu avec un code d'erreur
        if (error.response.status === 401) {
          const remaining = Math.max(0, 5 - (loginAttempts + 1));
          if (remaining > 0) {
            setMessage(`Identifiants incorrects. ${remaining} tentative(s) restante(s).`);
          } else {
            setMessage('Trop de tentatives échouées. Utilisateur temporairement bloqué.');
          }
        } else if (error.response.status === 429) {
          const retryAfter = error.response.data?.retryAfter || 900;
          setMessage(`Trop de tentatives de connexion. Réessayez dans ${Math.ceil(retryAfter / 60)} minutes.`);
          setShowPasswordModal(false);
        } else {
          setMessage(`Erreur d'authentification: ${error.response.data?.error || 'Erreur serveur'}`);
        }
      } else if (error.request) {
        // La requête a été faite mais pas de réponse
        setMessage('Impossible de contacter le serveur. Veuillez vérifier votre connexion.');
      } else {
        // Erreur lors de la configuration de la requête
        setMessage(`Erreur: ${error.message}`);
      }
      
      setMessageType('error');
    } finally {
      setAuthenticating(false);
    }
  };

  const openUserWindow = async (userId, userName, userRole, token) => {
    try {
      console.log(`[Connexion] Ouverture de session pour: ${userName} avec le rôle ${userRole}`);
      
      if (isElectron()) {
        // Mode Electron - Créer une nouvelle fenêtre
        await window.electronAPI.invoke('create-user-window-with-mode', userId, accessMode, userRole, token);
        setMessage(`Fenêtre ouverte pour ${userName} en mode ${accessMode} avec le rôle ${userRole}`);
        setMessageType('success');
        
        // Fermer l'overlay si on est dans un iframe
        if (window.parent !== window) {
          setTimeout(() => {
            window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
          }, 500);
        }
      } else {
        // Mode Web - Vérifier si on est dans un iframe (overlay)
        if (window.parent !== window) {
          // On est dans un overlay, fermer l'overlay et rediriger le parent
          console.log(`[Connexion] Mode web dans overlay - fermeture de l'overlay`);
          setMessage(`Connexion réussie pour ${userName}`);
          setMessageType('success');
          
          setTimeout(() => {
            window.parent.postMessage({ type: 'CLOSE_OVERLAY_AND_NAVIGATE', path: '/welcome' }, '*');
          }, 500);
        } else {
          // Navigation normale
          console.log(`[Connexion] Mode web - redirection vers l'accueil pour ${userName}`);
          navigate('/welcome');
          setMessage(`Connexion réussie pour ${userName}`);
          setMessageType('success');
        }
      }
    } catch (error) {
      console.error('Erreur lors de l\'ouverture de la fenêtre:', error);
      setMessage(`Erreur lors de l'ouverture de la fenêtre: ${error.message}`);
      setMessageType('error');
    }
  };

  return (
    <div className="container">
      <div className="login-card">
        <h1 className="title-connexion">Ouvrir une nouvelle session</h1>
        
        <div className="access-mode-indicator">
          <span className={`mode-badge ${accessMode}`}>
            Mode: {accessMode === 'private' ? 'Local' : 'Remote'}
          </span>
          {!isElectron() && (
            <span className="platform-badge">Web</span>
          )}
        </div>
        
        {(loading || detectingMode) ? (
          <div className="user-buttons-container loading-state">
            <div className="inline-loading">
              <div className="spinner"></div>
              <p className="loading-text">
                {detectingMode ? 'Détection du mode d\'accès...' : 'Chargement des utilisateurs...'}
              </p>
              {!isElectron() && detectingMode && (
                <p className="loading-subtext">Test de connectivité au serveur local...</p>
              )}
            </div>
          </div>
        ) : error ? (
          <div className="user-buttons-container error-state">
            <div className="inline-error">
              <div className="error-icon">⚠️</div>
              <p className="error-text">{error}</p>
              <button 
                className="retry-button"
                onClick={() => window.location.reload()}
              >
                Réessayer
              </button>
            </div>
          </div>
        ) : (
          <div className="user-buttons-container">
            {users.map(user => (
              <button
                key={user.id}
                onClick={() => selectUser(user.id, user.name)}
                className={`user-button ${isCurrentSessionUser(user) ? 'primary-user-button' : ''}`}
              >
                <div className="user-avatar">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div className="user-name">
                  {user.name}
                  <span className="user-role">{user.role || ''}</span>
                </div>
              </button>
            ))}
          </div>
        )}
        
        {message && (
          <div className={`message-container ${messageType === 'error' ? 'error-message' : ''} ${messageType === 'success' ? 'success-message' : ''}`}>
            <p className="message-text">{message}</p>
          </div>
        )}
        
        <button 
          onClick={() => {
            // Si on est dans un iframe (overlay), envoyer un message pour fermer l'overlay
            if (window.parent !== window) {
              window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
            } else {
              // Sinon, navigation normale
              navigate('/home');
            }
          }} 
          className="return-button"
        >
          Retour à l'accueil
        </button>
      </div>

      {showPasswordModal && (
        <div className="modal-overlay" onClick={() => !authenticating && setShowPasswordModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Authentification</h2>
            <div className="user-info">
              <div className={`modal-user-avatar ${selectedUser.id === 'jules' ? 'primary-user-avatar' : ''}`}>
                {selectedUser.name.charAt(0).toUpperCase()}
              </div>
              <div className="modal-user-name">{selectedUser.name}</div>
            </div>
            
            <p className="modal-text">Veuillez entrer votre mot de passe</p>
            
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="password-input"
              placeholder="Mot de passe"
              onKeyPress={(e) => e.key === 'Enter' && authenticateUser()}
              autoFocus
            />
            
            {loginAttempts > 0 && (
              <p className="attempt-warning">
                {loginAttempts === 1 ? 'Première tentative échouée' : 
                 loginAttempts === 2 ? 'Deuxième tentative échouée' : 
                 'Attention: Plusieurs tentatives échouées'}
              </p>
            )}
            
            <div className="modal-buttons">
              <button 
                onClick={() => {
                  setShowPasswordModal(false);
                  setPassword('');
                  setSelectedUser(null);
                  setLoginAttempts(0);
                }}
                className="cancel-button"
                disabled={authenticating}
              >
                Annuler
              </button>
              <button 
                onClick={authenticateUser}
                className="login-button"
                disabled={authenticating || !password}
              >
                {authenticating ? (
                  <div className="button-spinner"></div>
                ) : 'Se connecter'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Userlogin;
