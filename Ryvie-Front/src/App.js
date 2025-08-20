import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Home from './Home';
import Connexion from './connexion';
import User from './User';
import Settings from './Settings';
import Welcome from './Welcome';
import { initializeSession, isSessionActive } from './utils/sessionManager';
import { isElectron } from './utils/platformUtils';

// Composant pour gérer la redirection conditionnelle
const ProtectedRoute = ({ children }) => {
  const sessionActive = isSessionActive();
  
  if (!sessionActive) {
    return <Navigate to="/login" replace />;
  }
  
  return children;
};

function App() {
  const [sessionChecked, setSessionChecked] = useState(false);
  
  useEffect(() => {
    // Initialiser la session au démarrage
    initializeSession();
    setSessionChecked(true);
    
    // Log du mode d'exécution
    console.log(`[App] Mode d'exécution: ${isElectron() ? 'Electron' : 'Web'}`);
    console.log(`[App] Session active: ${isSessionActive()}`);
  }, []);
  
  // Attendre que la vérification de session soit terminée
  if (!sessionChecked) {
    return <div>Chargement...</div>;
  }

  return (
    <Router>
      <div className="App">
        <Routes>
          <Route path="/login" element={<Connexion />} />
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
          <Route path="/" element={
            isSessionActive() ? <Navigate to="/welcome" replace /> : <Navigate to="/login" replace />
          } />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
