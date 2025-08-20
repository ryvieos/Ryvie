import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as Router, Route, Routes, Navigate } from 'react-router-dom';
import Home from './Home';
import User from './User';
import Settings from './Settings';
import Welcome from './Welcome';
import Userlogin from './connexion';
import { initializeSession, isSessionActive } from './utils/sessionManager';
import { isElectron } from './utils/platformUtils';

// Composant de redirection conditionnelle
const ProtectedRoute = ({ children }) => {
  // En Electron, toujours permettre l'accès (gestion par les fenêtres)
  // En Web, vérifier la session
  if (isElectron()) {
    return children;
  }
  
  return isSessionActive() ? children : <Navigate to="/login" />;
};

const App = () => {
  useEffect(() => {
    // Initialiser la session au démarrage
    initializeSession();
    console.log(`[App] Application démarrée en mode ${isElectron() ? 'Electron' : 'Web'}`);
  }, []);

  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Userlogin />} />
        <Route path="/" element={
          <ProtectedRoute>
            <Home />
          </ProtectedRoute>
        } />
        <Route path="/home" element={
          <ProtectedRoute>
            <Home />
          </ProtectedRoute>
        } />
        <Route path="/user" element={<User />} />
        <Route path="/settings" element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        } />
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/userlogin" element={<Userlogin />} />
      </Routes>
    </Router>
  );
};

const rootElement = document.getElementById('root');
const root = ReactDOM.createRoot(rootElement);
root.render(<App />);
