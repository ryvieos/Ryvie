import React, { useState, useEffect, useRef } from 'react';
import '../styles/User.css';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { getCurrentUserRole, getCurrentUser, getSessionInfo } from '../utils/sessionManager';
import { sessionManager } from '../utils/sessionManager';
import { useLanguage } from '../contexts/LanguageContext';

const User = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();

  // Liste des utilisateurs récupérée depuis l'API
  const [users, setUsers] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [newUser, setNewUser] = useState({ 
    name: '', 
    email: '', 
    role: 'User',
    uid: '',
    cn: '',
    sn: '',
    mail: '',
    password: '',
    confirmPassword: ''
  });
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [loading, setLoading] = useState(true); // Indicateur de chargement
  const [error, setError] = useState(null); // Gestion des erreurs
  const [accessMode, setAccessMode] = useState(null);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [showAdminAuthModal, setShowAdminAuthModal] = useState(false);
  const [adminCredentials, setAdminCredentials] = useState({ uid: '', password: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDeleteAuthModal, setShowDeleteAuthModal] = useState(false);
  const [userToDelete, setUserToDelete] = useState(null);
  // Rôle courant pour contrôler l'affichage (gestion visible uniquement pour Admin)
  const [userRole, setUserRole] = useState('User');
  const isAdmin = String(userRole || '').toLowerCase() === 'admin';

  useEffect(() => {
    const role = getCurrentUserRole() || 'User';
    setUserRole(role);
  }, []);

  // Helper: generate uid from a display name (lowercase, no accents, spaces->- , allowed [a-z0-9_-])
  const toUid = (value) => {
    if (!value) return '';
    // normalize accents, lowercase, replace spaces with hyphens, remove invalid chars
    let v = value
      .normalize('NFD')
      .replace(/\p{Diacritic}+/gu, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '');
    return v;
  };
  
  // Références pour les animations
  const topBarRef = useRef(null);
  const userListRef = useRef(null);
  const userFormRef = useRef(null);
  
  // Animation d'entrée
  useEffect(() => {
    // Effet d'animation séquentiel
    const topBarElement = topBarRef.current;
    const userListElement = userListRef.current;
    
    if (topBarElement) {
      topBarElement.style.opacity = '0';
      topBarElement.style.transform = 'translateY(-20px)';
      
      setTimeout(() => {
        topBarElement.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        topBarElement.style.opacity = '1';
        topBarElement.style.transform = 'translateY(0)';
      }, 100);
    }
    
    if (userListElement) {
      userListElement.style.opacity = '0';
      
      setTimeout(() => {
        userListElement.style.transition = 'opacity 0.8s ease';
        userListElement.style.opacity = '1';
      }, 400);
    }
    
    // Effet d'animation pour le formulaire quand il s'ouvre
    if (formOpen && userFormRef.current) {
      userFormRef.current.style.opacity = '0';
      userFormRef.current.style.transform = 'translateY(20px)';
      
      setTimeout(() => {
        userFormRef.current.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        userFormRef.current.style.opacity = '1';
        userFormRef.current.style.transform = 'translateY(0)';
      }, 100);
    }
  }, [formOpen]);

  // Fonction pour récupérer les utilisateurs depuis l'API
  const fetchUsers = async () => {
    try {
      setLoading(true);
      setMessage('');
      setError(null);
      // Récupérer le mode d'accès courant (sans le modifier si absent)
      let storedMode = getCurrentAccessMode();
      // Calculer un mode effectif pour les requêtes sans persister
      let effectiveMode = storedMode;
      if (!effectiveMode) {
        if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
          effectiveMode = 'public';
        } else {
          effectiveMode = 'private';
        }
      }
      setAccessMode(effectiveMode);
      
      // Utiliser l'URL du serveur en fonction du mode d'accès effectif
      const serverUrl = getServerUrl(effectiveMode);
      console.log("Connexion à :", serverUrl);
      
      // Essayer l'endpoint protégé si un token existe. En cas d'échec 401/403, fallback remote.
      const session = getSessionInfo() || {};
      const token = session.token;
      let response;
      if (token) {
        try {
          response = await axios.get(`${serverUrl}/api/users`, {
            headers: { Authorization: `Bearer ${token}` }
          });
        } catch (e) {
          if (e?.response?.status === 401 || e?.response?.status === 403) {
            console.warn('[users] Accès refusé à /api/users, bascule sur /api/users-remote');
            response = await axios.get(`${serverUrl}/api/users-public`);
            setMessage('Session limitée — affichage des utilisateurs remote.');
            setMessageType('warning');
          } else {
            throw e;
          }
        }
      } else {
        response = await axios.get(`${serverUrl}/api/users-public`);
      }

      // Mapping des utilisateurs sans forcer le rôle sur remote et injection du rôle de session pour l'utilisateur courant
      const sessionUser = (getCurrentUser() || '').trim().toLowerCase();
      const sessionRole = getCurrentUserRole();
      const mapped = (response.data || []).map((user, index) => {
        const u = {
          id: index + 1,
          name: user.name || user.cn || user.uid,
          email: user.email || user.mail || 'Non défini',
          role: user.role || '',
          uid: user.uid
        };
        const matchById = String(u.uid || '').trim().toLowerCase() === sessionUser;
        const matchByName = String(u.name || '').trim().toLowerCase() === sessionUser;
        if (!u.role && (matchById || matchByName) && sessionRole) {
          u.role = sessionRole;
        }
        return u;
      });

      setUsers(mapped);
      setLoading(false);
      return;
    } catch (err) {
      console.error('Erreur lors du chargement des utilisateurs:', err);
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message || 'Inconnue';
      if (status === 401) {
        setMessage('Session expirée ou non authentifiée. Veuillez vous reconnecter.');
        setMessageType('error');
      } else if (status === 403) {
        setMessage('Accès refusé. Vous n\'avez pas les droits nécessaires.');
        setMessageType('error');
      } else {
        setMessage(`Erreur lors du chargement des utilisateurs (${status || 'réseau'}): ${detail}`);
        setMessageType('error');
      }
      setError('Erreur lors du chargement des utilisateurs');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleRoleChange = (id, role) => {
    setUsers(users.map((user) => (user.id === id ? { ...user, role } : user)));
  };

  const confirmDeleteUser = (user) => {
    // Interdire la suppression de soi-même côté UI
    const currentUser = getCurrentUser() || '';
    if (
      user?.uid && currentUser &&
      String(user.uid).trim().toLowerCase() === String(currentUser).trim().toLowerCase()
    ) {
      setMessage("Vous ne pouvez pas supprimer votre propre compte");
      setMessageType('error');
      return;
    }
    setConfirmDelete(user);
  };

  const openEditUserForm = (user) => {
    setEditUser(user);
    setNewUser({ 
      name: user.name,
      email: user.email,
      role: user.role,
      uid: user.uid,
      cn: user.name,
      sn: user.name.split(' ').pop() || user.name,
      mail: user.email,
      password: '',
      confirmPassword: ''
    });
    setFormOpen(true);
    setMessage('');
  };

  const openAddUserForm = () => {
    setEditUser(null);
    setNewUser({ 
      name: '', 
      email: '', 
      role: 'User',
      uid: '',
      cn: '',
      sn: '',
      mail: '',
      password: '',
      confirmPassword: ''
    });
    setFormOpen(true);
    setMessage('');
  };

  const validateUserForm = () => {
    // Validation des champs obligatoires
    if (!newUser.name.trim()) {
      setMessage('Le nom complet est requis');
      setMessageType('error');
      return false;
    }
    
    // En mode ajout, l'UID est identique au nom saisi
    if (!editUser) {
      const candidate = newUser.name;
      if (!candidate) {
        setMessage('Nom invalide pour générer un identifiant (uid)');
        setMessageType('error');
        return false;
      }
    } else {
      // En mode édition, l'UID est en lecture seule mais on vérifie sa présence
      if (!newUser.uid.trim()) {
        setMessage('L\'identifiant (uid) est requis');
        setMessageType('error');
        return false;
      }
    }
    
    if (!newUser.email.trim()) {
      setMessage('L\'email est requis');
      setMessageType('error');
      return false;
    }
    
    // Mot de passe requis uniquement lors de l'ajout d'un utilisateur
    if (!editUser && !newUser.password) {
      setMessage('Le mot de passe est requis');
      setMessageType('error');
      return false;
    }
    
    if (newUser.password !== newUser.confirmPassword) {
      setMessage('Les mots de passe ne correspondent pas');
      setMessageType('error');
      return false;
    }
    
    // Validation du format de l'email
    const emailRegex = /^([^\s@]+)@([^\s@]+)\.[^\s@]+$/;
    if (!emailRegex.test(newUser.email)) {
      setMessage('Format d\'email invalide');
      setMessageType('error');
      return false;
    }
    
    // Validation de l'identifiant (uid) - lettres, chiffres, tirets, underscores
    const uidRegex = /^[a-z0-9_-]+$/;
    const uidToCheck = editUser ? newUser.uid : newUser.name;
    if (!uidRegex.test(uidToCheck)) {
      setMessage('Le nom (utilisé comme identifiant) doit contenir uniquement des lettres minuscules, chiffres, tirets ou underscores');
      setMessageType('error');
      return false;
    }
    
    return true;
  };

  const handleAddUser = async () => {
    if (!validateUserForm()) {
      return;
    }

    // Vérifier si l'utilisateur existe déjà avant de demander l'auth admin
    const token = (getSessionInfo() || {}).token;
    if (!token) {
      setMessage('Session expirée ou non authentifiée. Veuillez vous reconnecter.');
      setMessageType('error');
      return;
    }

    try {
      const serverUrl = getServerUrl(accessMode || 'private');
      const checkResponse = await axios.post(
        `${serverUrl}/api/check-user-exists`,
        { uid: newUser.uid || newUser.name, email: newUser.email },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (checkResponse.data.exists) {
        setMessage(checkResponse.data.error || t('userManagement.userExists'));
        setMessageType('error');
        return;
      }
    } catch (err: any) {
      if (err.response?.status === 409) {
        setMessage(err.response.data?.error || t('userManagement.userExists'));
        setMessageType('error');
        return;
      }
      console.error('Erreur lors de la vérification de l\'utilisateur:', err);
      setMessage('Erreur lors de la vérification de l\'utilisateur');
      setMessageType('error');
      return;
    }

    // Si l'utilisateur n'existe pas, récupérer l'email de l'utilisateur actuel pour pré-remplir les identifiants admin
    const sessionInfo = getSessionInfo();
    const currentUserEmail = sessionInfo.userEmail || getCurrentUser() || '';
    
    // Pré-remplir les identifiants admin avec l'email de l'utilisateur actuel
    setAdminCredentials({ 
      uid: currentUserEmail,
      password: '' 
    });

    // Effacer le message d'erreur avant d'ouvrir le modal admin
    setMessage('');
    
    // Ouvrir le modal d'authentification admin
    setShowAdminAuthModal(true);
  };

  const handleUpdateUser = async () => {
    if (!validateUserForm()) {
      return;
    }

    // Pour la mise à jour, vérifier si l'email a changé et s'il est déjà utilisé
    if (editUser && newUser.email !== (editUser as any).email) {
      const token = (getSessionInfo() || {}).token;
      if (!token) {
        setMessage('Session expirée ou non authentifiée. Veuillez vous reconnecter.');
        setMessageType('error');
        return;
      }

      try {
        const serverUrl = getServerUrl(accessMode || 'private');
        const checkResponse = await axios.post(
          `${serverUrl}/api/check-user-exists`,
          { email: newUser.email },
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (checkResponse.data.exists) {
          setMessage(checkResponse.data.error || t('userManagement.userExists'));
          setMessageType('error');
          return;
        }
      } catch (err: any) {
        if (err.response?.status === 409) {
          setMessage(err.response.data?.error || t('userManagement.userExists'));
          setMessageType('error');
          return;
        }
        console.error('Erreur lors de la vérification de l\'email:', err);
        setMessage('Erreur lors de la vérification de l\'email');
        setMessageType('error');
        return;
      }
    }

    // Récupérer l'email de l'utilisateur actuel pour pré-remplir les identifiants admin
    const sessionInfo = getSessionInfo();
    const currentUserEmail = sessionInfo.userEmail || getCurrentUser() || '';
    
    // Pré-remplir les identifiants admin avec l'email de l'utilisateur actuel
    setAdminCredentials({ 
      uid: currentUserEmail,
      password: '' 
    });

    // Effacer le message d'erreur avant d'ouvrir le modal admin
    setMessage('');
    
    // Ouvrir le modal d'authentification admin
    setShowAdminAuthModal(true);
  };

  const submitUserWithAdminAuth = async () => {
    if (!adminCredentials.uid || !adminCredentials.password) {
      setMessage('Veuillez entrer vos identifiants administrateur');
      setMessageType('error');
      return;
    }

    // Vérifier la présence du token JWT pour les appels protégés
    const token = (getSessionInfo() || {}).token;
    if (!token) {
      setMessage('Session expirée ou non authentifiée. Veuillez vous reconnecter.');
      setMessageType('error');
      return;
    }

    setIsSubmitting(true);
    setMessage('');

    try {
      // Préparer les données communes pour l'API
      const commonPayload = {
        adminUid: adminCredentials.uid,
        adminPassword: adminCredentials.password,
      };

      // Utiliser l'URL du serveur en fonction du mode d'accès
      const serverUrl = getServerUrl(accessMode);
      let response;

      if (editUser) {
        // Mise à jour d'un utilisateur existant
        const updatePayload = {
          ...commonPayload,
          targetUid: editUser.uid,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
          ...(newUser.password ? { password: newUser.password } : {})
        };

        response = await axios.put(
          `${serverUrl}/api/update-user`,
          updatePayload,
          { headers: { Authorization: `Bearer ${token}` } }
        );
      } else {
        // Ajout d'un nouvel utilisateur
        const addPayload = {
          ...commonPayload,
          newUser: {
            cn: newUser.name,
            sn: newUser.name.split(' ').pop() || newUser.name,
            uid: newUser.uid,
            mail: newUser.email,
            password: newUser.password,
            role: newUser.role
          }
        };

        response = await axios.post(
          `${serverUrl}/api/add-user`,
          addPayload,
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }

      // Traitement de la réponse
      if (response.data && response.data.message) {
        // Fermer les modals et réinitialiser les états
        setFormOpen(false);
        setShowAdminAuthModal(false);
        setNewUser({ 
          name: '', 
          email: '', 
          role: 'User',
          uid: '',
          cn: '',
          sn: '',
          mail: '',
          password: '',
          confirmPassword: ''
        });
        setEditUser(null);
        setAdminCredentials({ uid: '', password: '' });
        
        // Afficher le message de succès
        setMessage(response.data.message);
        setMessageType('success');
        
        // Mise à jour de la liste des utilisateurs
        fetchUsers();
      }
    } catch (err) {
      console.error(`Erreur lors de ${editUser ? 'la mise à jour' : 'l\'ajout'} de l'utilisateur:`, err);
      
      // Gestion détaillée des erreurs
      if (err.response) {
        if (err.response.status === 401) {
          setMessage(err.response.data?.error || 'Identifiants administrateur incorrects');
        } else if (err.response.status === 403) {
          setMessage(err.response.data?.error || 'Vous n\'avez pas les droits administrateur nécessaires');
        } else if (err.response.status === 409) {
          setMessage(err.response.data?.error || 'Cet email est déjà utilisé par un autre compte');
        } else if (err.response.status === 404) {
          setMessage(err.response.data?.error || 'Utilisateur non trouvé');
        } else if (err.response.status === 400) {
          setMessage(err.response.data?.error || 'Données invalides. Vérifiez les champs requis.');
        } else {
          setMessage(err.response.data?.error || `Erreur lors de ${editUser ? 'la mise à jour' : 'l\'ajout'} de l'utilisateur`);
        }
      } else {
        setMessage('Erreur de connexion au serveur');
      }
      
      setMessageType('error');
      // Ne pas fermer le modal en cas d'erreur
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteUser = () => {
    if (!confirmDelete) return;

    // Récupérer l'email de l'utilisateur actuel pour pré-remplir les identifiants admin
    const sessionInfo = getSessionInfo();
    const currentUserEmail = sessionInfo.userEmail || getCurrentUser() || '';
    
    // Pré-remplir les identifiants admin avec l'email de l'utilisateur actuel
    setAdminCredentials({ 
      uid: currentUserEmail,
      password: '' 
    });
    
    // Stocker l'utilisateur à supprimer et ouvrir le modal d'authentification
    setUserToDelete(confirmDelete);
    setShowDeleteAuthModal(true);
    setConfirmDelete(null);
  };

  const deleteUserWithAdminAuth = async () => {
    if (!adminCredentials.uid || !adminCredentials.password || !userToDelete) {
      setMessage('Informations manquantes pour la suppression');
      setMessageType('error');
      return;
    }

    // Vérifier la présence du token JWT pour l'appel protégé
    const token = (getSessionInfo() || {}).token;
    if (!token) {
      setMessage('Session expirée ou non authentifiée. Veuillez vous reconnecter.');
      setMessageType('error');
      return;
    }

    setIsSubmitting(true);
    setMessage('');

    try {
      // Préparer les données pour l'API
      const payload = {
        adminUid: adminCredentials.uid,
        adminPassword: adminCredentials.password,
        uid: userToDelete.uid
      };

      // Utiliser l'URL du serveur en fonction du mode d'accès
      const serverUrl = getServerUrl(accessMode);
      
      // Appel à l'API pour supprimer l'utilisateur
      const response = await axios.post(
        `${serverUrl}/api/delete-user`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Traitement de la réponse
      if (response.data && response.data.message) {
        // Fermer le modal et réinitialiser les états
        setShowDeleteAuthModal(false);
        setUserToDelete(null);
        setAdminCredentials({ uid: '', password: '' });
        
        // Afficher le message de succès
        setMessage(response.data.message);
        setMessageType('success');
        
        // Mise à jour de la liste des utilisateurs
        fetchUsers();
      }
    } catch (err) {
      console.error('Erreur lors de la suppression de l\'utilisateur:', err);
      
      // Gestion détaillée des erreurs
      if (err.response) {
        if (err.response.status === 401) {
          setMessage(err.response.data?.error || 'Identifiants administrateur incorrects');
        } else if (err.response.status === 403) {
          setMessage(err.response.data?.error || 'Vous n\'avez pas les droits administrateur nécessaires');
        } else if (err.response.status === 404) {
          setMessage(err.response.data?.error || 'Utilisateur non trouvé');
        } else if (err.response.status === 400) {
          setMessage(err.response.data?.error || 'Données invalides pour la suppression');
        } else {
          setMessage(err.response.data?.error || 'Erreur lors de la suppression de l\'utilisateur');
        }
      } else {
        setMessage('Erreur de connexion au serveur');
      }
      
      setMessageType('error');
      // Ne pas fermer le modal en cas d'erreur
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="user-body">
        <div className="user-container">
          <div className="loading-container">
            <div className="loading-icon">👥</div>
            <div className="loading-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <p>{t('userManagement.loading')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="user-body">
        <div className="user-container">
          <div className="error-container">
            <div className="error-icon">⚠️</div>
            <h3>{t('userManagement.error')}</h3>
            <p>{error}</p>
            <button className="retry-button" onClick={fetchUsers}>
              🔄 {t('userManagement.retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="user-body">
      <div className="user-container">
        {/* Barre supérieure */}
        <div ref={topBarRef} className="top-bar">
          <div className="back-btn-container">
            <button className="back-btn" onClick={() => navigate('/home')}>
              ← {t('userManagement.back')}
            </button>
          </div>
          <div className="top-bar-content">
            <h1>👥 {t('userManagement.title')}</h1>
            <p>{t('userManagement.subtitle')}</p>
          </div>
          {isAdmin && (
            <div className="add-user-btn">
              <button type="button" onClick={openAddUserForm}>
                <span>➕</span> {t('userManagement.newUser')}
              </button>
            </div>
          )}
        </div>

        {/* Message de notification */}
        {message && (
          <div className={`notification-message ${messageType === 'error' ? 'error-message' : 'success-message'}`}>
            <p>{message}</p>
            <button className="close-notification" onClick={() => setMessage('')}>×</button>
          </div>
        )}

        {/* Formulaire d'ajout/modification d'utilisateur (Admin uniquement) */}
        {formOpen && isAdmin && (
          <div ref={userFormRef} className="modal-overlay" onMouseDown={() => setFormOpen(false)}>
            <div className="modal-content" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{editUser ? t('userManagement.editUser') : t('userManagement.addUser')}</h2>
                <button type="button" className="close-btn" onClick={() => setFormOpen(false)}>
                  ✖
                </button>
              </div>
              <div className="modal-body">
                {/* Affichage du message d'erreur dans le formulaire */}
                {message && messageType === 'error' && (
                  <div className="modal-error-message">
                    <p>{message}</p>
                  </div>
                )}
                
                <input
                  type="text"
                  placeholder={editUser ? t('userManagement.name') : t('userManagement.nameAsUid')}
                  value={newUser.name}
                  onChange={(e) => {
                    const nameVal = e.target.value;
                    if (editUser) {
                      setNewUser({ ...newUser, name: nameVal });
                    } else {
                      // En ajout, l'UID = nom exactement
                      setNewUser({ ...newUser, name: nameVal, uid: nameVal });
                    }
                  }}
                />
                {editUser && (
                  <input
                    type="text"
                    placeholder={t('userManagement.uid')}
                    value={newUser.uid}
                    onChange={(e) => setNewUser({ ...newUser, uid: e.target.value })}
                    disabled={!!editUser}
                    readOnly={!!editUser}
                    title={editUser ? t('userManagement.uidCannotBeChanged') : undefined}
                  />
                )}
                <input
                  type="email"
                  placeholder={t('userManagement.email')}
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value, mail: e.target.value })}
                />
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  className="role-select"
                >
                  <option value="User">{t('userManagement.user')}</option>
                  <option value="Admin">{t('userManagement.admin')}</option>
                  <option value="Guest">{t('userManagement.guest')}</option>
                </select>
                <input
                  type="password"
                  placeholder={t('userManagement.password')}
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
                <input
                  type="password"
                  placeholder={t('userManagement.confirmPassword')}
                  value={newUser.confirmPassword}
                  onChange={(e) => setNewUser({ ...newUser, confirmPassword: e.target.value })}
                />
                <button 
                  type="button"
                  className="submit-btn" 
                  onClick={editUser ? handleUpdateUser : handleAddUser}
                >
                  {editUser ? t('userManagement.edit') : t('userManagement.addUser')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal d'authentification admin */}
        {showAdminAuthModal && (
          <div className="modal-overlay" onMouseDown={() => !isSubmitting && setShowAdminAuthModal(false)}>
            <div className="modal-content admin-auth-modal" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('userManagement.authAdmin')}</h2>
                <button type="button" className="close-btn" onClick={() => !isSubmitting && setShowAdminAuthModal(false)}>
                  ✖
                </button>
              </div>
              <div className="modal-body">
                <p>{t('userManagement.authAdminAdd')}</p>
                
                {/* Affichage du message d'erreur dans le modal */}
                {message && messageType === 'error' && (
                  <div className="modal-error-message">
                    <p>{message}</p>
                  </div>
                )}
                
                <input
                  type="text"
                  placeholder="Identifiant admin"
                  value={adminCredentials.uid}
                  onChange={(e) => setAdminCredentials({ ...adminCredentials, uid: e.target.value })}
                  disabled={isSubmitting}
                  autoFocus
                />
                <input
                  type="password"
                  placeholder="Mot de passe admin"
                  value={adminCredentials.password}
                  onChange={(e) => setAdminCredentials({ ...adminCredentials, password: e.target.value })}
                  disabled={isSubmitting}
                  onKeyPress={(e) => e.key === 'Enter' && submitUserWithAdminAuth()}
                />
                <div className="admin-auth-buttons">
                  <button 
                    type="button"
                    className="cancel-btn" 
                    onClick={() => {
                      setShowAdminAuthModal(false);
                      setMessage('');
                    }}
                    disabled={isSubmitting}
                  >
                    {t('userManagement.cancel')}
                  </button>
                  <button 
                    type="button"
                    className="submit-btn" 
                    onClick={submitUserWithAdminAuth}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? t('userManagement.processing') : t('userManagement.confirm')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Confirmation de suppression */}
        {confirmDelete && (
          <div className="modal-overlay" onMouseDown={() => setConfirmDelete(null)}>
            <div className="modal-content" onMouseDown={(e) => e.stopPropagation()}>
              <h3>{t('userManagement.confirmDelete')}</h3>
              <p>{t('userManagement.confirmDeleteMessage').replace('{name}', confirmDelete.name)}</p>
              <div className="modal-actions">
                <button type="button" className="cancel-btn" onClick={() => setConfirmDelete(null)}>
                  {t('userManagement.cancel')}
                </button>
                <button type="button" className="delete-btn" onClick={handleDeleteUser}>
                  {t('userManagement.delete')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Modal d'authentification admin pour la suppression */}
        {showDeleteAuthModal && (
          <div className="modal-overlay" onMouseDown={() => !isSubmitting && setShowDeleteAuthModal(false)}>
            <div className="modal-content admin-auth-modal" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('userManagement.authAdmin')}</h2>
                <button type="button" className="close-btn" onClick={() => !isSubmitting && setShowDeleteAuthModal(false)}>
                  ✖
                </button>
              </div>
              <div className="modal-body">
                <p>{t('userManagement.authAdminDelete').replace('{name}', userToDelete?.name || '')}</p>
                
                {/* Affichage du message d'erreur dans le modal */}
                {message && messageType === 'error' && (
                  <div className="modal-error-message">
                    <p>{message}</p>
                  </div>
                )}
                
                <input
                  type="text"
                  placeholder="Identifiant admin"
                  value={adminCredentials.uid}
                  onChange={(e) => setAdminCredentials({ ...adminCredentials, uid: e.target.value })}
                  disabled={isSubmitting}
                  autoFocus
                />
                <input
                  type="password"
                  placeholder="Mot de passe admin"
                  value={adminCredentials.password}
                  onChange={(e) => setAdminCredentials({ ...adminCredentials, password: e.target.value })}
                  disabled={isSubmitting}
                  onKeyPress={(e) => e.key === 'Enter' && deleteUserWithAdminAuth()}
                />
                <div className="admin-auth-buttons">
                  <button 
                    type="button"
                    className="cancel-btn" 
                    onClick={() => {
                      setShowDeleteAuthModal(false);
                      setMessage('');
                      setUserToDelete(null);
                    }}
                    disabled={isSubmitting}
                  >
                    {t('userManagement.cancel')}
                  </button>
                  <button 
                    type="button"
                    className="submit-btn delete-btn" 
                    onClick={deleteUserWithAdminAuth}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? t('userManagement.processing') : t('userManagement.confirmDeletion')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Grille des utilisateurs en cartes */}
        <div ref={userListRef} className="table-container">
          {users.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">👥</div>
              <h3>{t('userManagement.noUsers')}</h3>
              <p>{t('userManagement.noUsersDescription')}</p>
            </div>
          ) : (
            users.map((user, index) => {
              const isCurrentUser = 
                String(getCurrentUser() || '').trim().toLowerCase() ===
                  String(user.uid || '').trim().toLowerCase() ||
                String(getCurrentUser() || '').trim().toLowerCase() ===
                  String(user.name || '').trim().toLowerCase();
              
              // Obtenir les initiales pour l'avatar
              const getInitials = (name) => {
                if (!name) return '?';
                const parts = name.split(' ');
                if (parts.length >= 2) {
                  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
                }
                return name.substring(0, 2).toUpperCase();
              };

              // Icône du rôle
              const getRoleIcon = (role) => {
                switch ((role || '').toLowerCase()) {
                  case 'admin': return '';
                  case 'guest': return '👤';
                  default: return '';
                }
              };

              return (
                <div 
                  key={user.id} 
                  className="user-card"
                  style={{ animationDelay: `${index * 0.05}s` }}
                >
                  <div className="user-card-header">
                    <div className="user-avatar">
                      {getInitials(user.name)}
                    </div>
                    <div className="user-info">
                      <h3 className="user-name" title={user.name}>
                        {user.name}
                        {isCurrentUser && t('userManagement.you')}
                      </h3>
                      <p className="user-email" title={user.email}>{user.email}</p>
                    </div>
                  </div>
                  
                  <div className={`role-badge ${(user.role || 'user').toLowerCase()}`}>
                    <span className="role-badge-icon">{getRoleIcon(user.role)}</span>
                    {user.role || 'User'}
                  </div>

                  {isAdmin && (
                    <div className="user-card-actions">
                      <button 
                        type="button"
                        className="action-button edit-button"
                        onClick={() => openEditUserForm(user)}
                        title={t('userManagement.editUserTitle')}
                      >
                        <span className="action-icon">✏️</span>
                        {t('userManagement.edit')}
                      </button>
                      <button 
                        type="button"
                        className="action-button delete-button"
                        onClick={() => confirmDeleteUser(user)}
                        disabled={isCurrentUser}
                        title={isCurrentUser ? t('userManagement.cannotDeleteOwnAccountTitle') : t('userManagement.deleteUserTitle')}
                      >
                        <span className="action-icon">🗑️</span>
                        {t('userManagement.delete')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default User;
