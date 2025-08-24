import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import axios from 'axios';
import Home from './Home';
import User from './User';
import Login from './Login';
import Settings from './Settings';
import Welcome from './Welcome';
import Userlogin from './connexion';
import { initializeSession, isSessionActive } from './utils/sessionManager';
import { isElectron } from './utils/platformUtils';
import { handleAuthError } from './services/authService';

// Composant de redirection conditionnelle (Web et Electron)
const ProtectedRoute = ({ children }) => {
  return isSessionActive() ? children : <Navigate to="/login" replace />;
};

// Configurer l'intercepteur Axios pour gérer automatiquement les erreurs d'authentification
axios.interceptors.response.use(
  response => response,
  error => {
    // Si c'est une erreur d'authentification, la fonction handleAuthError s'en occupera
    if (handleAuthError(error)) {
      // L'erreur a été traitée comme une erreur d'authentification
      return Promise.reject({
        ...error,
        handled: true // Marquer l'erreur comme déjà traitée
      });
    }
    // Pour les autres types d'erreurs, les laisser se propager normalement
    return Promise.reject(error);
  }
);

const App = () => {
  useEffect(() => {
    // Initialiser la session au démarrage
    initializeSession();
    console.log(`[App] Application démarrée en mode ${isElectron() ? 'Electron' : 'Web'}`);
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
