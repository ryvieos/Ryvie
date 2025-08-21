import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './styles/Login.css';
const { getServerUrl } = require('./config/urls');
import { setAuthToken } from './services/authService';

const Login = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info'); // 'info', 'success', 'error'
  const [accessMode, setAccessMode] = useState('private');
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockTimeRemaining, setBlockTimeRemaining] = useState(0);

  useEffect(() => {
    // Récupérer le mode d'accès depuis le localStorage
    const storedMode = localStorage.getItem('accessMode') || 'private';
    setAccessMode(storedMode);

    // Vérifier si l'utilisateur est déjà connecté
    const token = localStorage.getItem('jwt_token');
    if (token) {
      navigate('/');
    }

    // Check for existing login attempts and blocks
    const attempts = parseInt(localStorage.getItem('loginAttempts') || '0');
    const blockUntil = parseInt(localStorage.getItem('blockUntil') || '0');
    
    setLoginAttempts(attempts);
    
    if (blockUntil > Date.now()) {
      setIsBlocked(true);
      setBlockTimeRemaining(Math.ceil((blockUntil - Date.now()) / 1000));
      
      // Start countdown timer
      const timer = setInterval(() => {
        const remaining = Math.ceil((blockUntil - Date.now()) / 1000);
        if (remaining <= 0) {
          setIsBlocked(false);
          setBlockTimeRemaining(0);
          localStorage.removeItem('blockUntil');
          clearInterval(timer);
        } else {
          setBlockTimeRemaining(remaining);
        }
      }, 1000);
      
      return () => clearInterval(timer);
    }
  }, [navigate]);

  const handleLogin = async (e) => {
    e.preventDefault();
    
    if (!username || !password) {
      setMessage("Veuillez entrer un nom d'utilisateur et un mot de passe");
      setMessageType('error');
      return;
    }

    if (isBlocked) {
      setMessage(`Trop de tentatives échouées. Réessayez dans ${blockTimeRemaining} secondes.`);
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
      }, {
        headers: {
          'Authorization': undefined // Supprimer l'ancien token pour cette requête
        }
      });

      if (response.data && response.data.token) {
        // Enregistrer le token et les infos utilisateur
        localStorage.setItem('jwt_token', response.data.token);
        localStorage.setItem('currentUser', response.data.user.name || response.data.user.uid);
        localStorage.setItem('currentUserRole', response.data.user.role || 'User');
        localStorage.setItem('currentUserEmail', response.data.user.email || '');
        
        // Configurer axios pour utiliser le token dans toutes les requêtes futures
        setAuthToken(response.data.token);
        
        // Clear failed attempts on success
        setLoginAttempts(0);
        localStorage.removeItem('loginAttempts');
        localStorage.removeItem('blockUntil');
        
        setMessage('Connexion réussie. Redirection...');
        setMessageType('success');
        
        // Rediriger vers la page d'accueil
        setTimeout(() => {
          navigate('/');
        }, 1000);
      } else {
        setMessage('Réponse incorrecte du serveur');
        setMessageType('error');
      }
    } catch (error) {
      console.error('Erreur d\'authentification:', error);
      
      // Increment failed attempts
      const newAttempts = loginAttempts + 1;
      setLoginAttempts(newAttempts);
      localStorage.setItem('loginAttempts', newAttempts.toString());
      
      // Block after 5 failed attempts
      if (newAttempts >= 5) {
        const blockUntil = Date.now() + (15 * 60 * 1000); // 15 minutes
        localStorage.setItem('blockUntil', blockUntil.toString());
        setIsBlocked(true);
        setBlockTimeRemaining(15 * 60);
        
        // Start countdown timer
        const timer = setInterval(() => {
          const remaining = Math.ceil((blockUntil - Date.now()) / 1000);
          if (remaining <= 0) {
            setIsBlocked(false);
            setBlockTimeRemaining(0);
            localStorage.removeItem('blockUntil');
            clearInterval(timer);
          } else {
            setBlockTimeRemaining(remaining);
          }
        }, 1000);
      }
      
      // Gestion détaillée des erreurs
      if (error.response) {
        // Le serveur a répondu avec un code d'erreur
        if (error.response.status === 401) {
          const remaining = 5 - newAttempts;
          if (remaining > 0) {
            setMessage(`Identifiants incorrects. ${remaining} tentative(s) restante(s).`);
          } else {
            setMessage('Trop de tentatives échouées. Compte bloqué pendant 15 minutes.');
          }
        } else if (error.response.status === 429) {
          const retryAfter = error.response.data?.retryAfter || 900; // 15 minutes default
          setMessage(`Trop de tentatives de connexion. Réessayez dans ${Math.ceil(retryAfter / 60)} minutes.`);
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
    localStorage.setItem('accessMode', newMode);
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
