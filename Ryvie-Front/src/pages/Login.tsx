import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/Login.css';
import urlsConfig from '../config/urls';
const { getServerUrl, getLocalIP, setLocalIP } = urlsConfig;
import { isSessionActive, startSession } from '../utils/sessionManager';
import { getCurrentAccessMode, detectAccessMode, setAccessMode as persistAccessMode, testServerConnectivity } from '../utils/detectAccessMode';
import { useLanguage } from '../contexts/LanguageContext';

const Login = () => {
  const navigate = useNavigate();
  const { t, setLanguage } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info'); // 'info', 'success', 'error'
  const [accessMode, setAccessMode] = useState('private');
  const [isRedirectingToSSO, setIsRedirectingToSSO] = useState(true);
  const [ssoRedirectUrl, setSsoRedirectUrl] = useState<string | null>(null);

  // Construit la base URL du backend pour la redirection SSO
  // Même logique que buildAppUrl() : si on est sur ryvie.local et qu'une IP locale
  // est détectée, utiliser cette IP pour que le cookie Keycloak soit partagé avec les apps
  const getSsoBase = (): string => {
    const hostname = window.location.hostname;
    const port = window.location.port;
    const localIP = getLocalIP();

    console.log('[Login] getSsoBase - hostname:', hostname, 'port:', port, 'localIP:', localIP);

    if (hostname === 'ryvie.local') {
      if (localIP) {
        console.log('[Login] getSsoBase - using localIP:', `http://${localIP}:3002`);
        return `http://${localIP}:3002`;
      }
      console.log('[Login] getSsoBase - no localIP, using ryvie.local');
      return `http://ryvie.local`;
    }

    console.log('[Login] getSsoBase - using current hostname:', `http://${hostname}:3002`);
    return `http://${hostname}:3002`;
  };

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
          return;
        }

        // 5) Récupérer l'IP locale si on est sur ryvie.local (pour que le cookie Keycloak
        //    soit sur le même domaine que les apps)
        if (window.location.hostname === 'ryvie.local') {
          console.log('[Login] Sur ryvie.local, getLocalIP():', getLocalIP());
          if (!getLocalIP()) {
            try {
              console.log('[Login] Fetch /status pour récupérer l\'IP locale...');
              const statusRes = await axios.get(`${serverUrl}/status`);
              console.log('[Login] Réponse /status:', statusRes.data);
              if (statusRes.data?.ip) {
                setLocalIP(statusRes.data.ip);
                console.log('[Login] IP locale mise en cache:', statusRes.data.ip);
                console.log('[Login] Vérification getLocalIP() après setLocalIP():', getLocalIP());
              } else {
                console.warn('[Login] Pas d\'IP dans la réponse /status');
              }
            } catch (e) {
              console.warn('[Login] Impossible de récupérer l\'IP locale:', e);
            }
          } else {
            console.log('[Login] IP locale déjà en cache:', getLocalIP());
          }
        }

        console.log('[Login] Utilisateur existant - redirection automatique vers SSO');
        const ssoUrl = `${getSsoBase()}/api/auth/login`;
        console.log('[Login] URL SSO finale:', ssoUrl);
        setSsoRedirectUrl(ssoUrl);
        return;
      } catch (error) {
        console.error('[Login] Erreur lors de la vérification de la première connexion:', error);
        setSsoRedirectUrl(`${getSsoBase()}/api/auth/login`);
      }
    };

    initMode();
  }, []);

  // Redirection SSO différée : attend que le spinner soit peint avant de naviguer
  useEffect(() => {
    if (!ssoRedirectUrl) return;
    // requestAnimationFrame garantit que le navigateur a peint le spinner
    const rafId = requestAnimationFrame(() => {
      setTimeout(() => {
        window.location.href = ssoRedirectUrl;
      }, 100);
    });
    return () => cancelAnimationFrame(rafId);
  }, [ssoRedirectUrl]);

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

  const handleSSOLogin = async () => {
    setLoading(true);
    setMessage(t('login.redirectingToSSO') || 'Redirection vers le SSO...');
    setMessageType('info');

    try {
      const serverUrl = getServerUrl(accessMode);
      console.log(`[Login] Redirection SSO en mode ${accessMode.toUpperCase()}: ${serverUrl}`);
      window.location.href = `${serverUrl}/api/auth/login`;
    } catch (error: any) {
      console.error('Erreur de redirection SSO:', error);
      setMessage(t('login.ssoError') || 'Erreur SSO');
      setMessageType('error');
      setLoading(false);
    }
  };

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
        // Appliquer la langue de l'utilisateur si elle est définie
        if (response.data.user.language) {
          setLanguage(response.data.user.language);
          console.log(`[Login] Langue de l'utilisateur appliquée: ${response.data.user.language}`);
        }
        
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


        <div className="login-redirect">
          <div className="spinner" />
        </div>
      </div>
    </div>
  );
};

export default Login;