import { StorageManager, isElectron } from './platformUtils';
import axios from './setupAxios';

interface UserData {
  token: string;
  userId: string;
  userName: string;
  userRole: string;
  userEmail?: string;
}

interface SessionInfo {
  isActive: boolean;
  token: string | null;
  user: string | null;
  userRole: string;
  userEmail: string;
  startTime: string | null;
  platform: 'electron' | 'web';
}

export class SessionManager {
  private tokenKey = 'jwt_token';
  private userKey = 'currentUser';
  private userRoleKey = 'currentUserRole';
  private userEmailKey = 'currentUserEmail';
  private sessionActiveKey = 'sessionActive';
  private sessionStartKey = 'sessionStartTime';

  startSession(userData: UserData): void {
    const { token, userId, userName, userRole, userEmail } = userData;
    
    StorageManager.setItem(this.tokenKey, token);
    StorageManager.setItem(this.userKey, userName || userId);
    StorageManager.setItem(this.userRoleKey, userRole || 'User');
    StorageManager.setItem(this.userEmailKey, userEmail || '');
    StorageManager.setItem(this.sessionActiveKey, true);
    StorageManager.setItem(this.sessionStartKey, new Date().toISOString());
    
    this.setAuthHeader(token);
    
    console.log(`[SessionManager] Session démarrée pour ${userName || userId}`);
    
    if (!isElectron()) {
      this.setCookie('ryvie_session', token, 7);
      this.setCookie('ryvie_user', userName || userId, 7);
    }
  }

  endSession(): void {
    const currentUser = this.getCurrentUser();
    
    StorageManager.removeItem(this.tokenKey);
    StorageManager.removeItem(this.userKey);
    StorageManager.removeItem(this.userRoleKey);
    StorageManager.removeItem(this.userEmailKey);
    StorageManager.removeItem(this.sessionActiveKey);
    StorageManager.removeItem(this.sessionStartKey);
    
    delete axios.defaults.headers.common['Authorization'];
    
    console.log(`[SessionManager] Session terminée pour ${currentUser}`);
    
    if (!isElectron()) {
      this.deleteCookie('ryvie_session');
      this.deleteCookie('ryvie_user');
    }
  }

  isSessionActive(): boolean {
    const token = this.getToken();
    const hasToken = !!token;
    const hasUser = !!this.getCurrentUser();
    const sessionActive = StorageManager.getItem<boolean>(this.sessionActiveKey, false) || false;
    
    return hasToken && hasUser && sessionActive;
  }

  getToken(): string | null {
    let token = StorageManager.getItem<string>(this.tokenKey);
    
    if (!token && !isElectron()) {
      token = this.getCookie('ryvie_session');
    }
    
    return token;
  }

  getCurrentUser(): string | null {
    let user = StorageManager.getItem<string>(this.userKey);
    
    if (!user && !isElectron()) {
      user = this.getCookie('ryvie_user');
    }
    
    return user;
  }

  setCurrentUserName(name: string): void {
    if (!name) return;
    StorageManager.setItem(this.userKey, name);
    if (!isElectron()) {
      this.setCookie('ryvie_user', name, 7);
    }
  }

  getCurrentUserRole(): string {
    return StorageManager.getItem<string>(this.userRoleKey, 'User') || 'User';
  }

  getCurrentUserEmail(): string {
    return StorageManager.getItem<string>(this.userEmailKey, '') || '';
  }

  getSessionInfo(): SessionInfo {
    return {
      isActive: this.isSessionActive(),
      token: this.getToken(),
      user: this.getCurrentUser(),
      userRole: this.getCurrentUserRole(),
      userEmail: this.getCurrentUserEmail(),
      startTime: StorageManager.getItem<string>(this.sessionStartKey),
      platform: isElectron() ? 'electron' : 'web'
    };
  }

  setAuthHeader(token: string): void {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    }
  }

  setToken(newToken: string): void {
    if (!newToken) return;
    StorageManager.setItem(this.tokenKey, newToken);
    this.setAuthHeader(newToken);
    if (!isElectron()) {
      this.setCookie('ryvie_session', newToken, 7);
    }
  }

  initializeSession(): void {
    const token = this.getToken();
    if (token) {
      this.setAuthHeader(token);
      console.log('[SessionManager] Session restaurée depuis le stockage');
    }
  }

  validateToken(token: string): boolean {
    if (!token) return false;
    
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const now = Math.floor(Date.now() / 1000);
      
      return payload.exp > now;
    } catch (error) {
      console.error('[SessionManager] Erreur lors de la validation du token:', error);
      return false;
    }
  }

  async refreshTokenIfNeeded(refreshEndpoint: string): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;
    
    if (!this.validateToken(token)) {
      try {
        const response = await axios.post(refreshEndpoint, {}, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.data && response.data.token) {
          StorageManager.setItem(this.tokenKey, response.data.token);
          this.setAuthHeader(response.data.token);
          console.log('[SessionManager] Token rafraîchi avec succès');
          return true;
        }
      } catch (error) {
        console.error('[SessionManager] Erreur lors du rafraîchissement du token:', error);
        this.endSession();
      }
    }
    
    return false;
  }

  private setCookie(name: string, value: string, days: number): void {
    if (isElectron()) return;
    
    const expires = new Date();
    expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=Lax`;
  }

  private getCookie(name: string): string | null {
    if (isElectron()) return null;
    
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
  }

  private deleteCookie(name: string): void {
    if (isElectron()) return;
    
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
  }
}

export const sessionManager = new SessionManager();

export const startSession = (userData: UserData) => sessionManager.startSession(userData);
export const getSessionInfo = () => sessionManager.getSessionInfo();
export const initializeSession = () => sessionManager.initializeSession();
export const isSessionActive = () => sessionManager.isSessionActive();
export const getCurrentUser = () => sessionManager.getCurrentUser();
export const getCurrentUserRole = () => sessionManager.getCurrentUserRole();
export const endSession = () => sessionManager.endSession();
export const setCurrentUserName = (name: string) => sessionManager.setCurrentUserName(name);
export const setToken = (token: string) => sessionManager.setToken(token);

export default sessionManager;
