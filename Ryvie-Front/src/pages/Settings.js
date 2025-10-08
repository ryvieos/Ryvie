import React, { useState, useEffect } from 'react';
import '../styles/Settings.css';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faServer, faHdd, faDatabase, faPlug, faGlobe, faCheck, faCopy } from '@fortawesome/free-solid-svg-icons';
import { isElectron } from '../utils/platformUtils';
import urlsConfig from '../config/urls';
const { getServerUrl, getFrontendUrl } = urlsConfig;
import { getCurrentAccessMode, setAccessMode as setGlobalAccessMode, connectRyvieSocket } from '../utils/detectAccessMode';
import { getCurrentUserRole, getCurrentUser, startSession, isSessionActive, getSessionInfo } from '../utils/sessionManager';
import StorageSettings from './StorageSettings';

const Settings = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(() => {
    // Charger depuis le cache localStorage au démarrage
    const cached = localStorage.getItem('systemStats');
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        return {
          storageUsed: 0,
          storageLimit: 0,
          cpuUsage: 0,
          ramUsage: 0,
          activeUsers: 1,
          totalFiles: 110,
          backupStatus: 'Completed',
          lastBackup: '2024-01-09 14:30',
        };
      }
    }
    return {
      storageUsed: 0,
      storageLimit: 0,
      cpuUsage: 0,
      ramUsage: 0,
      activeUsers: 1,
      totalFiles: 110,
      backupStatus: 'Completed',
      lastBackup: '2024-01-09 14:30',
    };
  });

  const [settings, setSettings] = useState({
    autoBackup: true,
    backupFrequency: 'daily',
    encryptionEnabled: true,
    twoFactorAuth: false,
    notificationsEnabled: true,
    darkMode: false,
    compressionLevel: 'medium',
    bandwidthLimit: 'unlimited',
    autoDelete: false,
    autoDeletionPeriod: '30',
    storageLocation: 'local',
    redundancyLevel: 'raid1',
    downloadPath: '',
  });

  // État pour les applications Docker
  const [applications, setApplications] = useState([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [appsError, setAppsError] = useState(null);
  const [appActionStatus, setAppActionStatus] = useState({
    show: false,
    success: false,
    message: '',
    appId: null
  });
  // État pour l'application sélectionnée (détails)
  const [selectedApp, setSelectedApp] = useState(null);

  const [disks, setDisks] = useState([
    {
      id: 1,
      name: 'Disque 1',
      size: '2TB',
      used: '800GB',
      health: 'good',
      type: 'SSD',
      status: 'active',
    },
    {
      id: 2,
      name: 'Disque 2',
      size: '2TB',
      used: '750GB',
      health: 'good',
      type: 'SSD',
      status: 'active',
    },
  ]);

  const [ryvieServers, setRyvieServers] = useState([
    {
      id: 1,
      name: 'Serveur Paris',
      location: 'Paris, France',
      ping: '5ms',
      status: 'online',
    },
    {
      id: 2,
      name: 'Serveur Londres',
      location: 'London, UK',
      ping: '15ms',
      status: 'online',
    },
    {
      id: 3,
      name: 'Serveur New York',
      location: 'New York, USA',
      ping: '85ms',
      status: 'online',
    },
  ]);

  const [changeStatus, setChangeStatus] = useState({ show: false, success: false });
  const [tokenExpiration, setTokenExpiration] = useState(15); // En minutes, par défaut 15
  const [backgroundImage, setBackgroundImage] = useState('default'); // Fond d'écran
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [customBackgrounds, setCustomBackgrounds] = useState([]); // Liste des fonds personnalisés
  const [presetBackgrounds, setPresetBackgrounds] = useState(() => {
    // Charger depuis le cache localStorage au démarrage
    const cached = localStorage.getItem('presetBackgrounds');
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        return [];
      }
    }
    return [];
  }); // Liste des fonds prédéfinis
  // Initialiser prudemment pour éviter tout appel privé intempestif
  const [accessMode, setAccessMode] = useState(() => {
    const mode = getCurrentAccessMode();
    if (mode) return mode;
    // Fallback sécurisé: en HTTPS forcer public, sinon rester public pour éviter erreurs DNS
    try {
      if (typeof window !== 'undefined' && window.location?.protocol === 'https:') return 'public';
    } catch {}
    return 'public';
  });
  const [systemDisksInfo, setSystemDisksInfo] = useState(null);
  const [showDisksInfo, setShowDisksInfo] = useState(false);

  const [socketConnected, setSocketConnected] = useState(false);
  const [serverConnectionStatus, setServerConnectionStatus] = useState(false);
  // Overlay Assistant Stockage
  const [showStorageOverlay, setShowStorageOverlay] = useState(false);
  // Stockage (lecture seule) - état live
  const [storageInventory, setStorageInventory] = useState(null);
  const [mdraidStatus, setMdraidStatus] = useState(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState(null);
  // État pour les adresses publiques
  const [publicAddresses, setPublicAddresses] = useState(null);
  const [copiedAddress, setCopiedAddress] = useState(null);
  const [showPublicAddresses, setShowPublicAddresses] = useState(false);
  // Rôle de l'utilisateur pour contrôler l'accès aux boutons
  const [userRole, setUserRole] = useState('User');
  const isAdmin = String(userRole || '').toLowerCase() === 'admin';
  // État pour le détail du stockage
  const [showStorageDetail, setShowStorageDetail] = useState(false);
  const [storageDetail, setStorageDetail] = useState(null);
  const [storageDetailLoading, setStorageDetailLoading] = useState(false);

  useEffect(() => {
    // Restaurer la session depuis les paramètres URL si preserve_session=true
    const urlParams = new URLSearchParams(window.location.search);
    const preserveSession = urlParams.get('preserve_session');
    const user = urlParams.get('user');
    const role = urlParams.get('role');
    const token = urlParams.get('token');
    const targetMode = urlParams.get('mode');
    
    // Forcer le mode d'accès si spécifié
    if (targetMode) {
      console.log(`[Settings] Application du mode forcé: ${targetMode}`);
      setGlobalAccessMode(targetMode);
      setAccessMode(targetMode);
    }
    
    if (preserveSession === 'true' && user && token) {
      console.log(`[Settings] Restauration de la session pour: ${user}`);
      
      // Restaurer la session
      startSession({
        token: token,
        userId: user,
        userName: user,
        userRole: role || 'User',
        userEmail: ''
      });
      
      // Nettoyer les paramètres URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Récupérer le rôle de l'utilisateur
    const currentRole = getCurrentUserRole() || 'User';
    setUserRole(currentRole);
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Charger le dossier de téléchargement actuel seulement en mode Electron
        if (isElectron() && window.electronAPI) {
          const path = await window.electronAPI.getDownloadFolder();
          setSettings(prev => ({
            ...prev,
            downloadPath: path
          }));
        } else {
          // En mode web, utiliser un dossier par défaut
          setSettings(prev => ({
            ...prev,
            downloadPath: 'Téléchargements (navigateur)'
          }));
        }
        
        // Charger les adresses publiques depuis netbird-data.json
        try {
          const netbirdData = await import('../config/netbird-data.json');
          if (netbirdData && netbirdData.domains) {
            setPublicAddresses(netbirdData.domains);
          }
        } catch (error) {
          console.log('[Settings] Impossible de charger netbird-data.json:', error);
        }
        
        setLoading(false);
      } catch (error) {
        console.error('Error fetching settings:', error);
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // S'assurer que accessMode est cohérent et persistant au montage
  useEffect(() => {
    let mode = getCurrentAccessMode();
    console.log('[Settings] getCurrentAccessMode() ->', mode);
    if (!mode) {
      // Déterminer un fallback sûr
      if (typeof window !== 'undefined' && window.location?.protocol === 'https:') {
        mode = 'public';
      } else {
        mode = 'public';
      }
      setGlobalAccessMode(mode);
    }
    console.log('[Settings] Mode final utilisé ->', mode);
    if (mode !== accessMode) setAccessMode(mode);
  }, []);

  // Charger la durée d'expiration du token, le fond d'écran et la liste des fonds personnalisés
  useEffect(() => {
    const loadUserPreferences = async () => {
      if (!accessMode) return;
      
      try {
        const serverUrl = getServerUrl(accessMode);
        
        // Charger durée token
        const tokenResponse = await axios.get(`${serverUrl}/api/settings/token-expiration`);
        if (tokenResponse.data.minutes) {
          setTokenExpiration(tokenResponse.data.minutes);
        }
        
        // Charger fond d'écran
        const prefsResponse = await axios.get(`${serverUrl}/api/user/preferences`);
        if (prefsResponse.data?.backgroundImage) {
          setBackgroundImage(prefsResponse.data.backgroundImage);
        }
        
        // Charger liste des fonds personnalisés
        const backgroundsResponse = await axios.get(`${serverUrl}/api/user/preferences/backgrounds/list`);
        if (backgroundsResponse.data?.backgrounds) {
          setCustomBackgrounds(backgroundsResponse.data.backgrounds);
        }
        
        // Charger liste des fonds prédéfinis
        const presetsResponse = await axios.get(`${serverUrl}/api/backgrounds/presets`);
        if (presetsResponse.data?.backgrounds) {
          setPresetBackgrounds(presetsResponse.data.backgrounds);
          // Sauvegarder dans le cache localStorage pour chargement instantané
          localStorage.setItem('presetBackgrounds', JSON.stringify(presetsResponse.data.backgrounds));
        }
      } catch (error) {
        console.log('[Settings] Impossible de charger les préférences utilisateur');
      }
    };
    
    loadUserPreferences();
  }, [accessMode]);

  // Récupération des informations serveur (HTTP polling)
  useEffect(() => {
    if (!accessMode) return; // attendre l'init
    const baseUrl = getServerUrl(accessMode);
    console.log('[Settings] accessMode courant =', accessMode);
    console.log('Connexion à :', baseUrl);
    
    // Fonction pour récupérer les informations serveur
    const fetchServerInfo = async () => {
      try {
        const response = await axios.get(`${baseUrl}/api/server-info`, {
          timeout: 15000 // Timeout augmenté à 15s pour les calculs de stockage
        });
        console.log('Informations serveur reçues:', response.data);
        updateServerStats(response.data);
      } catch (error) {
        console.error('Erreur lors de la récupération des informations serveur:', error);
      }
    };
    
    // Appel initial
    fetchServerInfo();
    
    // Configuration de l'intervalle pour les mises à jour régulières (toutes les 5s au lieu de 2s)
    const intervalId = setInterval(fetchServerInfo, 5000);
    
    // Nettoyage lors du démontage du composant
    return () => {
      clearInterval(intervalId);
    };
  }, [accessMode]); // Réexécute l'effet si le mode d'accès change

  // Récupération live de la configuration stockage (lecture seule)
  useEffect(() => {
    const fetchStorage = async () => {
      if (!accessMode) return;
      setStorageLoading(true);
      setStorageError(null);
      try {
        const baseUrl = getServerUrl(accessMode);
        const [inv, md] = await Promise.all([
          axios.get(`${baseUrl}/api/storage/inventory`, { timeout: 30000 }),
          axios.get(`${baseUrl}/api/storage/mdraid-status`, { timeout: 30000 })
        ]);
        setStorageInventory(inv.data?.data || null);
        setMdraidStatus(md.data?.status || null);
      } catch (e) {
        console.error('[Settings] Erreur récupération stockage:', e);
        setStorageError(e?.response?.data?.error || e.message);
      } finally {
        setStorageLoading(false);
      }
    };
    fetchStorage();
  }, [accessMode]);

  // Helpers pour extraire des infos depuis lsblk JSON
  const findBlockByPath = (devices, path) => {
    if (!devices) return null;
    const recur = (arr) => {
      for (const d of arr) {
        const dPath = d.path || (d.name ? `/dev/${d.name}` : undefined);
        if (dPath === path) return d;
        if (d.children) {
          const r = recur(d.children);
          if (r) return r;
        }
      }
      return null;
    };
    return recur(devices.blockdevices || []);
  };
  const getMountPointRootPartition = (devices) => {
    if (!devices) return null;
    const recur = (arr, parent) => {
      for (const d of arr) {
        const mp = d.mountpoints && d.mountpoints[0];
        if (mp === '/') return { part: d, parent };
        if (d.children) {
          const r = recur(d.children, d);
          if (r) return r;
        }
      }
      return null;
    };
    return recur(devices.blockdevices || [], null);
  };
  
  // Fonction pour mettre à jour les statistiques du serveur
  const updateServerStats = (data) => {
    if (!data) return;
    
    // Extraire les valeurs de stockage
    let storageUsed = 0;
    let storageTotal = 1000; // Valeur par défaut
    
    if (data.stockage) {
      // Convertir les valeurs de GB en nombre
      const usedMatch = data.stockage.utilise?.match(/(\d+(\.\d+)?)/);
      const totalMatch = data.stockage.total?.match(/(\d+(\.\d+)?)/);
      
      if (usedMatch) storageUsed = parseFloat(usedMatch[0]);
      if (totalMatch) storageTotal = parseFloat(totalMatch[0]);
    }
    
    // Extraire les valeurs CPU/RAM directement depuis l'objet data
    let cpuUsage = 0;
    let ramUsage = 0;
    
    // Extraire les pourcentages des chaînes comme '12.8%'
    if (typeof data.cpu === 'string') {
      const cpuMatch = data.cpu.match(/(\d+(\.\d+)?)/);
      if (cpuMatch) cpuUsage = parseFloat(cpuMatch[1]);
    } else if (typeof data.cpu === 'number') {
      cpuUsage = data.cpu;
    }
    
    if (typeof data.ram === 'string') {
      const ramMatch = data.ram.match(/(\d+(\.\d+)?)/);
      if (ramMatch) ramUsage = parseFloat(ramMatch[1]);
    } else if (typeof data.ram === 'number') {
      ramUsage = data.ram;
    }
    
    // Mettre à jour les statistiques
    setStats(prev => {
      const newStats = {
        ...prev,
        storageUsed: storageUsed,
        storageLimit: storageTotal,
        cpuUsage: cpuUsage,
        ramUsage: ramUsage
      };
      
      // Sauvegarder dans le cache localStorage pour chargement instantané
      localStorage.setItem('systemStats', JSON.stringify(newStats));
      
      return newStats;
    });
  };

  // Fonction pour changer le fond d'écran
  const handleBackgroundChange = async (newBackground) => {
    console.log('[Settings] Changement fond d\'écran:', newBackground);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      await axios.patch(`${serverUrl}/api/user/preferences/background`, { backgroundImage: newBackground });
      
      setBackgroundImage(newBackground);
      setChangeStatus({
        show: true,
        success: true,
        message: `✓ Fond d'écran modifié`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 3000);
    } catch (error) {
      console.error('[Settings] Erreur changement fond d\'écran:', error);
      setChangeStatus({
        show: true,
        success: false,
        message: `✗ Erreur lors de la modification`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 5000);
    }
  };

  // Fonction pour uploader un fond d'écran personnalisé
  const handleBackgroundUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    // Vérifier le type de fichier
    if (!file.type.startsWith('image/')) {
      setChangeStatus({
        show: true,
        success: false,
        message: '✗ Veuillez sélectionner une image'
      });
      setTimeout(() => setChangeStatus({ show: false, success: false, message: '' }), 3000);
      return;
    }
    
    // Vérifier la taille (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setChangeStatus({
        show: true,
        success: false,
        message: '✗ Image trop grande (max 5MB)'
      });
      setTimeout(() => setChangeStatus({ show: false, success: false, message: '' }), 3000);
      return;
    }
    
    setUploadingBackground(true);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      const formData = new FormData();
      formData.append('background', file);
      
      const response = await axios.post(`${serverUrl}/api/user/preferences/background/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });
      
      console.log('[Settings] Upload réussi:', response.data);
      
      // Le serveur retourne l'ID de l'image uploadée
      const customBackgroundId = response.data.backgroundImage || 'custom';
      setBackgroundImage(customBackgroundId);
      
      // Recharger la liste des fonds personnalisés
      const backgroundsResponse = await axios.get(`${serverUrl}/api/user/preferences/backgrounds/list`);
      if (backgroundsResponse.data?.backgrounds) {
        setCustomBackgrounds(backgroundsResponse.data.backgrounds);
      }
      
      setChangeStatus({
        show: true,
        success: true,
        message: `✓ Fond d'écran personnalisé uploadé`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 3000);
    } catch (error) {
      console.error('[Settings] Erreur upload fond d\'écran:', error);
      setChangeStatus({
        show: true,
        success: false,
        message: `✗ Erreur lors de l'upload`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 5000);
    } finally {
      setUploadingBackground(false);
      // Réinitialiser l'input
      event.target.value = '';
    }
  };

  // Fonction pour supprimer un fond personnalisé
  const handleDeleteBackground = async (filename) => {
    if (!window.confirm('Êtes-vous sûr de vouloir supprimer ce fond d\'écran ?')) {
      return;
    }
    
    try {
      const serverUrl = getServerUrl(accessMode);
      await axios.delete(`${serverUrl}/api/user/preferences/background/${filename}`);
      
      // Recharger la liste
      const backgroundsResponse = await axios.get(`${serverUrl}/api/user/preferences/backgrounds/list`);
      if (backgroundsResponse.data?.backgrounds) {
        setCustomBackgrounds(backgroundsResponse.data.backgrounds);
      }
      
      // Si c'était le fond actif, recharger les préférences
      const prefsResponse = await axios.get(`${serverUrl}/api/user/preferences`);
      if (prefsResponse.data?.backgroundImage) {
        setBackgroundImage(prefsResponse.data.backgroundImage);
      }
      
      setChangeStatus({
        show: true,
        success: true,
        message: `✓ Fond d'écran supprimé`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 3000);
    } catch (error) {
      console.error('[Settings] Erreur suppression fond:', error);
      setChangeStatus({
        show: true,
        success: false,
        message: `✗ Erreur lors de la suppression`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 5000);
    }
  };

  // Fonction pour changer le temps d'expiration du token
  const handleTokenExpirationChange = async (minutes) => {
    console.log('[Settings] Changement durée de session:', minutes, 'minutes');
    
    try {
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.patch(`${serverUrl}/api/settings/token-expiration`, { minutes: parseInt(minutes) });
      
      console.log('[Settings] Réponse serveur:', response.data);
      
      setTokenExpiration(minutes);
      setChangeStatus({
        show: true,
        success: true,
        message: `✓ Durée de session modifiée: ${minutes} minute${minutes > 1 ? 's' : ''}`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 3000);
    } catch (error) {
      console.error('[Settings] Erreur lors du changement de durée de session:', error);
      console.error('[Settings] Détails erreur:', error.response?.data);
      
      const errorMessage = error.response?.data?.error || 'Erreur lors de la modification';
      
      setChangeStatus({
        show: true,
        success: false,
        message: `✗ ${errorMessage}`
      });
      
      setTimeout(() => {
        setChangeStatus({ show: false, success: false, message: '' });
      }, 5000);
    }
  };

  // Fonction pour changer le mode d'accès
  const handleAccessModeChange = (newMode) => {
    // Récupérer les informations de l'utilisateur actuel avant le changement
    const currentUser = getCurrentUser();
    const currentRole = getCurrentUserRole();
    const sessionInfo = getSessionInfo();
    const currentToken = sessionInfo.token;
    
    console.log(`[Settings] Changement de mode: ${accessMode} -> ${newMode}`);
    console.log(`[Settings] Utilisateur actuel: ${currentUser}, Rôle: ${currentRole}`);
    
    // Mettre à jour le mode via le gestionnaire centralisé
    setGlobalAccessMode(newMode);
    
    // Mettre à jour l'état local
    setAccessMode(newMode);
    
    // Notifier le processus principal du changement seulement en mode Electron
    if (isElectron() && window.electronAPI && window.electronAPI.updateAccessMode) {
      window.electronAPI.updateAccessMode(newMode);
    }
    
    // Afficher un message de confirmation
    setChangeStatus({
      show: true,
      success: true,
      message: `Mode d'accès changé pour: ${newMode === 'public' ? 'Public' : 'Privé'}. Redirection...`
    });
    
    // Rediriger vers l'URL correspondante après 1.5 secondes
    setTimeout(() => {
      const frontendUrl = getFrontendUrl(newMode);
      const currentPath = window.location.pathname; // Conserver le chemin actuel (ex: /settings)
      
      // Construire l'URL avec les paramètres de session
      const url = new URL(`${frontendUrl}${currentPath}`);
      // Ajouter le mode cible pour forcer la détection
      url.searchParams.set('mode', newMode);
      if (currentUser) {
        url.searchParams.set('preserve_session', 'true');
        url.searchParams.set('user', currentUser);
        url.searchParams.set('role', currentRole);
        if (currentToken) {
          url.searchParams.set('token', currentToken);
        }
      }
      
      const newUrl = url.toString();
      console.log(`[Settings] Redirection vers ${newMode}: ${newUrl}`);
      window.location.href = newUrl;
    }, 1500);
  };

  const handleSettingChange = async (setting, value) => {
    if (setting === 'downloadPath') {
      // Seulement en mode Electron
      if (isElectron() && window.electronAPI && window.electronAPI.changeDownloadFolder) {
        const newPath = await window.electronAPI.changeDownloadFolder();
        if (newPath) {
          setSettings(prev => ({
            ...prev,
            downloadPath: newPath
          }));
          setChangeStatus({ show: true, success: true });
          setTimeout(() => setChangeStatus({ show: false, success: false }), 3000);
        } else {
          setChangeStatus({ show: true, success: false });
          setTimeout(() => setChangeStatus({ show: false, success: false }), 3000);
        }
      } else {
        // En mode web, afficher un message informatif
        setChangeStatus({ 
          show: true, 
          success: false, 
          message: "Modification du dossier de téléchargement non disponible en mode web" 
        });
        setTimeout(() => setChangeStatus({ show: false, success: false }), 3000);
      }
    } else {
      setSettings(prev => ({
        ...prev,
        [setting]: value
      }));
    }
  };

  // Fonction pour récupérer le détail du stockage
  const fetchStorageDetail = async () => {
    // Ouvrir la modal d'abord
    setShowStorageDetail(true);
    setStorageDetailLoading(true);
    setStorageDetail(null);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      console.log('[Settings] Récupération du détail du stockage depuis:', serverUrl);
      const response = await axios.get(`${serverUrl}/api/storage-detail`, { timeout: 120000 }); // 2 minutes timeout
      console.log('[Settings] Détail du stockage reçu:', response.data);
      setStorageDetail(response.data);
    } catch (error) {
      console.error('[Settings] Erreur récupération détail stockage:', error);
      alert('Erreur lors de la récupération du détail du stockage: ' + (error.response?.data?.error || error.message));
      setShowStorageDetail(false);
    } finally {
      setStorageDetailLoading(false);
    }
  };

  // Fonction pour récupérer la liste des applications Docker
  const fetchApplications = async () => {
    setAppsLoading(true);
    setAppsError(null);
    
    try {
      const appsBase = getServerUrl(accessMode);
      console.log('[Settings] Récupération des apps depuis:', appsBase, 'mode =', accessMode);
      const response = await axios.get(`${appsBase}/api/apps`);
      setApplications(response.data.map(app => ({
        ...app,
        port: app.ports && app.ports.length > 0 ? app.ports[0] : null,
        autostart: false // Par défaut, on met à false, à améliorer avec une API de configuration
      })));
      setAppsLoading(false);
    } catch (error) {
      console.error('Erreur lors de la récupération des applications:', error);
      setAppsError('Impossible de récupérer la liste des applications');
      setAppsLoading(false);
    }
  };

  // Fonction pour gérer les actions sur les applications (démarrer/arrêter)
  const handleAppAction = async (appId, action) => {
    try {
      // Mettre à jour l'interface utilisateur pour montrer que l'action est en cours
      setAppActionStatus({
        show: true,
        success: false,
        message: `Action ${action} en cours...`,
        appId
      });

      // Appeler l'API pour effectuer l'action
      const response = await axios.post(`${getServerUrl(accessMode)}/api/apps/${appId}/${action}`);
      
      // Mettre à jour la liste des applications après l'action
      fetchApplications();
      
      // Afficher un message de succès
      setAppActionStatus({
        show: true,
        success: true,
        message: response.data.message,
        appId
      });
      
      // Masquer le message après 3 secondes
      setTimeout(() => {
        setAppActionStatus({
          show: false,
          success: false,
          message: '',
          appId: null
        });
      }, 3000);
      
    } catch (error) {
      console.error(`Erreur lors de l'action ${action} sur l'application ${appId}:`, error);
      
      // Afficher un message d'erreur
      setAppActionStatus({
        show: true,
        success: false,
        message: error.response?.data?.message || `Erreur lors de l'action ${action}`,
        appId
      });
      
      // Masquer le message après 5 secondes
      setTimeout(() => {
        setAppActionStatus({
          show: false,
          success: false,
          message: '',
          appId: null
        });
      }, 5000);
    }
  };

  // Fonction pour gérer le démarrage automatique des applications
  const handleAppAutostart = async (appId, enabled) => {
    // Mettre à jour l'état local immédiatement pour une réponse UI rapide
    setApplications(prevApps => prevApps.map(app => 
      app.id === appId ? { ...app, autostart: enabled } : app
    ));
    
    try {
      // Cette partie serait à implémenter côté backend
      // Pour l'instant on simule juste la mise à jour
      console.log(`Application ${appId} autostart set to ${enabled}`);
      
      // Afficher un message de confirmation
      setAppActionStatus({
        show: true,
        success: true,
        message: `Démarrage automatique ${enabled ? 'activé' : 'désactivé'}`,
        appId
      });
      
      // Masquer le message après 3 secondes
      setTimeout(() => {
        setAppActionStatus({
          show: false,
          success: false,
          message: '',
          appId: null
        });
      }, 3000);
    } catch (error) {
      console.error(`Erreur lors de la mise à jour du démarrage automatique pour ${appId}:`, error);
      
      // Annuler le changement local en cas d'erreur
      setApplications(prevApps => prevApps.map(app => 
        app.id === appId ? { ...app, autostart: !enabled } : app
      ));
      
      // Afficher un message d'erreur
      setAppActionStatus({
        show: true,
        success: false,
        message: "Erreur lors de la mise à jour du démarrage automatique",
        appId
      });
      
      // Masquer le message après 5 secondes
      setTimeout(() => {
        setAppActionStatus({
          show: false,
          success: false,
          message: '',
          appId: null
        });
      }, 5000);
    }
  };

  // Fonction pour sélectionner une application et afficher ses détails
  const handleAppSelect = (app) => {
    if (selectedApp && selectedApp.id === app.id) {
      // Si on clique sur l'app déjà sélectionnée, on ferme les détails
      setSelectedApp(null);
    } else {
      // Sinon, on affiche les détails de l'app
      setSelectedApp(app);
    }
  };

  // Fonction pour fermer la vue détaillée
  const closeAppDetails = () => {
    setSelectedApp(null);
  };

  const formatSize = (size) => {
    if (size < 1024) return size + ' GB';
    return (size / 1024).toFixed(1) + ' TB';
  };

  const formatPercentage = (used, total) => {
    return ((used / total) * 100).toFixed(1) + '%';
  };

  const handleShowDisks = async () => {
    const baseUrl = getServerUrl(accessMode);
    try {
      const response = await axios.get(`${baseUrl}/api/disks`);
      setSystemDisksInfo(response.data);
      setShowDisksInfo(!showDisksInfo);
    } catch (error) {
      console.error('Erreur lors de la récupération des informations des disques:', error);
    }
  };

  useEffect(() => {
    if (!accessMode) return;
    fetchApplications();
    
    // Connexion centralisée via le helper
    const socket = connectRyvieSocket({
      mode: accessMode,
      onConnect: () => {
        console.log('[Settings] Socket connecté');
        setSocketConnected(true);
      },
      onDisconnect: () => {
        console.log('[Settings] Socket déconnecté');
        setSocketConnected(false);
      },
      onError: (err) => {
        console.log('[Settings] Erreur socket:', err?.message || err);
      },
      onAppsStatusUpdate: (updatedApps) => {
        console.log('[Settings] Mise à jour des apps reçue:', updatedApps);
        setApplications(prevApps => {
          return updatedApps.map(updatedApp => {
            const existingApp = prevApps.find(app => app.id === updatedApp.id);
            return {
              ...updatedApp,
              port: updatedApp.ports && updatedApp.ports.length > 0 ? updatedApp.ports[0] : null,
              autostart: existingApp ? existingApp.autostart : false
            };
          });
        });
      },
    });

    return () => {
      if (socket && typeof socket.disconnect === 'function') {
        socket.disconnect();
      }
    };
  }, [accessMode]);

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="loading-spinner"></div>
        <p>Chargement des paramètres...</p>
      </div>
    );
  }

  return (
    <div className="settings-container">
      {/* En-tête */}
      <div className="settings-header">
        <button className="back-btn" onClick={() => navigate('/home')}>
          ← Retour
        </button>
        <h1>Paramètres du Cloud</h1>
      </div>

      {/* Section Personnalisation */}
      <section className="settings-section">
        <h2>Personnalisation</h2>
        <div className="settings-grid">
          <div className="settings-card">
            <h3>Fond d'écran</h3>
            <p className="setting-description">
              Personnalisez l'arrière-plan de votre page d'accueil
            </p>
            {changeStatus.show && (
              <div className={`status-message ${changeStatus.success ? 'success' : 'error'}`} style={{ marginBottom: '12px' }}>
                {changeStatus.message}
              </div>
            )}
            <div className="background-options" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '12px', marginTop: '16px' }}>
              {/* Afficher les fonds prédéfinis depuis public/images/backgrounds */}
              {presetBackgrounds.map((preset) => (
                <div
                  key={preset.id}
                  className={`background-option ${backgroundImage === preset.id ? 'active' : ''}`}
                  onClick={() => handleBackgroundChange(preset.id)}
                  style={{
                    height: '80px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    border: backgroundImage === preset.id ? '3px solid #4a90e2' : '2px solid #ddd',
                    background: `url(${getServerUrl(accessMode)}/api/backgrounds/presets/${preset.filename}) center/cover`,
                    position: 'relative',
                    transition: 'all 0.2s'
                  }}
                >
                  {backgroundImage === preset.id && (
                    <div style={{ position: 'absolute', top: '4px', right: '4px', background: '#4a90e2', color: 'white', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px' }}>✓</div>
                  )}
                  <div style={{ position: 'absolute', bottom: '4px', left: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {preset.name}
                  </div>
                </div>
              ))}
              
              {/* Option pour uploader son propre fond */}
              <div 
                className={`background-option ${backgroundImage?.startsWith('custom-') ? 'active' : ''}`}
                onClick={() => document.getElementById('background-upload-input').click()}
                style={{
                  height: '80px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  border: backgroundImage?.startsWith('custom-') ? '3px solid #4a90e2' : '2px dashed #999',
                  background: '#f5f5f5',
                  position: 'relative',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden'
                }}
              >
                {uploadingBackground ? (
                  <div style={{ color: '#666', fontSize: '12px' }}>Upload...</div>
                ) : backgroundImage?.startsWith('custom-') ? (
                  <>
                    <div style={{ position: 'absolute', top: '4px', right: '4px', background: '#4a90e2', color: 'white', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px' }}>✓</div>
                    <div style={{ position: 'absolute', bottom: '4px', left: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', textAlign: 'center' }}>Personnalisé</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: '32px', color: '#999' }}>+</div>
                    <div style={{ position: 'absolute', bottom: '4px', left: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', textAlign: 'center' }}>Upload</div>
                  </>
                )}
              </div>
              <input
                id="background-upload-input"
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleBackgroundUpload}
              />
            </div>
            
            {/* Liste des fonds personnalisés */}
            {customBackgrounds.length > 0 && (
              <div style={{ marginTop: '24px' }}>
                <h4 style={{ marginBottom: '12px', fontSize: '14px', color: '#666' }}>Mes fonds d'écran ({customBackgrounds.length})</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '12px' }}>
                  {customBackgrounds.map((bg) => (
                    <div
                      key={bg.id}
                      className={`background-option ${backgroundImage === bg.id ? 'active' : ''}`}
                      style={{
                        height: '80px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        border: backgroundImage === bg.id ? '3px solid #4a90e2' : '2px solid #ddd',
                        background: `url(${getServerUrl(accessMode)}/api/backgrounds/${bg.filename}) center/cover`,
                        position: 'relative',
                        transition: 'all 0.2s'
                      }}
                      onClick={() => handleBackgroundChange(bg.id)}
                    >
                      {backgroundImage === bg.id && (
                        <div style={{ position: 'absolute', top: '4px', right: '4px', background: '#4a90e2', color: 'white', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px' }}>✓</div>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteBackground(bg.filename);
                        }}
                        style={{
                          position: 'absolute',
                          top: '4px',
                          left: '4px',
                          background: 'rgba(255, 0, 0, 0.8)',
                          color: 'white',
                          border: 'none',
                          borderRadius: '50%',
                          width: '20px',
                          height: '20px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          cursor: 'pointer',
                          padding: 0
                        }}
                        title="Supprimer"
                      >
                        ×
                      </button>
                      <div style={{ position: 'absolute', bottom: '4px', left: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {new Date(bg.uploadDate).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section Statistiques */}
      <section className="settings-section stats-section">
        <h2>Vue d'ensemble du système</h2>
        <div className="stats-grid">
          {/* Stockage */}
          <div 
            className="stat-card storage" 
            style={{ cursor: 'pointer' }}
            onClick={fetchStorageDetail}
          >
            <h3>Stockage</h3>
            <div className="progress-container">
              <div 
                className="progress-bar" 
                style={{ width: formatPercentage(stats.storageUsed, stats.storageLimit) }}
              ></div>
            </div>
            <div className="stat-details">
              <span>{formatSize(stats.storageUsed)} utilisés</span>
              <span>sur {formatSize(stats.storageLimit)}</span>
            </div>
          </div>

          {/* Performance */}
          <div className="stat-card performance">
            <h3>Performance</h3>
            <div className="performance-stats">
              <div className="performance-item">
                <span>CPU</span>
                <div className="progress-container">
                  <div 
                    className="progress-bar" 
                    style={{ width: stats.cpuUsage + '%' }}
                  ></div>
                </div>
                <span>{stats.cpuUsage}%</span>
              </div>
              <div className="performance-item">
                <span>RAM</span>
                <div className="progress-container">
                  <div 
                    className="progress-bar" 
                    style={{ width: stats.ramUsage + '%' }}
                  ></div>
                </div>
                <span>{stats.ramUsage}%</span>
              </div>
            </div>
          </div>

          {/* Statistiques générales */}
          <div className="stat-card general">
            <h3>Statistiques</h3>
            <div className="general-stats">
              <div className="stat-item">
                <span>Utilisateurs actifs</span>
                <strong>{stats.activeUsers}</strong>
              </div>
              <div className="stat-item">
                <span>Fichiers totaux</span>
                <strong>{stats.totalFiles}</strong>
              </div>
            </div>
          </div>

          {/* Statut de la sauvegarde */}
          <div className="stat-card backup">
            <h3>Sauvegarde</h3>
            <div className="backup-info">
              <div className="backup-status">
                <span className={`status-indicator ${stats.backupStatus.toLowerCase()}`}></span>
                <span>{stats.backupStatus}</span>
              </div>
              <div className="last-backup">
                Dernière sauvegarde: {stats.lastBackup}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section Applications - déplacée juste après la vue d'ensemble */}
      <section className="settings-section">
        <h2>Gestion des Applications</h2>
        {/* Modal pour afficher les détails d'une application */}
        {selectedApp && (
          <div className="docker-app-details-modal">
            <div className="docker-app-details-content">
              <div className="docker-app-details-header">
                <h3>{selectedApp.name}</h3>
                <button className="docker-close-btn" onClick={closeAppDetails}>×</button>
              </div>
              <div className="docker-app-details-body">
                <div className="docker-app-status-info">
                  <div className={`docker-app-status ${
                    selectedApp.status === 'running' && selectedApp.progress === 100 ? 'running' : 
                    selectedApp.status === 'starting' || selectedApp.status === 'partial' ? 'starting' : 
                    'stopped'
                  }`}>
                    <span className="docker-status-icon"></span>
                    <span className="docker-status-text">
                      {selectedApp.status === 'running' && selectedApp.progress === 100 ? 'Opérationnel' : 
                       selectedApp.status === 'starting' ? 'En train de démarrer...' :
                       selectedApp.status === 'partial' ? 'Démarrage partiel' :
                       'Arrêté'}
                    </span>
                  </div>
                  <div className="docker-app-progress">
                    <div className="docker-progress-bar">
                      <div 
                        className="docker-progress-fill" 
                        style={{ width: `${selectedApp.progress}%` }}
                      ></div>
                    </div>
                    <span className="docker-progress-text">{selectedApp.progress}% ({selectedApp.containersRunning})</span>
                  </div>
                </div>
                <div className="docker-app-info-section">
                  <h4>Ports</h4>
                  {selectedApp.ports && selectedApp.ports.length > 0 ? (
                    <div className="docker-ports-list">
                      {selectedApp.ports.map(port => (
                        <div key={port} className="docker-port-tag">
                          {port}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>Aucun port exposé</p>
                  )}
                </div>
                <div className="docker-app-info-section">
                  <h4>Conteneurs</h4>
                  <div className="docker-containers-list">
                    {selectedApp.containers && selectedApp.containers.map(container => (
                      <div key={container.id} className="docker-container-item">
                        <div className="docker-container-name">{container.name}</div>
                        <div className={`docker-container-status ${container.state}`}>
                          {container.state}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {isAdmin && (
                  <div className="docker-app-actions">
                    <button
                      className={`docker-action-btn-large ${selectedApp.status === 'running' && selectedApp.progress > 0 ? 'stop' : 'start'}`}
                      onClick={() => handleAppAction(selectedApp.id, (selectedApp.status === 'running' && selectedApp.progress > 0) ? 'stop' : 'start')}
                    >
                      {(selectedApp.status === 'running' && selectedApp.progress > 0) ? 'Arrêter tous les conteneurs' : 'Démarrer tous les conteneurs'}
                    </button>
                    <button
                      className="docker-action-btn-large restart"
                      onClick={() => handleAppAction(selectedApp.id, 'restart')}
                      disabled={!(selectedApp.status === 'running' && selectedApp.progress > 0)}
                    >
                      Redémarrer tous les conteneurs
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {appsLoading ? (
          <div className="docker-loading-container">
            <div className="docker-loading-spinner"></div>
            <p>Chargement des applications...</p>
          </div>
        ) : appsError ? (
          <div className="docker-error-container">
            <p className="docker-error-message">{appsError}</p>
            <button className="docker-retry-button" onClick={fetchApplications}>Réessayer</button>
          </div>
        ) : applications.length === 0 ? (
          <div className="docker-empty-state">
            <p>Aucune application Docker détectée.</p>
          </div>
        ) : (
          <div className="docker-apps-grid">
            {applications.map(app => (
              <div 
                key={app.id} 
                className={`docker-app-card ${selectedApp && selectedApp.id === app.id ? 'active' : ''}`}
                onClick={() => handleAppSelect(app)}
              >
                <div className="docker-app-header">
                  <h3>{app.name}</h3>
                  <span className={`docker-status-badge ${
                    app.status === 'running' && app.progress === 100 ? 'running' : 
                    app.status === 'starting' || app.status === 'partial' ? 'starting' : 
                    'stopped'
                  }`}>
                    {app.status === 'running' && app.progress === 100 ? 'En cours' : 
                     app.status === 'starting' ? 'Démarrage...' :
                     app.status === 'partial' ? 'Partiel' :
                     'Arrêté'}
                  </span>
                </div>
                {appActionStatus.show && appActionStatus.appId === app.id && (
                  <div className={`docker-action-status ${appActionStatus.success ? 'success' : 'error'}`}>
                    {appActionStatus.message}
                  </div>
                )}
                {isAdmin && (
                  <div className="docker-app-controls">
                    <button
                      className={`docker-action-btn ${app.status === 'running' && app.progress > 0 ? 'stop' : 'start'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAppAction(app.id, (app.status === 'running' && app.progress > 0) ? 'stop' : 'start')
                      }}
                    >
                      {(app.status === 'running' && app.progress > 0) ? 'Arrêter' : 'Démarrer'}
                    </button>
                    <button
                      className="docker-action-btn restart"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAppAction(app.id, 'restart')
                      }}
                      disabled={!(app.status === 'running' && app.progress > 0)}
                    >
                      Redémarrer
                    </button>
                    <div className="docker-autostart-control" onClick={(e) => e.stopPropagation()}>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={app.autostart}
                          onChange={(e) => handleAppAutostart(app.id, e.target.checked)}
                        />
                        <span className="slider"></span>
                      </label>
                      <span className="docker-autostart-label">Auto</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Overlay Assistant Stockage */}
      {showStorageOverlay && (
        <div
          className="storage-assistant-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(2px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            animation: 'fadeIn 0.3s ease-out'
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowStorageOverlay(false);
          }}
        >
          <div
            className="storage-assistant-modal"
            style={{
              width: '92vw',
              height: '86vh',
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
              overflow: 'hidden',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              animation: 'modalSlideUp 0.4s ease-out'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                position: 'absolute',
                top: 8,
                right: 20,
                display: 'flex',
                gap: 8,
                zIndex: 2
              }}
            >
              <button
                onClick={() => setShowStorageOverlay(false)}
                title="Fermer"
                style={{
                  border: '1px solid #ddd',
                  background: '#fff',
                  borderRadius: 8,
                  padding: '6px 10px',
                  cursor: 'pointer'
                }}
              >
                ✕
              </button>
            </div>
            {/* Contenu: composant StorageSettings directement */}
            <div style={{ 
              flex: 1, 
              overflow: 'auto',
              animation: 'fadeIn 0.4s ease-out 0.2s backwards'
            }}>
              <StorageSettings />
            </div>
          </div>
        </div>
      )}

      {/* Modal Détails Disques */}
      {showDisksInfo && systemDisksInfo && (
        <div className="disks-modal-overlay">
          <div className="disks-modal">
            <div className="disks-modal-header">
              <h3>Détails des disques</h3>
              <button className="close-modal-btn" onClick={() => setShowDisksInfo(false)}>×</button>
            </div>
            <div className="disks-modal-content">
              <div className="disks-grid">
                {systemDisksInfo.disks.map((disk, idx) => {
                  // Calcul du pourcentage d'utilisation
                  const usedSizeGB = parseFloat(disk.used.replace(' GB', ''));
                  const totalSizeGB = parseFloat(disk.size.replace(' GB', ''));
                  const usedPercentage = Math.round((usedSizeGB / totalSizeGB) * 100) || 0;
                  
                  return (
                    <div key={idx} className={`disk-card ${disk.mounted ? 'mounted' : 'unmounted'}`}>
                      <div className="disk-header">
                        <div className="disk-name-with-status">
                          <FontAwesomeIcon icon={faHdd} className={`disk-icon-visual ${disk.mounted ? 'mounted' : 'unmounted'}`} />
                          <div className="disk-title-area">
                            <h4>{disk.device}</h4>
                            <div className={`disk-status-badge ${disk.mounted ? 'mounted' : 'unmounted'}`}>
                              <span className="status-dot"></span>
                              {disk.mounted ? 'Monté' : 'Démonté'}
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      <div className="disk-details">
                        <div className="disk-info-rows">
                          <div className="disk-info-row">
                            <span>Capacité:</span>
                            <strong>{disk.size}</strong>
                          </div>
                          <div className="disk-info-row">
                            <span>Utilisé:</span>
                            <strong>{disk.used}</strong>
                          </div>
                          <div className="disk-info-row">
                            <span>Libre:</span>
                            <strong>{disk.free}</strong>
                          </div>
                        </div>
                        
                        {disk.mounted ? (
                          <div className="disk-usage-bar-container">
                            <div className="disk-usage-label">
                              <span>Utilisation:</span>
                              <strong>{usedPercentage}%</strong>
                            </div>
                            <div className="disk-usage-bar">
                              <div 
                                className="disk-usage-fill" 
                                style={{ width: `${usedPercentage}%` }}
                              ></div>
                            </div>
                          </div>
                        ) : (
                          <button 
                            className="mount-disk-button"
                            onClick={() => console.log(`Monter le disque ${disk.device}`)}
                          >
                            <FontAwesomeIcon icon={faPlug} /> Monter le disque
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              
              <div className="disk-total-card">
                <div className="disk-total-header">
                  <FontAwesomeIcon icon={faDatabase} className="disk-total-icon" />
                  <h3>Stockage Total</h3>
                </div>
                
                <div className="disk-total-content">
                  <div className="disk-info-rows">
                    <div className="disk-info-row">
                      <span>Capacité:</span>
                      <strong>{systemDisksInfo.total.size}</strong>
                    </div>
                    <div className="disk-info-row">
                      <span>Utilisé:</span>
                      <strong>{systemDisksInfo.total.used}</strong>
                    </div>
                    <div className="disk-info-row">
                      <span>Libre:</span>
                      <strong>{systemDisksInfo.total.free}</strong>
                    </div>
                  </div>
                  
                  {/* Calcul du pourcentage d'utilisation pour le total */}
                  {(() => {
                    const totalUsedGB = parseFloat(systemDisksInfo.total.used.replace(' GB', ''));
                    const totalSizeGB = parseFloat(systemDisksInfo.total.size.replace(' GB', ''));
                    const totalUsedPercentage = Math.round((totalUsedGB / totalSizeGB) * 100) || 0;
                    
                    return (
                      <div className="disk-usage-bar-container total">
                        <div className="disk-usage-label">
                          <span>Utilisation globale:</span>
                          <strong>{totalUsedPercentage}%</strong>
                        </div>
                        <div className="disk-usage-bar">
                          <div 
                            className="disk-usage-fill" 
                            style={{ width: `${totalUsedPercentage}%` }}
                          ></div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Section Téléchargements */}
      <section className="settings-section">
        <h2>Configuration des téléchargements</h2>
        <div className="settings-grid">
          <div className="setting-item">
            <div className="setting-info">
              <h3>Dossier de téléchargement</h3>
              <p>Emplacement où seront sauvegardés les fichiers téléchargés</p>
              {changeStatus.show && (
                <div className={`status-message ${changeStatus.success ? 'success' : 'error'}`}>
                  {changeStatus.success 
                    ? "✓ Dossier modifié avec succès" 
                    : "✗ Erreur lors du changement de dossier"}
                </div>
              )}
            </div>
            <div className="setting-control">
              <button 
                onClick={() => handleSettingChange('downloadPath')} 
                className="setting-button"
              >
                <span className="setting-value">{settings.downloadPath}</span>
                <span className="setting-action">Modifier</span>
              </button>
            </div>
          </div>
        </div>
      </section>
      
      {/* Section Paramètres */}
      <section className="settings-section">
        <h2>Configuration du Cloud</h2>
        <div className="settings-grid">
          {/* Sauvegardes */}
          <div className="settings-card">
            <h3>Sauvegardes</h3>
            <div className="setting-item">
              <label>Sauvegarde automatique</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.autoBackup}
                  onChange={(e) => handleSettingChange('autoBackup', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
            <div className="setting-item">
              <label>Fréquence des sauvegardes</label>
              <select
                value={settings.backupFrequency}
                onChange={(e) => handleSettingChange('backupFrequency', e.target.value)}
                disabled={!settings.autoBackup}
              >
                <option value="hourly">Toutes les heures</option>
                <option value="daily">Quotidienne</option>
                <option value="weekly">Hebdomadaire</option>
                <option value="monthly">Mensuelle</option>
              </select>
            </div>
          </div>

          {/* Sécurité */}
          <div className="settings-card">
            <h3>Sécurité</h3>
            {changeStatus.show && (
              <div className={`status-message ${changeStatus.success ? 'success' : 'error'}`} style={{ marginBottom: '12px' }}>
                {changeStatus.message}
              </div>
            )}
            <div className="setting-item">
              <label>Durée de session</label>
              <select
                value={tokenExpiration}
                onChange={(e) => handleTokenExpirationChange(e.target.value)}
                className="setting-select"
              >
                <option value="5">5 minutes</option>
                <option value="15">15 minutes (recommandé)</option>
                <option value="30">30 minutes</option>
                <option value="60">1 heure</option>
                <option value="120">2 heures</option>
                <option value="240">4 heures</option>
                <option value="480">8 heures</option>
                <option value="1440">24 heures</option>
              </select>
              <p className="setting-hint" style={{ fontSize: '0.85em', color: '#666', marginTop: '4px' }}>
                Reconnexion requise après {tokenExpiration} minute{tokenExpiration > 1 ? 's' : ''} d'inactivité
              </p>
            </div>
            <div className="setting-item">
              <label>Chiffrement des données</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.encryptionEnabled}
                  onChange={(e) => handleSettingChange('encryptionEnabled', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
            <div className="setting-item">
              <label>Authentification à deux facteurs</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.twoFactorAuth}
                  onChange={(e) => handleSettingChange('twoFactorAuth', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
          </div>

          {/* Notifications */}
          <div className="settings-card">
            <h3>Notifications</h3>
            <div className="setting-item">
              <label>Activer les notifications</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.notificationsEnabled}
                  onChange={(e) => handleSettingChange('notificationsEnabled', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
          </div>

          {/* Préférences */}
          <div className="settings-card">
            <h3>Préférences</h3>
            <div className="setting-item">
              <label>Mode sombre</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.darkMode}
                  onChange={(e) => handleSettingChange('darkMode', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
          </div>

          {/* Performance */}
          <div className="settings-card">
            <h3>Performance</h3>
            <div className="setting-item">
              <label>Niveau de compression</label>
              <select
                value={settings.compressionLevel}
                onChange={(e) => handleSettingChange('compressionLevel', e.target.value)}
              >
                <option value="none">Aucune compression</option>
                <option value="low">Faible</option>
                <option value="medium">Moyenne</option>
                <option value="high">Élevée</option>
              </select>
            </div>
            <div className="setting-item">
              <label>Limite de bande passante</label>
              <select
                value={settings.bandwidthLimit}
                onChange={(e) => handleSettingChange('bandwidthLimit', e.target.value)}
              >
                <option value="unlimited">Illimitée</option>
                <option value="1000">1 Gbps</option>
                <option value="500">500 Mbps</option>
                <option value="100">100 Mbps</option>
              </select>
            </div>
          </div>

          {/* Nettoyage automatique */}
          <div className="settings-card">
            <h3>Nettoyage automatique</h3>
            <div className="setting-item">
              <label>Suppression automatique des fichiers anciens</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.autoDelete}
                  onChange={(e) => handleSettingChange('autoDelete', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
            <div className="setting-item">
              <label>Période de conservation (jours)</label>
              <select
                value={settings.autoDeletionPeriod}
                onChange={(e) => handleSettingChange('autoDeletionPeriod', e.target.value)}
                disabled={!settings.autoDelete}
              >
                <option value="7">7 jours</option>
                <option value="30">30 jours</option>
                <option value="90">90 jours</option>
                <option value="180">180 jours</option>
                <option value="365">365 jours</option>
              </select>
            </div>
          </div>

          {/* Mode d'accès */}
          <div className="setting-item">
            <div className="setting-info">
              <h3>Mode d'accès</h3>
              <p>Définit comment l'application se connecte au serveur Ryvie</p>
              {changeStatus.show && (
                <div className={`status-message ${changeStatus.success ? 'success' : 'error'}`}>
                  {changeStatus.success 
                    ? changeStatus.message || "✓ Paramètre modifié avec succès" 
                    : "✗ Erreur lors du changement de paramètre"}
                </div>
              )}
            </div>
            <div className="setting-control">
              <div className="toggle-buttons">
                <button 
                  className={`toggle-button ${accessMode === 'private' ? 'active' : ''}`}
                  onClick={() => handleAccessModeChange('private')}
                >
                  Privé (Local)
                </button>
                <button 
                  className={`toggle-button ${accessMode === 'public' ? 'active' : ''}`}
                  onClick={() => handleAccessModeChange('public')}
                >
                  Public (Internet)
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section Stockage (lecture seule + accès assistant) */}
      <section className="settings-section">
        <h2>Configuration du Stockage</h2>
        <div style={{ marginBottom: 16 }}>
          <button
            className="setting-button raid-assistant-btn"
            onClick={() => setShowStorageOverlay(true)}
            style={{ 
              background: 'linear-gradient(135deg, #1976d2 0%, #1565c0 100%)',
              color: '#fff',
              border: 'none',
              padding: '14px 24px',
              fontSize: '16px',
              fontWeight: '600',
              boxShadow: '0 4px 12px rgba(25, 118, 210, 0.3)',
              transition: 'all 0.3s ease',
              position: 'relative',
              overflow: 'hidden'
            }}
          >
            <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
              </svg>
              Ouvrir l'assistant RAID
            </span>
          </button>
        </div>
        <div className="storage-options">
          {/* Choix du stockage (comme avant) */}
          <div className="settings-card">
            <h3>Choix du stockage</h3>
            <div className="setting-item">
              <label>Stockage principal</label>
              <select
                value={settings.storageLocation}
                onChange={(e) => handleSettingChange('storageLocation', e.target.value)}
              >
                <option value="local">Serveur local</option>
                <option value="hybrid">Hybride</option>
              </select>
            </div>
            {settings.storageLocation === 'hybrid' && (
              <div className="ryvie-servers">
                <h4>Serveurs Ryvie disponibles</h4>
                {ryvieServers.map(server => (
                  <div key={server.id} className="server-item">
                    <div className="server-info">
                      <span className="server-name">{server.name}</span>
                      <span className="server-location">{server.location}</span>
                    </div>
                    <div className="server-status-settings">
                      <span className="ping">{server.ping}</span>
                      <span className={`status-dot ${server.status}`}></span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          

          {/* Disques détectés (lecture seule) */}
          <div className="settings-card">
            <h3>Disques détectés (lecture seule)</h3>
            {storageLoading ? (
              <p>Chargement de l'inventaire des disques...</p>
            ) : storageError ? (
              <div className="docker-error-container"><p className="docker-error-message">{storageError}</p></div>
            ) : (
              <div className="disks-grid">
                {(() => {
                  const items = [];
                  const block = storageInventory?.devices?.blockdevices || [];
                  const inRaidPaths = new Set();
                  // calculer les chemins des membres RAID pour badge
                  if (mdraidStatus?.members && Array.isArray(mdraidStatus.members)) {
                    mdraidStatus.members.forEach(m => {
                      const d = m.device;
                      if (d) {
                        const match = d.match(/\/dev\/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)/);
                        if (match) inRaidPaths.add(`/dev/${match[1]}`);
                      }
                    });
                  }
                  block.forEach(device => {
                    if (device.type === 'disk' && !device.name.includes('sr')) {
                      let isMounted = false; let mountInfo = '';
                      if (device.mountpoints && device.mountpoints[0]) {
                        isMounted = true; mountInfo = device.mountpoints[0];
                      }
                      if (device.children) {
                        device.children.forEach(child => {
                          if (child.mountpoints && child.mountpoints[0]) {
                            isMounted = true; if (!mountInfo) mountInfo = child.mountpoints[0];
                          }
                        });
                      }
                      const path = device.path || `/dev/${device.name}`;
                      const isSystemDisk = device.children?.some(ch => (ch.mountpoints && ch.mountpoints[0] === '/'));
                      items.push({
                        path,
                        name: device.name,
                        size: device.size,
                        isMounted,
                        mountInfo,
                        inRaid: inRaidPaths.has(path),
                        isSystemDisk
                      });
                    }
                  });
                  if (items.length === 0) return <div className="empty-state"><p>Aucun disque détecté</p></div>;
                  return items.map(disk => (
                    <div key={disk.path} className={`disk-card ${disk.isMounted ? 'mounted' : 'unmounted'}`}>
                      <div className="disk-header">
                        <div className="disk-name-with-status">
                          <FontAwesomeIcon icon={faHdd} className={`disk-icon-visual ${disk.isMounted ? 'mounted' : 'unmounted'}`} />
                          <div className="disk-title-area">
                            <h4>{disk.path}</h4>
                            <div className={`disk-status-badge ${disk.isMounted ? 'mounted' : 'unmounted'}`}>
                              <span className="status-dot"></span>
                              {disk.isMounted ? `Monté (${disk.mountInfo})` : 'Démonté'}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="disk-details">
                        <div className="disk-info-rows">
                          <div className="disk-info-row"><span>Taille:</span><strong>{disk.size}</strong></div>
                          <div className="disk-info-row"><span>RAID :</span><strong>{disk.inRaid ? 'Oui' : 'Non'}</strong></div>
                          {disk.isSystemDisk && (
                            <div className="disk-info-row"><span>Rôle:</span><strong>Système</strong></div>
                          )}
                        </div>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section Adresses Publiques */}
      {publicAddresses && (
        <section className="settings-section">
          <h2>
            <FontAwesomeIcon icon={faGlobe} style={{ marginRight: '8px' }} />
            Adresses Publiques
          </h2>
          <p className="setting-description" style={{ marginBottom: '16px', color: '#666' }}>
            Vos applications sont accessibles via ces adresses publiques
          </p>
          
          {!showPublicAddresses ? (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <button
                onClick={() => setShowPublicAddresses(true)}
                style={{
                  padding: '12px 24px',
                  background: '#1976d2',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '15px',
                  fontWeight: '600',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  transition: 'all 0.2s',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
                onMouseOver={(e) => e.currentTarget.style.background = '#1565c0'}
                onMouseOut={(e) => e.currentTarget.style.background = '#1976d2'}
              >
                <FontAwesomeIcon icon={faGlobe} />
                Découvrir les adresses
              </button>
            </div>
          ) : (
            <div className="settings-grid">
              <div className="settings-card" style={{ gridColumn: '1 / -1' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' }}>
                  {Object.entries(publicAddresses).map(([key, domain]) => {
                    const fullUrl = `https://${domain}`;
                    const isCopied = copiedAddress === fullUrl;
                    
                    return (
                      <div
                        key={key}
                        style={{
                          padding: '12px 16px',
                          background: '#f8f9fa',
                          borderRadius: '8px',
                          border: '1px solid #e0e0e0',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '12px',
                          transition: 'all 0.2s'
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px', fontWeight: '600', textTransform: 'uppercase' }}>
                            {key}
                          </div>
                          <a
                            href={fullUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: '14px',
                              color: '#1976d2',
                              textDecoration: 'none',
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                            title={fullUrl}
                          >
                            {domain}
                          </a>
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              if (navigator.clipboard && navigator.clipboard.writeText) {
                                await navigator.clipboard.writeText(fullUrl);
                                setCopiedAddress(fullUrl);
                                setTimeout(() => setCopiedAddress(null), 2000);
                              } else {
                                // Fallback pour les navigateurs qui ne supportent pas clipboard API
                                const textArea = document.createElement('textarea');
                                textArea.value = fullUrl;
                                textArea.style.position = 'fixed';
                                textArea.style.left = '-999999px';
                                document.body.appendChild(textArea);
                                textArea.select();
                                try {
                                  document.execCommand('copy');
                                  setCopiedAddress(fullUrl);
                                  setTimeout(() => setCopiedAddress(null), 2000);
                                } catch (err) {
                                  console.error('Erreur lors de la copie:', err);
                                }
                                document.body.removeChild(textArea);
                              }
                            } catch (err) {
                              console.error('Erreur lors de la copie:', err);
                            }
                          }}
                          style={{
                            padding: '8px 12px',
                            background: isCopied ? '#4caf50' : '#fff',
                            color: isCopied ? '#fff' : '#666',
                            border: isCopied ? '1px solid #4caf50' : '1px solid #ddd',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: '500',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            transition: 'all 0.2s',
                            whiteSpace: 'nowrap'
                          }}
                          title="Copier l'adresse"
                        >
                          <FontAwesomeIcon icon={isCopied ? faCheck : faCopy} />
                          {isCopied ? 'Copié !' : 'Copier'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Modal Détail du Stockage */}
      {showStorageDetail && (
        <div 
          className="storage-detail-overlay"
          onClick={() => setShowStorageDetail(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '20px'
          }}
        >
          <div 
            className="storage-detail-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: '16px',
              maxWidth: '600px',
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)'
            }}
          >
            {/* Header */}
            <div style={{
              padding: '24px 24px 16px',
              borderBottom: '1px solid #f0f0f0'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <h2 style={{ margin: 0, fontSize: '24px', fontWeight: '600' }}>Stockage</h2>
                <button
                  onClick={() => setShowStorageDetail(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '28px',
                    cursor: 'pointer',
                    color: '#666',
                    padding: '0',
                    width: '32px',
                    height: '32px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  ×
                </button>
              </div>
              {storageDetail && (
                <div style={{ marginTop: '8px', fontSize: '14px', color: '#666' }}>
                  {storageDetail.summary.usedFormatted} utilisés sur {storageDetail.summary.totalFormatted}
                </div>
              )}
            </div>

            {/* État de chargement ou contenu */}
            {storageDetailLoading ? (
              <div style={{ padding: '60px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: '16px', color: '#666', marginBottom: '12px' }}>
                  Analyse du stockage en cours...
                </div>
                <div style={{ fontSize: '14px', color: '#999' }}>
                  Cela peut prendre quelques secondes
                </div>
              </div>
            ) : storageDetail ? (
              <>
                {/* Barre de visualisation */}
                <div style={{ padding: '24px' }}>
              <div style={{
                height: '40px',
                borderRadius: '8px',
                overflow: 'hidden',
                display: 'flex',
                background: '#f0f0f0'
              }}>
                {/* Système */}
                <div style={{
                  width: `${(storageDetail.summary.system / storageDetail.summary.total) * 100}%`,
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  transition: 'width 0.3s'
                }} />
                {/* Apps */}
                <div style={{
                  width: `${(storageDetail.summary.apps / storageDetail.summary.total) * 100}%`,
                  background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                  transition: 'width 0.3s'
                }} />
                {/* Autres */}
                <div style={{
                  width: `${(storageDetail.summary.others / storageDetail.summary.total) * 100}%`,
                  background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
                  transition: 'width 0.3s'
                }} />
              </div>

              {/* Légende */}
              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                    }} />
                    <span style={{ fontSize: '14px' }}>Système</span>
                  </div>
                  <span style={{ fontSize: '14px', fontWeight: '600' }}>
                    {storageDetail.summary.systemFormatted}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'
                    }} />
                    <span style={{ fontSize: '14px' }}>Applications</span>
                  </div>
                  <span style={{ fontSize: '14px', fontWeight: '600' }}>
                    {storageDetail.summary.appsFormatted}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)'
                    }} />
                    <span style={{ fontSize: '14px' }}>Autres</span>
                  </div>
                  <span style={{ fontSize: '14px', fontWeight: '600' }}>
                    {storageDetail.summary.othersFormatted}
                  </span>
                </div>
              </div>
            </div>

            {/* Liste des applications */}
            <div style={{
              padding: '0 24px 24px',
              borderTop: '1px solid #f0f0f0'
            }}>
              <h3 style={{ margin: '16px 0 12px', fontSize: '18px', fontWeight: '600' }}>
                Applications ({storageDetail.apps.length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {storageDetail.apps.map((app) => {
                  const serverUrl = getServerUrl(accessMode);
                  return (
                    <div
                      key={app.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px',
                        background: '#f9f9f9',
                        borderRadius: '8px',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#f0f0f0'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#f9f9f9'}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {app.icon && (
                          <img
                            src={`${serverUrl}${app.icon}`}
                            alt={app.name}
                            style={{
                              width: '40px',
                              height: '40px',
                              borderRadius: '8px',
                              objectFit: 'cover'
                            }}
                          />
                        )}
                        <span style={{ fontSize: '15px', fontWeight: '500' }}>{app.name}</span>
                      </div>
                      <span style={{ fontSize: '15px', fontWeight: '600', color: '#666' }}>
                        {app.sizeFormatted}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
