import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Home from './Home';
import AppStore from './AppStore';
import User from './User';
import Login from './Login';
import Settings from './Settings';
import Welcome from './Welcome';
import Userlogin from './Connexion';
import { initializeSession, isSessionActive } from './utils/sessionManager';
import { isElectron } from './utils/platformUtils';
import { handleAuthError } from './services/authService';
import faviconUrl from './icons/ryvielogo0.png';

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
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={
          isSessionActive() ? <Navigate to="/welcome" replace /> : <Navigate to="/login" replace />
        } />
        <Route path="/home" element={
          <ProtectedRoute>
            <Home />
          </ProtectedRoute>
        } />
        <Route path="/user" element={
          <ProtectedRoute>
            <User />
          </ProtectedRoute>
        } />
        <Route path="/settings" element={
          <ProtectedRoute>
            <Settings />
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
      </Routes>
    </Router>
  );
};

const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(<App />);
