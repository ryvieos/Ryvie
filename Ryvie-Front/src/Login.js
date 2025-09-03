import React, { useState, useEffect } from 'react';
import axios from './utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import './styles/Login.css';
const { getServerUrl } = require('./config/urls');
import { setAuthToken } from './services/authService';
import { isSessionActive } from './utils/sessionManager';
import { getCurrentAccessMode, detectAccessMode, setAccessMode as persistAccessMode } from './utils/detectAccessMode';

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
          // En HTTPS, forcer PUBLIC pour éviter tout Mixed Content
          persistAccessMode('public');
          setAccessMode('public');
          console.log('[Login] Page HTTPS - accessMode initialisé à PUBLIC');
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
            console.log('[Login] Détection échouée - fallback PUBLIC');
          }
        }
      }

      // 3) Vérifier si une session est réellement active avant de rediriger
      if (isSessionActive()) {
        navigate('/welcome', { replace: true });
      }
    };

    initMode();
  }, []);

  // Polling: rester en public et tenter périodiquement de basculer en privé dès que détecté
  useEffect(() => {
    // Ne pas tenter en HTTPS (évite Mixed Content) et uniquement si on est en PUBLIC
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
        // Reste en public silencieusement
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
        // Enregistrer le token et les infos utilisateur
        localStorage.setItem('jwt_token', response.data.token);
        localStorage.setItem('currentUser', response.data.user.name || response.data.user.uid);
        localStorage.setItem('currentUserRole', response.data.user.role || 'User');
        localStorage.setItem('currentUserEmail', response.data.user.email || '');

        // Marquer la session comme active (requis par ProtectedRoute)
        localStorage.setItem('sessionActive', 'true');
        localStorage.setItem('sessionStartTime', new Date().toISOString());
        // Marquer qu'au moins une connexion a eu lieu
        localStorage.setItem('hasEverConnected', 'true');
        
        // Configurer axios pour utiliser le token dans toutes les requêtes futures
        setAuthToken(response.data.token);
        
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
            <label htmlFor="username">Nom d'utilisateur</label>
            <input
              type="text"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              autoFocus
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
            className={`toggle-button ${accessMode === 'public' ? 'toggle-public' : 'toggle-private'}`}
          >
            {accessMode === 'public' ? 'Public' : 'Privé'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;