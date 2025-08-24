import axios from 'axios';

// Clés utilisées pour le stockage dans localStorage
const TOKEN_KEY = 'jwt_token';
const USER_KEY = 'currentUser';
const USER_ROLE_KEY = 'currentUserRole';
const USER_EMAIL_KEY = 'currentUserEmail';
const SESSION_ACTIVE_KEY = 'sessionActive';

// Configure axios pour inclure le token dans les en-têtes
export const setAuthToken = (token) => {
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
};

// Initialiser le token au chargement de l'application
export const initializeToken = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    setAuthToken(token);
    return true;
  }
  return false;
};

// Vérifier si l'utilisateur est authentifié
export const isAuthenticated = () => {
  const hasToken = !!localStorage.getItem(TOKEN_KEY);
  // Vérifier également les paramètres d'URL pour le mode public
  const urlParams = new URLSearchParams(window.location.search);
  const urlUser = urlParams.get('user');
  const urlRole = urlParams.get('role');
  return hasToken || (urlUser && urlRole);
};

// Récupérer les informations de l'utilisateur actuel
export const getCurrentUser = () => {
  const user = localStorage.getItem(USER_KEY);
  const role = localStorage.getItem(USER_ROLE_KEY);
  const email = localStorage.getItem(USER_EMAIL_KEY);
  
  // Si les données ne sont pas dans localStorage, vérifier les paramètres d'URL
  if (!user) {
    const urlParams = new URLSearchParams(window.location.search);
    const urlUser = urlParams.get('user');
    const urlRole = urlParams.get('role');
    
    if (urlUser && urlRole) {
      return {
        name: urlUser,
        role: urlRole,
        email: null,
        fromUrl: true
      };
    }
    return null;
  }
  
  return {
    name: user,
    role: role || 'User',
    email: email || null,
    fromUrl: false
  };
};

// Gérer la déconnexion
export const logout = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(USER_ROLE_KEY);
  localStorage.removeItem(USER_EMAIL_KEY);
  setAuthToken(null);
};

// Définir la configuration pour une requête authentifiée
export const getAuthConfig = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  return {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };
};

// Gérer les erreurs d'authentification et rediriger vers la page de connexion si nécessaire
export const handleAuthError = (error) => {
  // Vérifier si c'est une erreur d'authentification (401) ou une ressource non trouvée (404)
  if (error.response && (error.response.status === 401 || error.response.status === 404)) {
    console.log('Session expirée ou erreur d\'authentification. Déconnexion automatique...');
    
    // Déconnecter l'utilisateur
    logout();
    
    // Rediriger vers la page de connexion
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    
    return true; // Indique que l'erreur a été traitée comme une erreur d'authentification
  }
  
  return false; // Indique que ce n'est pas une erreur d'authentification
};

export default {
  setAuthToken,
  initializeToken,
  isAuthenticated,
  getCurrentUser,
  logout,
  getAuthConfig,
  handleAuthError
};
