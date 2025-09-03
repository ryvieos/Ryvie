import React, { useState, useEffect, useRef } from 'react';
import './styles/User.css';
import { useNavigate } from 'react-router-dom';
import axios from './utils/setupAxios';
const { getServerUrl } = require('./config/urls');
import { getCurrentAccessMode } from './utils/detectAccessMode';

const User = () => {
  const navigate = useNavigate();

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
  const isAdmin = userRole === 'Admin';

  useEffect(() => {
    const role = localStorage.getItem('currentUserRole') || 'User';
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
      
      const currentRole = localStorage.getItem('currentUserRole') || 'User';
      const endpoint = currentRole === 'Admin' ? '/api/users' : '/api/users-public';
      
      // Helper to map API users
      const mapUsers = (data) => (data || []).map((user, index) => ({
        id: index + 1,
        name: user.name || user.cn || user.uid,
        email: user.email || user.mail || 'Non défini',
        role: user.role || 'User',
        uid: user.uid
      }));

      if (endpoint === '/api/users') {
        // Admin path: try protected first, then fallback to public on missing/401 token
        const token = localStorage.getItem('jwt_token') || localStorage.getItem('token');
        if (!token) {
          console.warn('[users] Admin sans token: bascule vers /api/users-public');
          const resp = await axios.get(`${serverUrl}/api/users-public`);
          setUsers(mapUsers(resp.data));
          setMessage('Session expirée — affichage des utilisateurs publics.');
          setMessageType('warning');
          setLoading(false);
          return;
        }
        const config = { headers: { Authorization: `Bearer ${token}` } };
        try {
          const resp = await axios.get(`${serverUrl}/api/users`, config);
          setUsers(mapUsers(resp.data));
          setLoading(false);
          return;
        } catch (e) {
          if (e?.response?.status === 401) {
            console.warn('[users] 401 sur /api/users: bascule vers /api/users-public');
            const resp = await axios.get(`${serverUrl}/api/users-public`);
            setUsers(mapUsers(resp.data));
            setMessage('Session expirée — affichage des utilisateurs publics.');
            setMessageType('warning');
            setLoading(false);
            return;
          }
          throw e; // let outer catch handle other errors
        }
      } else {
        // Non-admin: use public endpoint
        const resp = await axios.get(`${serverUrl}/api/users-public`);
        setUsers(mapUsers(resp.data));
        setLoading(false);
        return;
      }
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
    const currentUser = localStorage.getItem('currentUser') || '';
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

    // Récupérer l'utilisateur actuel depuis localStorage pour pré-remplir les identifiants admin
    const currentUser = localStorage.getItem('currentUser') || '';
    
    // Pré-remplir les identifiants admin avec l'utilisateur actuel
    setAdminCredentials({ 
      uid: currentUser,
      password: '' 
    });

    // Ouvrir le modal d'authentification admin
    setShowAdminAuthModal(true);
  };

  const handleUpdateUser = async () => {
    if (!validateUserForm()) {
      return;
    }

    // Récupérer l'utilisateur actuel depuis localStorage pour pré-remplir les identifiants admin
    const currentUser = localStorage.getItem('currentUser') || '';
    
    // Pré-remplir les identifiants admin avec l'utilisateur actuel
    setAdminCredentials({ 
      uid: currentUser,
      password: '' 
    });

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
    const token = localStorage.getItem('jwt_token') || localStorage.getItem('token');
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

    // Récupérer l'utilisateur actuel depuis localStorage pour pré-remplir les identifiants admin
    const currentUser = localStorage.getItem('currentUser') || '';
    
    // Pré-remplir les identifiants admin avec l'utilisateur actuel
    setAdminCredentials({ 
      uid: currentUser,
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
    const token = localStorage.getItem('jwt_token') || localStorage.getItem('token');
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
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Chargement des utilisateurs...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="user-body">
        <div className="error-container">
          <div className="error-icon">⚠️</div>
          <p>{error}</p>
          <button className="retry-button" onClick={fetchUsers}>Réessayer</button>
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
              ← Retour au Home
            </button>
          </div>
          <div className="top-bar-content">
            <h1>Gestion des utilisateurs</h1>
            <p>Gérez les utilisateurs et leurs permissions</p>
          </div>
          {isAdmin && (
            <div className="add-user-btn">
              <button type="button" onClick={openAddUserForm}>Ajouter un utilisateur</button>
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
                <h2>{editUser ? 'Modifier un utilisateur' : 'Ajouter un utilisateur'}</h2>
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
                  placeholder={editUser ? "Nom" : "Nom (sera l'UID)"}
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
                    placeholder="Identifiant (uid)"
                    value={newUser.uid}
                    onChange={(e) => setNewUser({ ...newUser, uid: e.target.value })}
                    disabled={!!editUser}
                    readOnly={!!editUser}
                    title={editUser ? "L'identifiant (uid) ne peut pas être modifié" : undefined}
                  />
                )}
                <input
                  type="email"
                  placeholder="Email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value, mail: e.target.value })}
                />
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  className="role-select"
                >
                  <option value="User">User</option>
                  <option value="Admin">Admin</option>
                  <option value="Guest">Guest</option>
                </select>
                <input
                  type="password"
                  placeholder="Mot de passe"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
                <input
                  type="password"
                  placeholder="Confirmer le mot de passe"
                  value={newUser.confirmPassword}
                  onChange={(e) => setNewUser({ ...newUser, confirmPassword: e.target.value })}
                />
                <button 
                  type="button"
                  className="submit-btn" 
                  onClick={editUser ? handleUpdateUser : handleAddUser}
                >
                  {editUser ? 'Modifier' : 'Ajouter'}
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
                <h2>Authentification Administrateur</h2>
                <button type="button" className="close-btn" onClick={() => !isSubmitting && setShowAdminAuthModal(false)}>
                  ✖
                </button>
              </div>
              <div className="modal-body">
                <p>Veuillez vous authentifier en tant qu'administrateur pour ajouter un nouvel utilisateur</p>
                
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
                    Annuler
                  </button>
                  <button 
                    type="button"
                    className="submit-btn" 
                    onClick={submitUserWithAdminAuth}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? 'Traitement en cours...' : 'Confirmer'}
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
              <h3>Confirmer la suppression</h3>
              <p>Êtes-vous sûr de vouloir supprimer {confirmDelete.name} ?</p>
              <div className="modal-actions">
                <button type="button" className="cancel-btn" onClick={() => setConfirmDelete(null)}>
                  Annuler
                </button>
                <button type="button" className="delete-btn" onClick={handleDeleteUser}>
                  Supprimer
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
                <h2>Authentification Administrateur</h2>
                <button type="button" className="close-btn" onClick={() => !isSubmitting && setShowDeleteAuthModal(false)}>
                  ✖
                </button>
              </div>
              <div className="modal-body">
                <p>Veuillez vous authentifier en tant qu'administrateur pour supprimer l'utilisateur <strong>{userToDelete?.name}</strong></p>
                
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
                    Annuler
                  </button>
                  <button 
                    type="button"
                    className="submit-btn delete-btn" 
                    onClick={deleteUserWithAdminAuth}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? 'Traitement en cours...' : 'Confirmer la suppression'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tableau des utilisateurs */}
        <div ref={userListRef} className="table-container">
          <table className="user-table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Email</th>
                <th>Rôle</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td title={user.name}>{user.name}</td>
                  <td title={user.email}>{user.email}</td>
                  <td>
                    <select
                      value={user.role}
                      onChange={(e) => handleRoleChange(user.id, e.target.value)}
                      className={`role-select ${user.role.toLowerCase()}`}
                      disabled={true} // Disable direct role change, use edit form instead
                    >
                      <option value="User">User</option>
                      <option value="Admin">Admin</option>
                      <option value="Guest">Guest</option>
                    </select>
                  </td>
                  {isAdmin && (
                    <td className="actions-cell">
                      <button 
                        type="button"
                        className="action-button edit-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditUserForm(user);
                        }}
                        title="Modifier"
                      >
                        <span className="action-icon">✏️</span>
                      </button>
                      <button 
                        type="button"
                        className="action-button delete-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDeleteUser(user);
                        }}
                        disabled={
                          String(localStorage.getItem('currentUser') || '').trim().toLowerCase() ===
                          String(user.uid || '').trim().toLowerCase()
                        }
                        title={
                          String(localStorage.getItem('currentUser') || '').trim().toLowerCase() ===
                          String(user.uid || '').trim().toLowerCase()
                            ? "Vous ne pouvez pas supprimer votre propre compte"
                            : "Supprimer"
                        }
                      >
                        <span className="action-icon">🗑️</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default User;
