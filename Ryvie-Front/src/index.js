import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import AppStore from './pages/AppStore';
import User from './pages/User';
import Login from './pages/Login';
import FirstTimeSetup from './pages/FirstTimeSetup';
import Settings from './pages/Settings';
import StorageSettings from './pages/StorageSettings';
import Welcome from './pages/Welcome';
import Userlogin from './pages/Connexion';
import ServerRestarting from './pages/ServerRestarting';
import { initializeSession, isSessionActive } from './utils/sessionManager';
import { isElectron } from './utils/platformUtils';
import { handleAuthError } from './services/authService';
import faviconUrl from './icons/ryvielogo0.png';
import { SocketProvider } from './contexts/SocketContext';
import { CachedRoutes } from './components/CachedRoutes';

// Composant de redirection conditionnelle (Web et Electron)
const ProtectedRoute = ({ children }) => {
  return isSessionActive() ? children : <Navigate to="/login" replace />;
};

const App = () => {
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
    <SocketProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
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
          <Route path="/server-restarting" element={<ServerRestarting />} />
        </Routes>
      </Router>
    </SocketProvider>
  );
};

const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(<App />);