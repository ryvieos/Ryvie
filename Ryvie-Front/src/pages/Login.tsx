import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/Login.css';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { isSessionActive, startSession } from '../utils/sessionManager';
import { getCurrentAccessMode, detectAccessMode, setAccessMode as persistAccessMode } from '../utils/detectAccessMode';

const Login = () => {
  const navigate = useNavigate();
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
          persistAccessMode('public');
          setAccessMode('public');
          console.log('[Login] Page HTTPS - accessMode initialisé à REMOTE');
        } else {
          // En HTTP (dev/local) -> tester la connectivité locale rapidement
          try {
            const detected = await detectAccessMode(1500);
            setAccessMode(detected);
            console.log(`[Login] accessMode détecté: ${detected}`);
          } catch {
            // Fallback sécurisé
            persistAccessMode('public');
            setAccessMode('public');
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
    if (accessMode !== 'public') return;

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

  const handleLogin = async (e) => {
    e.preventDefault();
    
    if (!username || !password) {
      setMessage("Veuillez entrer un nom d'utilisateur et un mot de passe");
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

        setMessage('Connexion réussie. Redirection...');
        setMessageType('success');
        
        // Rediriger vers la page de bienvenue pour éviter la boucle sur /login
        setTimeout(() => {
          navigate('/welcome');
        }, 300);
      } else {
        setMessage('Réponse incorrecte du serveur');
        setMessageType('error');
      }
    } catch (error) {
      console.error('Erreur d\'authentification:', error);
      
      // Gestion détaillée des erreurs
      if (error.response) {
        // Le serveur a répondu avec un code d'erreur
        if (error.response.status === 401) {
          setMessage('Identifiants incorrects. Veuillez réessayer.');
        } else if (error.response.status === 429) {
          setMessage('Trop de tentatives de connexion. Veuillez réessayer plus tard.');
        } else {
          setMessage(`Erreur d'authentification: ${error.response.data?.error || 'Erreur serveur'}`);
        }
      } else if (error.request) {
        // La requête a été faite mais pas de réponse
        setMessage('Serveur inaccessible. Vérifiez votre connexion.');
      } else {
        // Erreur lors de la configuration de la requête
        setMessage(`Erreur: ${error.message}`);
      }
      setMessageType('error');
    } finally {
      setLoading(false);
    }
  };

  const toggleAccessMode = () => {
    const newMode = accessMode === 'private' ? 'public' : 'private';
    setAccessMode(newMode);
    persistAccessMode(newMode);
    
    // Rediriger vers l'URL correspondante
    const frontendUrl = urlsConfig.getFrontendUrl(newMode);
    const currentHash = window.location.hash || '#/login';
    const newUrl = `${frontendUrl}${currentHash}`;
    
    console.log(`[Login] Redirection vers ${newMode}: ${newUrl}`);
    
    // Redirection dans le même onglet (replace évite d'ajouter à l'historique)
    window.location.replace(newUrl);
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <h1>Ryvie</h1>
          <p>Connectez-vous pour accéder à votre espace personnel</p>
        </div>
        
        {message && (
          <div className={`message message-${messageType}`}>
            {message}
          </div>
        )}
        
        <form onSubmit={handleLogin} className="login-form">
          <div className="form-group">
            <label htmlFor="username">Nom d'utilisateur ou Email</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              autoFocus
              placeholder="nom d'utilisateur ou email"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password">Mot de passe</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              placeholder="mot de passe"
            />
          </div>
          
          <button 
            type="submit" 
            className="login-button"
            disabled={loading}
          >
            {loading ? 'Connexion en cours...' : 'Se connecter'}
          </button>
        </form>
        
        <div className="access-mode-toggle">
          <span>Mode d'accès: </span>
          <button 
            onClick={toggleAccessMode}
            className={`toggle-button ${accessMode === 'public' ? 'toggle-remote' : 'toggle-private'}`}
          >
            {accessMode === 'public' ? 'Remote' : 'Privé'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;