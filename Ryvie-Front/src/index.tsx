import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import AppStore from './pages/AppStore';
import User from './pages/User';
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';
import FirstTimeSetup from './pages/FirstTimeSetup';
import Settings from './pages/Settings';
import StorageSettings from './pages/StorageSettings';
import Welcome from './pages/Welcome';
import Userlogin from './pages/Connexion';
import ServerRestarting from './pages/ServerRestarting';
import Onboarding from './pages/Onboarding';
import { initializeSession, isSessionActive, endSession, getSessionInfo } from './utils/sessionManager';
import { handleTokenError } from './utils/setupAxios';
import { isElectron } from './utils/platformUtils';
import { handleAuthError } from './services/authService';
import faviconUrl from './icons/ryvielogo0.png';
import { SocketProvider } from './contexts/SocketContext';
import { CachedRoutes } from './components/CachedRoutes';
import { UpdateProvider } from './contexts/UpdateContext';
import GlobalUpdateModal from './components/GlobalUpdateModal';
import { LanguageProvider } from './contexts/LanguageContext';

// Composant de redirection conditionnelle (Web et Electron)
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const sessionActive = isSessionActive();
  
  // Ne pas nettoyer automatiquement la session ici pour éviter les boucles
  // Le nettoyage se fait uniquement lors d'erreurs d'authentification (401)
  // ou lors d'une déconnexion explicite
  
  return sessionActive ? children : <Navigate to="/login" replace />;
};

const App = () => {
  // Vérification PROACTIVE de l'expiration de session, sur TOUTE page : timer
  // périodique + retour sur l'onglet. Si le token est expiré, on déconnecte et on
  // redirige vers /login (sans attendre un appel API qui renverrait 401). Le token
  // expiré n'étant pas rafraîchissable (le serveur fait jwt.verify), c'est cohérent.
  useEffect(() => {
    const checkExpiry = () => {
      try {
        const { token } = getSessionInfo() || {};
        if (!token) return; // pas de session → rien à faire
        let expired = false;
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          expired = typeof payload?.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp;
        } catch { expired = false; }
        if (expired) {
          console.log('[App] Session expirée détectée (vérif proactive) → déconnexion');
          handleTokenError('EXPIRED_TOKEN');
        }
      } catch (_) {}
    };
    const interval = setInterval(checkExpiry, 30000);
    const onFocus = () => checkExpiry();
    const onVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') checkExpiry(); };
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    checkExpiry();
    return () => {
      clearInterval(interval);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    // Initialiser la session au démarrage
    initializeSession();
    console.log(`[App] Application démarrée en mode ${isElectron() ? 'Electron' : 'Web'}`);

    // Définir le favicon pour l'onglet Web
    try {
      if (typeof document !== 'undefined') {
        let link = document.querySelector("link[rel='icon']");
        if (!link) {
          link = document.createElement('link');
          link.setAttribute('rel', 'icon');
          document.head.appendChild(link);
        }
        link.setAttribute('href', faviconUrl);
        link.setAttribute('type', 'image/png');
        link.setAttribute('sizes', '32x32');
      }
    } catch (e) {
      console.warn('[App] Impossible de définir le favicon:', e);
    }
  }, []);

  return (
    <LanguageProvider>
      <UpdateProvider>
        <SocketProvider>
          <Router>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth-callback" element={<AuthCallback />} />
            <Route path="/first-time-setup" element={<FirstTimeSetup />} />
          <Route path="/" element={
            isSessionActive() ? <Navigate to="/welcome" replace /> : <Navigate to="/login" replace />
          } />
          <Route path="/home" element={
            <ProtectedRoute>
              <CachedRoutes 
                homeComponent={<Home />}
                settingsComponent={<Settings />}
              />
            </ProtectedRoute>
          } />
          <Route path="/settings" element={
            <ProtectedRoute>
              <CachedRoutes 
                homeComponent={<Home />}
                settingsComponent={<Settings />}
              />
            </ProtectedRoute>
          } />
          <Route path="/user" element={
            <ProtectedRoute>
              <User />
            </ProtectedRoute>
          } />
          <Route path="/settings/storage" element={
            <ProtectedRoute>
              <StorageSettings />
            </ProtectedRoute>
          } />
          <Route path="/setup/storage" element={<StorageSettings />} />
          <Route path="/welcome" element={
            <ProtectedRoute>
              <Welcome />
            </ProtectedRoute>
          } />
          <Route path="/appstore" element={
            <ProtectedRoute>
              <AppStore />
            </ProtectedRoute>
          } />
          <Route path="/userlogin" element={
            <ProtectedRoute>
              <Userlogin />
            </ProtectedRoute>} />
          <Route path="/onboarding" element={
            <ProtectedRoute>
              <Onboarding />
            </ProtectedRoute>} />
          <Route path="/server-restarting" element={<ServerRestarting />} />
        </Routes>
        </Router>
        <GlobalUpdateModal />
      </SocketProvider>
    </UpdateProvider>
    </LanguageProvider>
  );
};

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}
const root = ReactDOM.createRoot(rootElement);
root.render(<App />);