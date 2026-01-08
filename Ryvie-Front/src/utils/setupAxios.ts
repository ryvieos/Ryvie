import axios from 'axios';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode, setAccessMode as setGlobalAccessMode } from './detectAccessMode';
import { getSessionInfo, setToken, endSession } from './sessionManager';

export const verifyToken = async (): Promise<boolean> => {
  const token = (getSessionInfo() || {}).token;
  if (!token) return false;
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    const payload = JSON.parse(json);
    if (!payload?.exp) return true;
    return Date.now() < payload.exp * 1000;
  } catch (e) {
    return false;
  }
};

export const handleTokenError = (errorCode: string | null = null): void => {
  console.log('Token expiré ou invalide, redirection vers la page de connexion', { errorCode });
  
  if (errorCode === 'INVALID_TOKEN') {
    console.warn('[auth] Token signature invalid - JWT secret may have been rotated');
  } else if (errorCode === 'EXPIRED_TOKEN') {
    console.warn('[auth] Token expired - user needs to re-authenticate');
  }
  
  const accessMode = getCurrentAccessMode() || 'private';
  endSession();
  setGlobalAccessMode(accessMode);
  
  localStorage.removeItem('loginAttempts');
  localStorage.removeItem('blockUntil');
  
  const redirectToLogin = () => {
    const loginHash = '#/login';
    const loginPath = '/login';
    console.log('Redirecting to login page:', loginHash);
    
    try {
      if (typeof window !== 'undefined' && window.location?.hash?.includes(loginHash)) {
        return;
      }
    } catch { }

    try {
      const inIframe = typeof window !== 'undefined' && window.top && window.top !== window.self;
      if (inIframe) {
        try {
          window.parent.postMessage({ type: 'CLOSE_OVERLAY_AND_NAVIGATE', path: loginPath }, '*');
          return;
        } catch (e) {
          console.warn('Failed to postMessage to parent, falling back to local redirect:', e);
        }
      } else {
        try {
          window.postMessage({ type: 'CLOSE_OVERLAY_AND_NAVIGATE', path: loginPath }, '*');
        } catch {}
      }
    } catch {}

    if ((window as any).electronAPI) {
      console.log('Using Electron API to redirect');
      (window as any).electronAPI.redirectToLogin()
        .then(() => console.log('Redirected successfully in Electron'))
        .catch((err: any) => {
          console.error('Failed to redirect in Electron, falling back to window.location:', err);
          try { window.location.hash = loginHash; } catch { }
        });
    } else {
      console.log('Using window.location to redirect');
      try { window.location.hash = loginHash; } catch { }
    }
  };

  setTimeout(redirectToLogin, 100);
};

axios.interceptors.request.use(request => {
  const accessMode = getCurrentAccessMode() || 'private';
  
  if (!request.timeout) {
    if (accessMode === 'private') {
      request.timeout = 10000;
    } else {
      request.timeout = 5000;
    }
  }
  
  return request;
}, error => {
  return Promise.reject(error);
});

axios.interceptors.response.use(
  response => response,
  async error => {
    const originalRequest = error.config || {};
    if (error.response) {
      if (error.response.status === 401) {
        const errorCode = error.response.data?.code || null;
        console.log('Authentication error detected:', {
          status: error.response.status,
          code: errorCode,
          path: originalRequest.url,
          method: originalRequest.method,
          hasAuthHeader: !!originalRequest.headers?.Authorization
        });

        const isApi = originalRequest.url?.includes('/api/');
        const isAuthEndpoint = (
          originalRequest.url?.includes('/api/auth') ||
          originalRequest.url?.includes('/api/refresh-token')
        );
        const hadAuth = !!originalRequest.headers?.Authorization;
        const notRetried = !originalRequest._retry;
        const shouldTryRefresh = isApi && !isAuthEndpoint && hadAuth && notRetried;

        if (shouldTryRefresh) {
          const accessMode = getCurrentAccessMode() || 'private';
          const serverUrl = getServerUrl(accessMode);
          const currentToken = (getSessionInfo() || {}).token;
          if (currentToken) {
            try {
              originalRequest._retry = true;
              const refreshResp = await axios.post(`${serverUrl}/api/refresh-token`, { token: currentToken }, {
                headers: { Authorization: undefined }
              });
              const newToken = refreshResp.data?.token;
              if (newToken) {
                setToken(newToken);
                originalRequest.headers = {
                  ...(originalRequest.headers || {}),
                  Authorization: `Bearer ${newToken}`
                };
                return axios(originalRequest);
              }
            } catch (refreshErr: any) {
              console.warn('Token refresh failed:', refreshErr?.response?.data || refreshErr?.message);
              handleTokenError(errorCode || refreshErr?.response?.data?.code || null);
              return Promise.reject(error);
            }
          }
        }

        if (hadAuth) {
          handleTokenError(errorCode);
        }
      }
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Request setup error:', error.message);
    }

    return Promise.reject(error);
  }
);

export default axios;
