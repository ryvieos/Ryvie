import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/Login.css';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { isSessionActive, startSession } from '../utils/sessionManager';
import { getCurrentAccessMode, detectAccessMode, setAccessMode as persistAccessMode, testServerConnectivity } from '../utils/detectAccessMode';
import { useLanguage } from '../contexts/LanguageContext';

const Login = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info'); // 'info', 'success', 'error'
  const [accessMode, setAccessMode] = useState('private');

  useEffect(() => {
    const initMode = async () => {
      // 1) Respecter un mode déjà établi (Welcome/Settings)
      const existingModeRaw = getCurrentAccessMode();
      if (existingModeRaw) {
        setAccessMode(existingModeRaw);
      } else {
        // 2) Pas de mode encore défini -> déterminer intelligemment
        if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
          // En HTTPS, forcer REMOTE pour éviter tout Mixed Content
          persistAccessMode('remote');
          setAccessMode('remote');
          console.log('[Login] Page HTTPS - accessMode initialisé à REMOTE');
        } else {
          // En HTTP (dev/local) -> tester la connectivité locale rapidement
          try {
            const detected = await detectAccessMode(1500);
            setAccessMode(detected);
            console.log(`[Login] accessMode détecté: ${detected}`);
          } catch {
            // Fallback sécurisé
            persistAccessMode('remote');
            setAccessMode('remote');
            console.log('[Login] Détection échouée - fallback REMOTE');
          }
        }
      }

      // 3) Vérifier si une session est réellement active avant de rediriger
      if (isSessionActive()) {
        navigate('/welcome', { replace: true });
        return;
      }

      // 4) Vérifier si c'est la première connexion
      try {
        const mode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(mode);
        const response = await axios.get(`${serverUrl}/api/ldap/check-first-time`);
        
        if (response.data && response.data.isFirstTime) {
          console.log('[Login] Première connexion détectée - redirection vers FirstTimeSetup');
          navigate('/first-time-setup', { replace: true });
        }
      } catch (error) {
        console.error('[Login] Erreur lors de la vérification de la première connexion:', error);
        // En cas d'erreur, on continue normalement vers la page de login
      }
    };

    initMode();
  }, []);

  // Polling: rester en remote et tenter périodiquement de basculer en privé dès que détecté
  useEffect(() => {
    // Ne pas tenter en HTTPS (évite Mixed Content) et uniquement si on est en REMOTE
    if (typeof window !== 'undefined' && window.location?.protocol === 'https:') return;
    if (accessMode !== 'remote') return;

    let isCancelled = false;

    const attemptDetect = async () => {
      try {
        const detected = await detectAccessMode(1200);
        if (!isCancelled && detected === 'private') {
          persistAccessMode('private');
          setAccessMode('private');
          console.log('[Login] Mode privé détecté pendant le polling -> bascule en PRIVÉ');
        }
      } catch {
        // Reste en remote silencieusement
      }
    };

    // Tentative immédiate puis toutes les 3 secondes
    attemptDetect();
    const intervalId = setInterval(attemptDetect, 3000);

    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, [accessMode]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!username || !password) {
      setMessage(t('login.allFieldsRequired'));
      setMessageType('error');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      // Utiliser l'URL du serveur en fonction du mode d'accès
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/authenticate`, {
        uid: username,
        password: password
      });

      if (response.data && response.data.token) {
        // Démarrer la session via le gestionnaire centralisé
        startSession({
          token: response.data.token,
          userId: response.data.user.uid,
          userName: response.data.user.name || response.data.user.uid,
          userRole: response.data.user.role || 'User',
          userEmail: response.data.user.email || ''
        });

        setMessage(t('login.success'));
        setMessageType('success');
        
        // Rediriger vers la page de bienvenue pour éviter la boucle sur /login
        setTimeout(() => {
          navigate('/welcome');
        }, 300);
      } else {
        setMessage(t('login.serverError'));
        setMessageType('error');
      }
    } catch (error: any) {
      console.error('Erreur d\'authentification:', error);
      
      // Gestion détaillée des erreurs
      if (error.response) {
        // Le serveur a répondu avec un code d'erreur
        if (error.response.status === 401) {
          setMessage(t('login.invalidCredentials'));
        } else if (error.response.status === 429) {
          setMessage(t('login.tooManyAttempts'));
        } else {
          setMessage(`${t('login.authError')}: ${error.response.data?.error || t('login.serverError')}`);
        }
      } else if (error.request) {
        // La requête a été faite mais pas de réponse
        setMessage(t('login.serverUnavailable'));
      } else {
        // Erreur lors de la configuration de la requête
        setMessage(`${t('common.error')}: ${error.message}`);
      }
      setMessageType('error');
    } finally {
      setLoading(false);
    }
  };

  const toggleAccessMode = async () => {
    const newMode = accessMode === 'private' ? 'remote' : 'private';
    
    // Tester la connectivité avant de rediriger
    setMessage(t('login.testingConnectivity').replace('{{mode}}', newMode === 'remote' ? 'Remote' : 'Privé'));
    setMessageType('info');
    
    const isAccessible = await testServerConnectivity(newMode, 3000);
    
    if (!isAccessible) {
      setMessage(t('login.accessModeError').replace('{{mode}}', newMode === 'remote' ? 'Remote' : 'Privé'));
      setMessageType('error');
      console.error(`[Login] Serveur non accessible en mode ${newMode}`);
      return;
    }
    
    // Si accessible, procéder à la redirection
    setAccessMode(newMode);
    persistAccessMode(newMode);
    
    setMessage(t('login.connecting'));
    setMessageType('success');
    
    // Rediriger vers l'URL correspondante
    const frontendUrl = urlsConfig.getFrontendUrl(newMode);
    const currentHash = window.location.hash || '#/login';
    const newUrl = `${frontendUrl}${currentHash}`;
    
    console.log(`[Login] Redirection vers ${newMode}: ${newUrl}`);
    
    // Redirection dans le même onglet (replace évite d'ajouter à l'historique)
    setTimeout(() => {
      window.location.replace(newUrl);
    }, 500);
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <h1>Ryvie</h1>
          <p>{t('login.subtitle')}</p>
        </div>
        
        {message && (
          <div className={`message message-${messageType}`}>
            {message}
          </div>
        )}
        
        <form onSubmit={handleLogin} className="login-form">
          <div className="form-group">
            <label htmlFor="username">{t('login.username')}</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              autoFocus
              placeholder={t('login.usernamePlaceholder')}
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password">{t('login.password')}</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              placeholder={t('login.passwordPlaceholder')}
            />
          </div>
          
          <button 
            type="submit" 
            className="login-button"
            disabled={loading}
          >
            {loading ? t('login.signingIn') : t('login.signIn')}
          </button>
        </form>
        
        <div className="access-mode-toggle">
          <span>{t('login.accessMode')}: </span>
          <button 
            onClick={toggleAccessMode}
            className={`toggle-button ${accessMode === 'remote' ? 'toggle-remote' : 'toggle-private'}`}
          >
            {accessMode === 'remote' ? 'Remote' : 'Privé'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;