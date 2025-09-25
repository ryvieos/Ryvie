import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { startSession } from '../utils/sessionManager';

/**
 * Composant qui écoute les événements d'authentification depuis Electron
 * et configure l'application en conséquence
 */
const AuthListener = () => {
  const navigate = useNavigate();

  useEffect(() => {
    // Fonction qui gère la réception du token d'authentification
    const handleAuthToken = (event, data) => {
      if (data && data.token) {
        console.log('Token d\'authentification reçu de Electron');
        
        // Démarrer une session unifiée (stockage, header axios, cookies web)
        startSession({
          token: data.token,
          userId: data.userId,
          userName: data.userName || data.userId,
          userRole: data.userRole || 'User',
          userEmail: data.userEmail || ''
        });
        
        // Rediriger vers la page d'accueil (Welcome)
        navigate('/');
      }
    };

    // Écouter l'événement uniquement si l'API Electron est disponible
    if (window.electronAPI && typeof window.electronAPI.onSetAuthToken === 'function') {
      window.electronAPI.onSetAuthToken(handleAuthToken);
      
      return () => {
        // Nettoyage de l'écouteur d'événement
        // Note: Electron n'a pas de méthode removeListener explicite dans ce contexte
        // mais c'est une bonne pratique de prévoir le nettoyage
      };
    }
  }, [navigate]);

  // Ce composant ne rend rien visuellement
  return null;
};

export default AuthListener;
