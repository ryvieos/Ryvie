import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/Login.css';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';

const FirstTimeSetup = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    uid: '',
    name: '',
    email: '',
    password: '',
    confirmPassword: ''
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info');
  const [isChecking, setIsChecking] = useState(true);

  // Vérifier au chargement si la page est accessible
  useEffect(() => {
    const checkAccess = async () => {
      try {
        const accessMode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/ldap/check-first-time`);
        
        if (response.data && !response.data.isFirstTime) {
          // Des utilisateurs existent déjà, rediriger vers login
          console.log('[FirstTimeSetup] Des utilisateurs existent déjà - redirection vers login');
          navigate('/login', { replace: true });
        } else {
          // C'est bien la première fois, autoriser l'accès
          setIsChecking(false);
        }
      } catch (error) {
        console.error('[FirstTimeSetup] Erreur lors de la vérification:', error);
        // En cas d'erreur, rediriger vers login par sécurité
        navigate('/login', { replace: true });
      }
    };

    checkAccess();
  }, [navigate]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validation
    if (!formData.uid || !formData.name || !formData.email || !formData.password) {
      setMessage('Tous les champs sont requis');
      setMessageType('error');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setMessage('Les mots de passe ne correspondent pas');
      setMessageType('error');
      return;
    }

    if (formData.password.length < 6) {
      setMessage('Le mot de passe doit contenir au moins 6 caractères');
      setMessageType('error');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.post(`${serverUrl}/api/ldap/create-first-user`, {
        uid: formData.uid,
        name: formData.name,
        email: formData.email,
        password: formData.password
      });

      if (response.data && response.data.uid) {
        setMessage('Premier utilisateur admin créé avec succès ! Redirection vers la page de connexion...');
        setMessageType('success');
        
        setTimeout(() => {
          navigate('/login');
        }, 2000);
      } else {
        setMessage('Erreur lors de la création de l\'utilisateur');
        setMessageType('error');
      }
    } catch (error) {
      console.error('Erreur lors de la création du premier utilisateur:', error);
      
      if (error.response) {
        if (error.response.status === 403) {
          setMessage('Des utilisateurs existent déjà. Redirection vers la page de connexion...');
          setMessageType('error');
          setTimeout(() => {
            navigate('/login');
          }, 2000);
        } else {
          setMessage(error.response.data?.error || 'Erreur lors de la création de l\'utilisateur');
        }
      } else if (error.request) {
        setMessage('Serveur inaccessible. Vérifiez votre connexion.');
      } else {
        setMessage(`Erreur: ${error.message}`);
      }
      setMessageType('error');
    } finally {
      setLoading(false);
    }
  };

  // Afficher un écran de chargement pendant la vérification
  if (isChecking) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-header">
            <h1>Ryvie</h1>
            <p>Vérification...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <h1>Ryvie</h1>
          <p>Configuration initiale - Création du premier utilisateur</p>
        </div>
        
        {message && (
          <div className={`message message-${messageType}`}>
            {message}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="uid">Nom d'utilisateur *</label>
            <input
              type="text"
              id="uid"
              name="uid"
              value={formData.uid}
              onChange={handleChange}
              disabled={loading}
              autoFocus
              placeholder="nom d'utilisateur"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="name">Nom complet *</label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              disabled={loading}
              placeholder="prénom nom"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="email">Email *</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              disabled={loading}
              placeholder="email@example.com"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password">Mot de passe *</label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              disabled={loading}
              placeholder="mot de passe"
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="confirmPassword">Confirmer le mot de passe *</label>
            <input
              type="password"
              id="confirmPassword"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              disabled={loading}
              placeholder="confirmer le mot de passe"
            />
          </div>
          
          <button 
            type="submit" 
            className="login-button"
            disabled={loading}
          >
            {loading ? 'Création en cours...' : 'Créer l\'administrateur'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default FirstTimeSetup;
