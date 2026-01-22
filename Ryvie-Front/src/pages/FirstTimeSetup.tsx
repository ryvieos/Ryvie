import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/Login.css';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { useLanguage } from '../contexts/LanguageContext';

const FirstTimeSetup = () => {
  const navigate = useNavigate();
  const { language, setLanguage, t } = useLanguage();
  const [formData, setFormData] = useState({
    uid: '',
    email: '',
    password: '',
    confirmPassword: '',
    language: language || 'fr'
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
    if (!formData.uid || !formData.email || !formData.password) {
      setMessage(t('firstTimeSetup.allFieldsRequired'));
      setMessageType('error');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setMessage(t('firstTimeSetup.passwordMismatch'));
      setMessageType('error');
      return;
    }

    if (formData.password.length < 6) {
      setMessage(t('firstTimeSetup.passwordTooShort'));
      setMessageType('error');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      // Sauvegarder la langue globalement avant la création
      setLanguage(formData.language);
      
      const response = await axios.post(`${serverUrl}/api/ldap/create-first-user`, {
        uid: formData.uid,
        name: formData.uid,
        email: formData.email,
        password: formData.password,
        language: formData.language
      });

      if (response.data && response.data.uid) {
        setMessage(t('firstTimeSetup.successMessage'));
        setMessageType('success');
        
        setTimeout(() => {
          navigate('/login');
        }, 2000);
      } else {
        setMessage(t('firstTimeSetup.errorMessage'));
        setMessageType('error');
      }
    } catch (error) {
      console.error('Erreur lors de la création du premier utilisateur:', error);
      
      if (error.response) {
        if (error.response.status === 403) {
          setMessage(t('firstTimeSetup.usersExist'));
          setMessageType('error');
          setTimeout(() => {
            navigate('/login');
          }, 2000);
        } else {
          setMessage(error.response.data?.error || t('firstTimeSetup.errorMessage'));
        }
      } else if (error.request) {
        setMessage(t('firstTimeSetup.serverUnavailable'));
      } else {
        setMessage(`${t('common.error')}: ${error.message}`);
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
            <p>{t('firstTimeSetup.checking')}</p>
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
          <p>{t('firstTimeSetup.subtitle')}</p>
        </div>
        
        {message && (
          <div className={`message message-${messageType}`}>
            {message}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="language">{t('firstTimeSetup.language')} *</label>
            <select
              id="language"
              name="language"
              value={formData.language}
              onChange={(e) => {
                handleChange(e);
                setLanguage(e.target.value);
              }}
              disabled={loading}
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                border: '1px solid #ddd',
                fontSize: '14px',
                cursor: 'pointer',
                background: '#fff',
                width: '100%'
              }}
            >
              <option value="fr">🇫🇷 Français</option>
              <option value="en">🇬🇧 English</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="uid">{t('firstTimeSetup.username')} *</label>
            <input
              type="text"
              id="uid"
              name="uid"
              value={formData.uid}
              onChange={handleChange}
              disabled={loading}
              autoFocus
              placeholder={t('firstTimeSetup.usernamePlaceholder')}
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="email">{t('firstTimeSetup.email')} *</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              disabled={loading}
              placeholder={t('firstTimeSetup.emailPlaceholder')}
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password">{t('firstTimeSetup.password')} *</label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              disabled={loading}
              placeholder={t('firstTimeSetup.passwordPlaceholder')}
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="confirmPassword">{t('firstTimeSetup.confirmPassword')} *</label>
            <input
              type="password"
              id="confirmPassword"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              disabled={loading}
              placeholder={t('firstTimeSetup.confirmPasswordPlaceholder')}
            />
          </div>
          
          <button 
            type="submit" 
            className="login-button"
            disabled={loading}
          >
            {loading ? t('firstTimeSetup.creating') : t('firstTimeSetup.createButton')}
          </button>
        </form>
      </div>
    </div>
  );
};

export default FirstTimeSetup;
