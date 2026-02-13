import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/connexion.css';
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { isElectron, WindowManager } from '../utils/platformUtils';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { startSession, endSession, getCurrentUser, getCurrentUserRole, getSessionInfo } from '../utils/sessionManager';
import { useLanguage } from '../contexts/LanguageContext';

const Userlogin = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info'); // 'info', 'success', 'error'
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
        setError(t('connexion.initializationError'));
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
            email: user.email || t('connexion.notDefined'),
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
          setError(t('connexion.cannotConnectLocal'));
          setLoading(false);
          return;
        }
        
        setError(t('connexion.errorLoadingUsers'));
        setLoading(false);
      }
    };

    initializeApp();
  }, []);

  const selectUser = (userId, userName) => {
    const userObj = users.find(user => user.id === userId);

    // Si c'est l'utilisateur courant, fermer l'overlay
    if (userObj && isCurrentSessionUser(userObj)) {
      // Fermer l'overlay si on est dans un iframe
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'CLOSE_OVERLAY' }, '*');
      } else {
        navigate('/welcome');
      }
      return;
    }

    // Utilisateur différent → logout + redirect vers SSO Keycloak avec login_hint
    const serverUrl = getServerUrl(accessMode);
    console.log(`[Connexion] Switch vers ${userName} via SSO Keycloak`);
    endSession();
    // Rediriger la fenêtre parente (ou la fenêtre courante) vers le SSO
    const targetWindow = (window.parent !== window) ? window.parent : window;
    targetWindow.location.href = `${serverUrl}/api/auth/switch?login_hint=${encodeURIComponent(userId)}`;
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
      setMessage(t('connexion.pleaseEnterPassword'));
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
        
        setMessage(t('connexion.authenticationSuccess'));
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
        setMessage(t('connexion.authenticationFailed'));
        setMessageType('error');
      }
    } catch (error) {
      console.error('Erreur d\'authentification:', error);
      setLoginAttempts(prev => {
        const newAttempts = prev + 1;
        
        // Close modal and show blocking message after 5 attempts
        if (newAttempts >= 5) {
          setShowPasswordModal(false);
          setMessage(t('connexion.tooManyAttempts'));
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
            setMessage(t('connexion.incorrectCredentials', { remaining }));
          } else {
            setMessage(t('connexion.userBlocked'));
          }
        } else if (error.response.status === 429) {
          const retryAfter = error.response.data?.retryAfter || 900;
          setMessage(t('connexion.retryAfter', { minutes: Math.ceil(retryAfter / 60) }));
          setShowPasswordModal(false);
        } else {
          setMessage(t('connexion.authError', { error: error.response.data?.error || t('connexion.serverError') }));
        }
      } else if (error.request) {
        // La requête a été faite mais pas de réponse
        setMessage(t('connexion.cannotContactServer'));
      } else {
        // Erreur lors de la configuration de la requête
        setMessage(t('connexion.error', { message: error.message }));
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
        setMessage(t('connexion.windowOpened', { userName, accessMode, userRole }));
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
          setMessage(t('connexion.loginSuccess', { userName }));
          setMessageType('success');
          
          setTimeout(() => {
            window.parent.postMessage({ type: 'CLOSE_OVERLAY_AND_NAVIGATE', path: '/welcome' }, '*');
          }, 500);
        } else {
          // Navigation normale
          console.log(`[Connexion] Mode web - redirection vers l'accueil pour ${userName}`);
          navigate('/welcome');
          setMessage(t('connexion.loginSuccess', { userName }));
          setMessageType('success');
        }
      }
    } catch (error) {
      console.error('Erreur lors de l\'ouverture de la fenêtre:', error);
      setMessage(t('connexion.windowOpenError', { message: error.message }));
      setMessageType('error');
    }
  };

  return (
    <div className="container">
      <div className="login-card">
        <h1 className="title-connexion">{t('connexion.openNewSession')}</h1>
        
        <div className="access-mode-indicator">
          <span className={`mode-badge ${accessMode}`}>
            {t('connexion.mode')}: {accessMode === 'private' ? t('connexion.local') : t('connexion.remote')}
          </span>
          {!isElectron() && (
            <span className="platform-badge">{t('connexion.web')}</span>
          )}
        </div>
        
        {(loading || detectingMode) ? (
          <div className="user-buttons-container loading-state">
            <div className="inline-loading">
              <div className="spinner"></div>
              <p className="loading-text">
                {detectingMode ? t('connexion.detectingAccessMode') : t('connexion.loadingUsers')}
              </p>
              {!isElectron() && detectingMode && (
                <p className="loading-subtext">{t('connexion.testingConnectivity')}</p>
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
          {t('connexion.backToHome')}
        </button>
      </div>

      {showPasswordModal && (
        <div className="modal-overlay" onClick={() => !authenticating && setShowPasswordModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">{t('connexion.authentication')}</h2>
            <div className="user-info">
              <div className={`modal-user-avatar ${selectedUser.id === 'jules' ? 'primary-user-avatar' : ''}`}>
                {selectedUser.name.charAt(0).toUpperCase()}
              </div>
              <div className="modal-user-name">{selectedUser.name}</div>
            </div>
            
            <p className="modal-text">{t('connexion.enterPassword')}</p>
            
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="password-input"
              placeholder={t('connexion.password')}
              onKeyPress={(e) => e.key === 'Enter' && authenticateUser()}
              autoFocus
            />
            
            {loginAttempts > 0 && (
              <p className="attempt-warning">
                {loginAttempts === 1 ? t('connexion.firstAttemptFailed') : 
                 loginAttempts === 2 ? t('connexion.secondAttemptFailed') : 
                 t('connexion.multipleAttemptsFailed')}
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
                {t('connexion.cancel')}
              </button>
              <button 
                onClick={authenticateUser}
                className="login-button"
                disabled={authenticating || !password}
              >
                {authenticating ? (
                  <div className="button-spinner"></div>
                ) : t('connexion.connect')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Userlogin;
