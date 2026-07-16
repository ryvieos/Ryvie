import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { startSession, isSessionActive, endSession } from '../utils/sessionManager';

// ── Disjoncteur anti-boucle ──
// Si le client repasse plusieurs fois par /auth-callback en peu de temps, c'est
// qu'on boucle (login → SSO → auth-callback → session jugée invalide → login…).
// Historique des passages conservé en sessionStorage (survit aux redirections,
// pas à la fermeture de l'onglet).
const LOOP_HISTORY_KEY = 'auth_cb_history';
const LOOP_WINDOW_MS = 2 * 60 * 1000; // fenêtre d'observation : 2 minutes
const LOOP_HEAL_THRESHOLD = 3;        // 3 passages → auto-réparation + 1 retry
const LOOP_STOP_THRESHOLD = 4;        // 4 passages → arrêt franc, action manuelle

const recordCallbackVisit = (): number => {
  let history: number[] = [];
  try {
    history = JSON.parse(sessionStorage.getItem(LOOP_HISTORY_KEY) || '[]');
    if (!Array.isArray(history)) history = [];
  } catch { history = []; }
  const now = Date.now();
  history = history.filter(ts => typeof ts === 'number' && now - ts < LOOP_WINDOW_MS);
  history.push(now);
  try { sessionStorage.setItem(LOOP_HISTORY_KEY, JSON.stringify(history)); } catch { }
  return history.length;
};

const clearCallbackHistory = () => {
  try { sessionStorage.removeItem(LOOP_HISTORY_KEY); } catch { }
};

// Auto-réparation : purge tout état d'authentification potentiellement corrompu
// (session partielle, ancien id_token…) pour repartir d'une base saine.
const healAuthState = () => {
  try { endSession(); } catch { }
  try { localStorage.removeItem('id_token'); } catch { }
};

const AuthCallback = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false); // boucle détectée → action manuelle

  useEffect(() => {
    const handleCallback = () => {
      console.log('[AuthCallback] Hash:', location.hash);
      console.log('[AuthCallback] Search:', location.search);

      const visits = recordCallbackVisit();

      // Essayer de récupérer le token depuis le hash ou la query string
      const hash = location.hash.substring(1);
      const hashParams = new URLSearchParams(hash.split('?')[1] || '');
      const searchParams = new URLSearchParams(location.search);

      const token = hashParams.get('token') || searchParams.get('token');
      const errorParam = hashParams.get('error') || searchParams.get('error');

      console.log('[AuthCallback] Token trouvé:', token ? 'OUI' : 'NON', '- passage n°', visits);

      // ── Boucle de connexion détectée ──
      if (visits >= LOOP_STOP_THRESHOLD) {
        // L'auto-réparation n'a pas suffi : on ARRÊTE toute redirection automatique.
        console.error('[AuthCallback] Boucle de connexion persistante, arrêt des redirections automatiques');
        healAuthState();
        setStopped(true);
        setError('Boucle de connexion détectée. Les redirections automatiques ont été suspendues.');
        return;
      }
      if (visits >= LOOP_HEAL_THRESHOLD) {
        // Auto-réparation : purge de l'état d'authentification puis UNE nouvelle
        // tentative. Si elle échoue aussi, le seuil d'arrêt ci-dessus prendra le relais.
        console.warn('[AuthCallback] Boucle de connexion détectée, auto-réparation puis nouvelle tentative');
        healAuthState();
        setError('Instabilité de connexion détectée, réparation automatique en cours…');
        setTimeout(() => navigate('/login', { replace: true }), 1500);
        return;
      }

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

        // Ne naviguer vers /welcome QUE si la session est réellement considérée
        // active — sinon la route protégée renverrait aussitôt vers /login et on
        // repartirait en boucle. startSession vient de compenser la dérive
        // d'horloge (clockSkew) : un échec ici signifie un autre problème
        // (stockage bloqué, token vraiment invalide…).
        if (!isSessionActive()) {
          console.error('[AuthCallback] Session inactive juste après startSession, on ne boucle pas');
          healAuthState();
          setStopped(true);
          setError('Impossible d\'établir la session (stockage du navigateur bloqué ou token invalide).');
          return;
        }

        console.log('[AuthCallback] Session démarrée pour', payload.uid);
        clearCallbackHistory();

        navigate('/welcome', { replace: true });
      } catch (error) {
        console.error('[AuthCallback] Erreur lors du traitement du token:', error);
        setError('Erreur lors de la connexion. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    handleCallback();
  }, [location, navigate]);

  const handleManualRetry = () => {
    clearCallbackHistory();
    healAuthState();
    navigate('/login', { replace: true });
  };

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
          <div style={{ color: 'red', fontSize: '18px', maxWidth: '480px', textAlign: 'center' }}>{error}</div>
          {stopped ? (
            <>
              <div style={{ color: '#555', maxWidth: '480px', textAlign: 'center' }}>
                Vérifiez que l'heure de la box et celle de cet appareil sont correctes, puis réessayez.
              </div>
              <button
                type="button"
                onClick={handleManualRetry}
                style={{
                  padding: '12px 24px',
                  background: '#1976d2',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '15px',
                  fontWeight: 600
                }}
              >
                Réessayer la connexion
              </button>
            </>
          ) : (
            <div>Redirection vers la page de connexion...</div>
          )}
        </>
      ) : null}
    </div>
  );
};

export default AuthCallback;
