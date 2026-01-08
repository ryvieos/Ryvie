import axios from '../utils/setupAxios';

const TOKEN_KEY = 'jwt_token';
const USER_KEY = 'currentUser';
const USER_ROLE_KEY = 'currentUserRole';
const USER_EMAIL_KEY = 'currentUserEmail';
const SESSION_ACTIVE_KEY = 'sessionActive';

export const setAuthToken = (token: string | null): void => {
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common['Authorization'];
  }
};

export const initializeToken = (): boolean => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    setAuthToken(token);
    return true;
  }
  return false;
};

export const isAuthenticated = (): boolean => {
  const hasToken = !!localStorage.getItem(TOKEN_KEY);
  const urlParams = new URLSearchParams(window.location.search);
  const urlUser = urlParams.get('user');
  const urlRole = urlParams.get('role');
  return hasToken || (!!urlUser && !!urlRole);
};

export const getCurrentUser = (): { name: string; role: string; email: string | null; fromUrl?: boolean } | null => {
  const user = localStorage.getItem(USER_KEY);
  const role = localStorage.getItem(USER_ROLE_KEY);
  const email = localStorage.getItem(USER_EMAIL_KEY);
  
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

export const logout = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(USER_ROLE_KEY);
  localStorage.removeItem(USER_EMAIL_KEY);
  setAuthToken(null);
};

export const getAuthConfig = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  return {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };
};

export const handleAuthError = (error: any): boolean => {
  if (error.config && error.config.url && error.config.url.includes('/api/server-status')) {
    console.log('Erreur de vérification du serveur ignorée pour l\'authentification');
    return false;
  }

  if (typeof window !== 'undefined' && window.location.hash.includes('#/login')) {
    return false;
  }
  
  if (error.response && error.response.status === 401) {
    console.log('Session expirée ou erreur d\'authentification. Déconnexion automatique...');
    
    logout();
    
    if (!window.location.hash.includes('#/login')) {
      window.location.href = '#/login';
    }
    
    return true;
  }
  
  return false;
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
