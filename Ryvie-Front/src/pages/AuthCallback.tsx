import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { startSession } from '../utils/sessionManager';

const AuthCallback = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');

  useEffect(() => {
    const handleCallback = () => {
      console.log('[AuthCallback] Full location:', location.href);
      console.log('[AuthCallback] Hash:', location.hash);
      console.log('[AuthCallback] Search:', location.search);
      
      // Essayer de récupérer le token depuis le hash ou la query string
      const hash = location.hash.substring(1);
      const hashParams = new URLSearchParams(hash.split('?')[1] || '');
      const searchParams = new URLSearchParams(location.search);
      
      const token = hashParams.get('token') || searchParams.get('token');
      const errorParam = hashParams.get('error') || searchParams.get('error');

      console.log('[AuthCallback] Token trouvé:', token ? 'OUI' : 'NON');

      if (errorParam) {
        setError('Erreur d\'authentification. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      if (!token) {
        setError('Token manquant. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      try {
        const payload = JSON.parse(atob(token.split('.')[1]));

        startSession({
          token,
          userId: payload.uid,
          userName: payload.name,
          userRole: payload.role,
          userEmail: payload.email,
        });

        // Sauvegarder l'id_token pour la déconnexion (si disponible dans le payload)
        if (payload.idToken) {
          localStorage.setItem('id_token', payload.idToken);
        }

        console.log('[AuthCallback] Session démarrée pour', payload.uid);

        navigate('/welcome', { replace: true });
      } catch (error) {
        console.error('[AuthCallback] Erreur lors du traitement du token:', error);
        setError('Erreur lors de la connexion. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    handleCallback();
  }, [location, navigate]);

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100vh',
      flexDirection: 'column',
      gap: '20px'
    }}>
      {error ? (
        <>
          <div style={{ color: 'red', fontSize: '18px' }}>{error}</div>
          <div>Redirection vers la page de connexion...</div>
        </>
      ) : (
        <>
          <div className="spinner"></div>
          <div>Authentification en cours...</div>
        </>
      )}
    </div>
  );
};

export default AuthCallback;
