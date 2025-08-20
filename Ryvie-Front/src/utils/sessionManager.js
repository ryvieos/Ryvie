/**
 * Gestionnaire de sessions pour l'application Ryvie
 * Compatible web et Electron avec gestion des cookies et tokens JWT
 */

import { StorageManager, isElectron } from './platformUtils';
import axios from 'axios';

/**
 * Gestionnaire de sessions unifié
 */
export class SessionManager {
  constructor() {
    this.tokenKey = 'jwt_token';
    this.userKey = 'currentUser';
    this.userRoleKey = 'currentUserRole';
    this.userEmailKey = 'currentUserEmail';
    this.sessionActiveKey = 'sessionActive';
    this.sessionStartKey = 'sessionStartTime';
  }

  /**
   * Démarre une nouvelle session utilisateur
   * @param {Object} userData - Données utilisateur
   * @param {string} userData.token - Token JWT
   * @param {string} userData.userId - ID utilisateur
   * @param {string} userData.userName - Nom utilisateur
   * @param {string} userData.userRole - Rôle utilisateur
   * @param {string} userData.userEmail - Email utilisateur
   */
  startSession(userData) {
    const { token, userId, userName, userRole, userEmail } = userData;
    
    // Stocker les informations de session
    StorageManager.setItem(this.tokenKey, token);
    StorageManager.setItem(this.userKey, userName || userId);
    StorageManager.setItem(this.userRoleKey, userRole || 'User');
    StorageManager.setItem(this.userEmailKey, userEmail || '');
    StorageManager.setItem(this.sessionActiveKey, true);
    StorageManager.setItem(this.sessionStartKey, new Date().toISOString());
    
    // Configurer axios pour inclure le token dans toutes les requêtes
    this.setAuthHeader(token);
    
    console.log(`[SessionManager] Session démarrée pour ${userName || userId}`);
    
    // En web, gérer les cookies pour la persistance entre onglets
    if (!isElectron()) {
      this.setCookie('ryvie_session', token, 7); // 7 jours
      this.setCookie('ryvie_user', userName || userId, 7);
    }
  }

  /**
   * Termine la session actuelle
   */
  endSession() {
    const currentUser = this.getCurrentUser();
    
    // Supprimer les informations de session
    StorageManager.removeItem(this.tokenKey);
    StorageManager.removeItem(this.userKey);
    StorageManager.removeItem(this.userRoleKey);
    StorageManager.removeItem(this.userEmailKey);
    StorageManager.removeItem(this.sessionActiveKey);
    StorageManager.removeItem(this.sessionStartKey);
    
    // Supprimer l'en-tête d'autorisation
    delete axios.defaults.headers.common['Authorization'];
    
    console.log(`[SessionManager] Session terminée pour ${currentUser}`);
    
    // En web, supprimer les cookies
    if (!isElectron()) {
      this.deleteCookie('ryvie_session');
      this.deleteCookie('ryvie_user');
    }
  }

  /**
   * Vérifie si une session est active
   * @returns {boolean}
   */
  isSessionActive() {
    const hasToken = !!this.getToken();
    const hasUser = !!this.getCurrentUser();
    const sessionActive = StorageManager.getItem(this.sessionActiveKey, false);
    
    return hasToken && hasUser && sessionActive;
  }

  /**
   * Récupère le token JWT actuel
   * @returns {string|null}
   */
  getToken() {
    let token = StorageManager.getItem(this.tokenKey);
    
    // En web, essayer aussi de récupérer depuis les cookies
    if (!token && !isElectron()) {
      token = this.getCookie('ryvie_session');
    }
    
    return token;
  }

  /**
   * Récupère l'utilisateur actuel
   * @returns {string|null}
   */
  getCurrentUser() {
    let user = StorageManager.getItem(this.userKey);
    
    // En web, essayer aussi de récupérer depuis les cookies
    if (!user && !isElectron()) {
      user = this.getCookie('ryvie_user');
    }
    
    return user;
  }

  /**
   * Récupère le rôle de l'utilisateur actuel
   * @returns {string}
   */
  getCurrentUserRole() {
    return StorageManager.getItem(this.userRoleKey, 'User');
  }

  /**
   * Récupère l'email de l'utilisateur actuel
   * @returns {string}
   */
  getCurrentUserEmail() {
    return StorageManager.getItem(this.userEmailKey, '');
  }

  /**
   * Récupère les informations complètes de la session
   * @returns {Object}
   */
  getSessionInfo() {
    return {
      isActive: this.isSessionActive(),
      token: this.getToken(),
      user: this.getCurrentUser(),
      userRole: this.getCurrentUserRole(),
      userEmail: this.getCurrentUserEmail(),
      startTime: StorageManager.getItem(this.sessionStartKey),
      platform: isElectron() ? 'electron' : 'web'
    };
  }

  /**
   * Configure l'en-tête d'autorisation pour axios
   * @param {string} token - Token JWT
   */
  setAuthHeader(token) {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    }
  }

  /**
   * Initialise la session au démarrage de l'application
   */
  initializeSession() {
    const token = this.getToken();
    if (token) {
      this.setAuthHeader(token);
      console.log('[SessionManager] Session restaurée depuis le stockage');
    }
  }

  /**
   * Valide le token JWT (vérifie s'il n'est pas expiré)
   * @param {string} token - Token à valider
   * @returns {boolean}
   */
  validateToken(token) {
    if (!token) return false;
    
    try {
      // Décoder le payload du JWT (partie centrale)
      const payload = JSON.parse(atob(token.split('.')[1]));
      const now = Math.floor(Date.now() / 1000);
      
      // Vérifier si le token n'est pas expiré
      return payload.exp > now;
    } catch (error) {
      console.error('[SessionManager] Erreur lors de la validation du token:', error);
      return false;
    }
  }

  /**
   * Rafraîchit automatiquement le token si nécessaire
   * @param {string} refreshEndpoint - Endpoint pour rafraîchir le token
   */
  async refreshTokenIfNeeded(refreshEndpoint) {
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

  // Méthodes utilitaires pour les cookies (web uniquement)
  setCookie(name, value, days) {
    if (isElectron()) return;
    
    const expires = new Date();
    expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=Lax`;
  }

  getCookie(name) {
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

  deleteCookie(name) {
    if (isElectron()) return;
    
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
  }
}

// Instance singleton
export const sessionManager = new SessionManager();

// Fonctions utilitaires exportées
export const startSession = (userData) => sessionManager.startSession(userData);
export const endSession = () => sessionManager.endSession();
export const isSessionActive = () => sessionManager.isSessionActive();
export const getCurrentUser = () => sessionManager.getCurrentUser();
export const getCurrentUserRole = () => sessionManager.getCurrentUserRole();
export const getSessionInfo = () => sessionManager.getSessionInfo();
export const initializeSession = () => sessionManager.initializeSession();

export default sessionManager;
