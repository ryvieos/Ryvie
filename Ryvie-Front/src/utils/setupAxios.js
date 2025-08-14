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
  console.log('Token expiré ou invalide, redirection vers la page de connexion');
  
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
  if (window.electronAPI) {
    // Dans un environnement Electron, fermer la fenêtre actuelle
    // Ne pas créer de nouvelle fenêtre sans token valide
    window.electronAPI.closeCurrentWindow();
  } else {
    // Dans un environnement navigateur
    window.location.href = '/userlogin';
  }
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

// Intercepteur pour gérer les erreurs d'authentification
axios.interceptors.response.use(
  response => response,
  error => {
    // Si l'erreur est de type 401 (Unauthorized) ET que la requête avait un token Authorization,
    // cela signifie que le token est expiré ou invalide
    if (error.response && 
        error.response.status === 401 && 
        error.config && 
        error.config.headers && 
        error.config.headers.Authorization) {
      handleTokenError();
    }
    
    return Promise.reject(error);
  }
);

export default axios;
