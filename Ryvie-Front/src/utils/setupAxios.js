import axios from 'axios';
import { logout } from '../services/authService';
import { getServerUrl } from '../config/urls';

// Fonction pour vérifier si le token est valide
export const verifyToken = async () => {
  try {
    const token = localStorage.getItem('jwt_token');
    if (!token) return false;
    
    const accessMode = localStorage.getItem('accessMode') || 'private';
    const serverUrl = getServerUrl(accessMode);
    
    // Appel au serveur pour vérifier la validité du token
    await axios.get(`${serverUrl}/api/users`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    
    return true; // Si aucune erreur n'est levée, le token est valide
  } catch (error) {
    if (error.response && error.response.status === 401) {
      // Token invalide ou expiré
      handleTokenError();
      return false;
    }
    // Autres erreurs (serveur non disponible, etc.)
    return false;
  }
};

// Fonction pour gérer les erreurs de token
export const handleTokenError = (errorCode = null) => {
  console.log('Token expiré ou invalide, redirection vers la page de connexion', { errorCode });
  
  // Log specific error types for debugging
  if (errorCode === 'INVALID_TOKEN') {
    console.warn('[auth] Token signature invalid - JWT secret may have been rotated');
  } else if (errorCode === 'EXPIRED_TOKEN') {
    console.warn('[auth] Token expired - user needs to re-authenticate');
  }
  
  // Nettoyer les données d'authentification mais garder le mode d'accès
  const accessMode = localStorage.getItem('accessMode') || 'private';
  logout();
  localStorage.setItem('accessMode', accessMode); // Restaurer le mode d'accès
  
  // Clear any failed login attempts on token error (fresh start)
  localStorage.removeItem('loginAttempts');
  localStorage.removeItem('blockUntil');
  
  // Rediriger vers la page de connexion
  const redirectToLogin = () => {
    const loginUrl = '/userlogin';
    console.log('Redirecting to login page:', loginUrl);
    
    if (window.electronAPI) {
      // In Electron environment, use IPC to redirect
      console.log('Using Electron API to redirect');
      window.electronAPI.redirectToLogin()
        .then(() => console.log('Redirected successfully in Electron'))
        .catch(err => {
          console.error('Failed to redirect in Electron, falling back to window.location:', err);
          window.location.href = loginUrl;
        });
    } else {
      // In browser environment
      console.log('Using window.location to redirect');
      window.location.href = loginUrl;
    }
  };

  // Add a small delay to ensure any pending operations complete
  setTimeout(redirectToLogin, 100);
};

// Configuration des délais de timeout pour les requêtes axios
// Augmenter les timeouts pour le mode privé pour donner plus de temps au serveur local de répondre
axios.interceptors.request.use(request => {
  const accessMode = localStorage.getItem('accessMode') || 'private';
  
  // Augmenter le timeout pour le mode privé car le serveur local peut prendre plus de temps à répondre
  if (accessMode === 'private') {
    request.timeout = 10000; // 10 secondes pour le mode privé
  } else {
    request.timeout = 5000; // 5 secondes pour le mode public
  }
  
  return request;
}, error => {
  return Promise.reject(error);
});

// Intercepteur pour gérer les erreurs d'authentification avec rafraîchissement automatique du token
axios.interceptors.response.use(
  response => response,
  async error => {
    const originalRequest = error.config || {};
    if (error.response) {
      // 401 Unauthorized
      if (error.response.status === 401) {
        const errorCode = error.response.data?.code || null;
        console.log('Authentication error detected:', {
          status: error.response.status,
          code: errorCode,
          path: originalRequest.url,
          method: originalRequest.method,
          hasAuthHeader: !!originalRequest.headers?.Authorization
        });

        // Conditions pour tenter un refresh:
        // - Appel API (pas l'endpoint d'auth classique)
        // - La requête avait un header Authorization (donc un token était présent)
        // - Pas déjà retentée (_retry flag)
        // - Code explicite EXPIRED_TOKEN ou TOKEN_ERROR, ou pas de code mais 401 avec Authorization
        const isApi = originalRequest.url?.includes('/api/');
        const isAuthEndpoint = originalRequest.url?.includes('/api/auth');
        const hadAuth = !!originalRequest.headers?.Authorization;
        const notRetried = !originalRequest._retry;
        const shouldTryRefresh = isApi && !isAuthEndpoint && hadAuth && notRetried;

        if (shouldTryRefresh) {
          const accessMode = localStorage.getItem('accessMode') || 'private';
          const serverUrl = getServerUrl(accessMode);
          const currentToken = localStorage.getItem('jwt_token');
          if (currentToken) {
            try {
              originalRequest._retry = true;
              // Demander un nouveau token
              const refreshResp = await axios.post(`${serverUrl}/api/refresh-token`, { token: currentToken }, {
                // Ne pas inclure automatiquement l'ancien header Authorization
                headers: { Authorization: undefined }
              });
              const newToken = refreshResp.data?.token;
              if (newToken) {
                // Mettre à jour le stockage et les headers par défaut
                localStorage.setItem('jwt_token', newToken);
                axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
                // Mettre à jour le header de la requête originale et la relancer
                originalRequest.headers = {
                  ...(originalRequest.headers || {}),
                  Authorization: `Bearer ${newToken}`
                };
                return axios(originalRequest);
              }
            } catch (refreshErr) {
              console.warn('Token refresh failed:', refreshErr?.response?.data || refreshErr?.message);
              // Si le refresh échoue, déconnecter proprement
              handleTokenError(errorCode || refreshErr?.response?.data?.code || null);
              return Promise.reject(error);
            }
          }
        }

        // Si on ne tente pas ou si on ne peut pas rafraîchir, gérer l'erreur de token
        if (hadAuth) {
          handleTokenError(errorCode);
        }
      }
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Request setup error:', error.message);
    }

    return Promise.reject(error);
  }
);

export default axios;
