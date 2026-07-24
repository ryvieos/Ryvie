import React, { useState, useEffect } from 'react';
import axios from '../utils/setupAxios';
import { useNavigate } from 'react-router-dom';
import '../styles/pages/Login.css';
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
  const [waitingForKeycloak, setWaitingForKeycloak] = useState(false);

  // Construit la base URL pour la redirection SSO — tout passe par Caddy (port 80)
  // Sur ryvie.local, redirige vers l'IP locale pour que le cookie Keycloak soit partagé avec les apps.
  // Récupère l'IP à la volée si elle n'est pas encore en cache (cas du premier build où le backend
  // démarre lentement et où check-first-time a échoué sans avoir mis l'IP en cache).
  const getSsoBase = async (): Promise<string> => {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    const mode = getCurrentAccessMode() || 'private';

    // HTTPS distant (domaines Netbird) : conserver le routage par domaine
    if (protocol === 'https:') {
      return getServerUrl(mode);
    }

    if (hostname === 'ryvie.local') {
      let localIP = getLocalIP();
      if (!localIP) {
        try {
          const statusRes = await axios.get(`${getServerUrl(mode)}/status`);
          if (statusRes.data?.ip) {
            setLocalIP(statusRes.data.ip);
            localIP = statusRes.data.ip;
          }
        } catch (e) {
          console.warn('[Login] getSsoBase: impossible de récupérer l\'IP locale:', e);
        }
      }
      if (localIP) {
        return `http://${localIP}`;
      }
    }

    // Accès par IP en HTTP (IP privée LAN ou IP tunnel Netbird) : tout le SSO doit passer
    // par Caddy sur le port 80 (même origine), car Keycloak (/auth/*) et /api/* ne sont servis
    // QUE par Caddy. Le port courant (3000 frontend / 3002 backend) ne sert pas /auth, ce qui
    // cassait la redirection SSO (http://<ip>:3002/auth/... injoignable).
    return `http://${hostname}`;
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

      // 4) Vérifier si c'est la première connexion.
      // LDAP peut mettre du temps à démarrer (boot) ou être temporairement KO :
      // le backend renvoie alors 503 + isFirstTime:null (état INCONNU). On
      // RÉESSAIE au lieu de conclure « déjà configuré », sinon une machine
      // neuve dont LDAP est indisponible n'affiche jamais l'assistant RAID.
      try {
        const mode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(mode);

        const FIRST_TIME_RETRIES = 5;
        const FIRST_TIME_DELAY_MS = 3000;
        let isFirstTime: boolean | null = null;
        for (let attempt = 1; attempt <= FIRST_TIME_RETRIES; attempt++) {
          try {
            const response = await axios.get(`${serverUrl}/api/ldap/check-first-time`);
            if (typeof response.data?.isFirstTime === 'boolean') {
              isFirstTime = response.data.isFirstTime;
              break;
            }
          } catch (e) {
            console.warn(`[Login] check-first-time tentative ${attempt}/${FIRST_TIME_RETRIES} échouée (LDAP indisponible ?)`);
          }
          if (attempt < FIRST_TIME_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, FIRST_TIME_DELAY_MS));
          }
        }

        if (isFirstTime === true) {
          console.log('[Login] Première connexion détectée - redirection vers Assistant RAID');
          navigate('/setup/storage', { replace: true });
          return;
        }
        if (isFirstTime === null) {
          console.error('[Login] Impossible de déterminer l\'état première-connexion (LDAP KO) - fallback Keycloak');
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

        console.log('[Login] Utilisateur existant - vérification de la disponibilité de Keycloak...');
        setWaitingForKeycloak(true);
        return;
      } catch (error) {
        console.error('[Login] Erreur lors de la vérification de la première connexion:', error);
        setWaitingForKeycloak(true);
      }
    };

    initMode();
  }, []);

  // Polling Keycloak health avant redirection SSO
  useEffect(() => {
    if (!waitingForKeycloak) return;

    let cancelled = false;

    const pollHealth = async () => {
      const mode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(mode);
      const healthUrl = `${serverUrl}/api/auth/health`;

      while (!cancelled) {
        try {
          console.log('[Login] Polling Keycloak health...');
          const res = await axios.get(healthUrl, { timeout: 5000 });
          if (res.data?.ready) {
            console.log('[Login] Keycloak est prêt, redirection SSO');
            if (!cancelled) {
              const ssoUrl = `${await getSsoBase()}/api/auth/login`;
              console.log('[Login] URL SSO finale:', ssoUrl);
              if (!cancelled) setSsoRedirectUrl(ssoUrl);
            }
            return;
          }
        } catch (e) {
          console.log('[Login] Keycloak pas encore prêt, nouvelle tentative dans 2s...');
        }
        // Attendre 2s avant de réessayer
        await new Promise(r => setTimeout(r, 2000));
      }
    };

    pollHealth();
    return () => { cancelled = true; };
  }, [waitingForKeycloak]);

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
      const ssoBase = await getSsoBase();
      console.log(`[Login] Redirection SSO en mode ${accessMode.toUpperCase()}: ${ssoBase}`);
      window.location.href = `${ssoBase}/api/auth/login`;
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
      <div className="login-card login-card--preparing">

        <div className="login-preparing">
          <div className="login-preparing__icon">
            <div className="login-preparing__ring" />
            <span className="login-preparing__logo">R</span>
          </div>

          <h2 className="login-preparing__title">
            {t('login.preparingTitle') || 'Votre Ryvie est en cours de préparation'}
          </h2>

          <p className="login-preparing__subtitle">
            {waitingForKeycloak && !ssoRedirectUrl
              ? (t('login.preparingSubtitle') || 'Nous préparons votre espace sécurisé...')
              : (t('login.redirecting') || 'Redirection...')}
          </p>

          <div className="login-preparing__dots">
            <span /><span /><span />
          </div>

          <div className="login-preparing__bar">
            <div className="login-preparing__bar-fill" />
          </div>
        </div>

      </div>
    </div>
  );
};

export default Login;