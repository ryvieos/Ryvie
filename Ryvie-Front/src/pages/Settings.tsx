import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import '../styles/Settings.css';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faServer, faHdd, faDatabase, faPlug, faGlobe, faCheck, faCopy } from '@fortawesome/free-solid-svg-icons';
import { isElectron } from '../utils/platformUtils';
import urlsConfig from '../config/urls';
const { getServerUrl, getFrontendUrl } = urlsConfig;
import { getCurrentAccessMode, setAccessMode as setGlobalAccessMode, testServerConnectivity } from '../utils/detectAccessMode';
import { useSocket } from '../contexts/SocketContext';
import { getCurrentUserRole, getCurrentUser, startSession, isSessionActive, getSessionInfo, endSession } from '../utils/sessionManager';
import StorageSettings from './StorageSettings';
import { useUpdate } from '../contexts/UpdateContext';
import { useLanguage } from '../contexts/LanguageContext';

const Settings = () => {
  const navigate = useNavigate();
  const { language, setLanguage, t } = useLanguage();
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
          activeUsers: 0,
          totalApps: 0,
          raidDuplication: 'inactif',
        };
      }
    }
    return {
      storageUsed: 0,
      storageLimit: 0,
      cpuUsage: 0,
      ramUsage: 0,
      activeUsers: 0,
      totalApps: 0,
      raidDuplication: 'inactif',
    };
  });

  const [settings, setSettings] = useState({
    autoBackup: true,
    backupFrequency: 'daily',
    encryptionEnabled: true,
    twoFactorAuth: false,
    notificationsEnabled: true,
    darkMode: (() => {
      try {
        const currentUser = getCurrentUser();
        if (currentUser) {
          const cached = localStorage.getItem(`ryvie_dark_mode_${currentUser}`);
          if (cached === 'true' || cached === 'false') return cached === 'true';
        }
      } catch {}
      return false;
    })(),
    autoTheme: (() => {
      try {
        const currentUser = getCurrentUser();
        if (currentUser) {
          const cached = localStorage.getItem(`ryvie_auto_theme_${currentUser}`);
          if (cached === 'false') return false;
        }
      } catch {}
      return true;
    })(),
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
  // État pour afficher toutes les apps ou seulement une ligne
  const [showAllApps, setShowAllApps] = useState(false);

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
  const [toasts, setToasts] = useState([]);
  const [confirmDialog, setConfirmDialog] = useState({ show: false, title: '', message: '', onConfirm: null });
  const [tokenExpiration, setTokenExpiration] = useState(15); // En minutes, par défaut 15
  
  // Fonction pour afficher un toast moderne
  const showToast = (message, type = 'success') => {
    const id = Date.now();
    const newToast = { id, message, type };
    setToasts(prev => [...prev, newToast]);
    
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  
  // Fonction pour afficher une confirmation moderne
  const showConfirm = (title, message) => {
    return new Promise((resolve) => {
      setConfirmDialog({
        show: true,
        title,
        message,
        onConfirm: () => {
          setConfirmDialog({ show: false, title: '', message: '', onConfirm: null });
          resolve(true);
        },
        onCancel: () => {
          setConfirmDialog({ show: false, title: '', message: '', onConfirm: null });
          resolve(false);
        }
      });
    });
  };
  const [backgroundImage, setBackgroundImage] = useState('default'); // Fond d'écran
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [dragActive, setDragActive] = useState(false);
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
    // Fallback sécurisé: en HTTPS forcer remote, sinon rester remote pour éviter erreurs DNS
    try {
      if (typeof window !== 'undefined' && window.location?.protocol === 'https:') return 'remote';
    } catch {}
    return 'remote';
  });
  const [systemDisksInfo, setSystemDisksInfo] = useState(null);
  const [showDisksInfo, setShowDisksInfo] = useState(false);

  const { socket, isConnected: socketConnected, serverStatus: serverConnectionStatus } = useSocket();
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
  const [setupKey, setSetupKey] = useState(null);
  const [showSetupKey, setShowSetupKey] = useState(false);
  const [copiedSetupKey, setCopiedSetupKey] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false); // préférences utilisateur chargées
  // Rôle de l'utilisateur pour contrôler l'accès aux boutons
  const [userRole, setUserRole] = useState('User');
  const isAdmin = String(userRole || '').toLowerCase() === 'admin';
  // État pour le détail du stockage
  const [showStorageDetail, setShowStorageDetail] = useState(false);
  const [storageDetail, setStorageDetail] = useState(null);
  const [storageDetailLoading, setStorageDetailLoading] = useState(false);
  // État pour les mises à jour
  const [updates, setUpdates] = useState(null);
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updateInProgress, setUpdateInProgress] = useState(null); // 'ryvie' ou nom de l'app
  // Utiliser le contexte global pour la mise à jour
  const { startUpdate } = useUpdate();

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
    } else {
      // Si pas de paramètres URL, restaurer le token depuis le sessionManager
      const sessionInfo = getSessionInfo();
      if (sessionInfo && sessionInfo.token) {
        console.log('[Settings] Restauration du token depuis sessionManager');
        // Réinjecter le token dans les headers axios
        axios.defaults.headers.common['Authorization'] = `Bearer ${sessionInfo.token}`;
      }
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
        
        // Charger les adresses publiques et setup key depuis l'API backend
        try {
          const serverUrl = getServerUrl('private');
          const response = await axios.get(`${serverUrl}/api/settings/ryvie-domains`);
          if (response.data && response.data.domains) {
            setPublicAddresses(response.data.domains);
          }
          if (response.data && response.data.setupKey) {
            setSetupKey(response.data.setupKey);
          }
        } catch (error) {
          console.log('[Settings] Impossible de charger les domaines Netbird:', error);
        }
        
        setLoading(false);
      } catch (error) {
        console.error('Error fetching settings:', error);
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Scroll automatique vers la section Mises à Jour si demandé via l'URL (#updates)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Support BrowserRouter et HashRouter.
    // - BrowserRouter: /settings#updates  => window.location.hash === '#updates'
    // - HashRouter:    /#/settings#updates => window.location.hash === '#/settings#updates'
    const rawHash = String(window.location.hash || '');
    const lastHashPart = rawHash.split('#').filter(Boolean).pop();
    if (lastHashPart !== 'updates') return;

    let attempts = 0;
    const maxAttempts = 30; // ~3s

    const tryScroll = () => {
      attempts += 1;
      const el = document.getElementById('ryvie-updates');
      if (el) {
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Fallback: forcer le scroll window si nécessaire
          const top = el.getBoundingClientRect().top;
          if (typeof window !== 'undefined' && Math.abs(top) > 40) {
            window.scrollTo({ top: window.scrollY + top - 16, behavior: 'smooth' });
          }
          return;
        } catch (_) {
          // continuer
        }
      }

      if (attempts < maxAttempts) {
        setTimeout(tryScroll, 100);
      }
    };

    const t = setTimeout(tryScroll, 100);
    return () => clearTimeout(t);
  }, []);

  // Appliquer le mode sombre le plus tôt possible pour éviter le flash
  useLayoutEffect(() => {
    if (settings.darkMode) {
      document.body.classList.add('dark-mode');
      console.log('[Settings] Mode sombre appliqué');
    } else {
      document.body.classList.remove('dark-mode');
      console.log('[Settings] Mode sombre désactivé');
    }
    // Sauvegarder dans localStorage scopé par utilisateur pour cache
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        localStorage.setItem(`ryvie_dark_mode_${currentUser}`, String(!!settings.darkMode));
      }
    } catch {}
  }, [settings.darkMode]);

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
        
        // Charger fond d'écran et mode sombre
        const prefsResponse = await axios.get(`${serverUrl}/api/user/preferences`);
        if (prefsResponse.data?.backgroundImage) {
          setBackgroundImage(prefsResponse.data.backgroundImage);
          // Mettre en cache pour affichage instantan e dans Home
          try {
            const currentUser = getCurrentUser();
            if (currentUser) {
              localStorage.setItem(`ryvie_bg_${currentUser}`, prefsResponse.data.backgroundImage);
            }
          } catch {}
        }
        
        // Charger le mode sombre et autoTheme
        if (prefsResponse.data?.darkMode !== undefined) {
          console.log('[Settings] Mode sombre chargé:', prefsResponse.data.darkMode);
          setSettings(prev => ({
            ...prev,
            darkMode: prefsResponse.data.darkMode
          }));
        }
        
        // Charger autoTheme (par défaut true si non défini)
        const autoTheme = prefsResponse.data?.autoTheme !== undefined ? prefsResponse.data.autoTheme : true;
        console.log('[Settings] AutoTheme chargé:', autoTheme);
        setSettings(prev => ({
          ...prev,
          autoTheme: autoTheme
        }));
        
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
        
        // PRÉCHARGEMENT pour Home.js: charger appsConfig et launcher en cache
        console.log('[Settings] 🚀 Préchargement des données pour Home...');
        try {
          // 1. Charger les manifests pour appsConfig (comme dans Home.js)
          const manifestsResponse = await axios.get(`${serverUrl}/api/manifests`);
          if (manifestsResponse.data?.manifests) {
            const { generateAppConfigFromManifests } = await import('../config/appConfig');
            const config = generateAppConfigFromManifests(manifestsResponse.data.manifests);
            // Mettre en cache pour Home.js
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem('appsConfig_cache', JSON.stringify(config));
              console.log('[Settings] ✅ appsConfig mis en cache');
            }
          }
          
          // 2. Précharger les préférences launcher (layout, anchors, widgets)
          if (prefsResponse.data?.launcher) {
            const currentUser = getCurrentUser();
            if (currentUser && typeof localStorage !== 'undefined') {
              localStorage.setItem(`launcher_${currentUser}`, JSON.stringify(prefsResponse.data.launcher));
              console.log('[Settings] ✅ Launcher mis en cache pour', currentUser);
            }
          }
        } catch (e) {
          console.warn('[Settings] Préchargement partiel:', e?.message);
        }
      } catch (error) {
        console.log('[Settings] Impossible de charger les préférences utilisateur');
      } finally {
        setPrefsLoaded(true);
      }
    };
    
    loadUserPreferences();
  }, [accessMode]);

  // Synchroniser automatiquement le mode sombre avec le thème système
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (!prefsLoaded) return; 
    if (!settings.autoTheme) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applySystemTheme = () => {
      try {
        const preferDark = !!media.matches;
        if (preferDark !== !!settings.darkMode) {
          // Utilise le handler existant pour mettre à jour l'état et persister côté backend
          handleSettingChange('darkMode', preferDark);
        }
      } catch {}
    };

    // Appliquer au chargement (ex: si l'utilisateur est en mode sombre système)
    applySystemTheme();

    // Écouter les changements de thème système
    if (media.addEventListener) {
      media.addEventListener('change', applySystemTheme);
      return () => media.removeEventListener('change', applySystemTheme);
    } else if (media.addListener) {
      media.addListener(applySystemTheme);
      return () => media.removeListener(applySystemTheme);
    }
  }, [accessMode, settings.darkMode, settings.autoTheme, prefsLoaded]);

  // Vérification automatique des mises à jour au chargement
  useEffect(() => {
    if (!accessMode) return;
    
    // Vérifier les mises à jour automatiquement au chargement
    const loadUpdates = async () => {
      setUpdatesLoading(true);
      
      try {
        const serverUrl = getServerUrl(accessMode);
        console.log('[Settings] Vérification des mises à jour depuis:', serverUrl);
        const response = await axios.get(`${serverUrl}/api/settings/updates`);
        console.log('[Settings] Mises à jour:', response.data);
        setUpdates(response.data);
      } catch (error) {
        console.error('[Settings] Erreur lors de la vérification des mises à jour:', error);
        setUpdates(null);
      } finally {
        setUpdatesLoading(false);
      }
    };
    
    loadUpdates();
  }, [accessMode]);

  // Récupération des informations serveur (HTTP polling) - optimisé à 10s
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
    
    // Configuration de l'intervalle pour les mises à jour régulières (toutes les 10s pour réduire la charge)
    const intervalId = setInterval(fetchServerInfo, 5000);
    
    // Nettoyage lors du démontage du composant
    return () => {
      clearInterval(intervalId);
    };
  }, [accessMode]); // Réexécute l'effet si le mode d'accès change

  // Récupération live de la configuration stockage (lecture seule) - optimisé à 15s
  useEffect(() => {
    const fetchStorage = async () => {
      if (!accessMode) return;
      // Ne pas afficher le loader si on a déjà des données (refresh en arrière-plan)
      if (!storageInventory) {
        setStorageLoading(true);
      }
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
    
    // Appel initial
    fetchStorage();
    
    // Polling régulier toutes les 15 secondes (réduit de 5s pour limiter les requêtes)
    // Le resync RAID est un processus long, 15s est suffisant pour le monitoring
    const intervalId = setInterval(fetchStorage, 15000);
    
    return () => clearInterval(intervalId);
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
        ramUsage: ramUsage,
        activeUsers: data.activeUsers || 0,
        totalApps: data.totalApps || 0,
        raidDuplication: data.raidDuplication || 'inactif'
      };
      
      // Sauvegarder dans le cache localStorage pour chargement instantané
      localStorage.setItem('systemStats', JSON.stringify(newStats));
      
      return newStats;
    });
  };

  // Fonction utilitaire: détecter si un fond est personnalisé (custom)
  // RÈGLE SIMPLE: si commence par 'custom-' c'est un fond perso, sinon c'est un preset
  const isBackgroundCustom = (bgValue) => {
    if (!bgValue || typeof bgValue !== 'string') return false;
    return bgValue.startsWith('custom-');
  };

  // Fonction pour changer le fond d'écran
  const handleBackgroundChange = async (newBackground) => {
    console.log('[Settings] Changement fond d\'écran:', newBackground);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      // OPTIMISTE: appliquer immédiatement le fond dans l'UI
      setBackgroundImage(newBackground);
      // Mettre à jour le cache localStorage scopé par utilisateur
      try {
        const currentUser = getCurrentUser();
        if (currentUser) {
          localStorage.setItem(`ryvie_bg_${currentUser}`, newBackground);
        }
        // Notifier immédiatement les autres pages montées (Home) dans la même SPA
        try { window.dispatchEvent(new CustomEvent('ryvie:background-changed', { detail: newBackground })); } catch {}
      } catch {}
      // Sauvegarder en arrière-plan
      axios.patch(`${serverUrl}/api/user/preferences/background`, { backgroundImage: newBackground })
        .catch(err => console.warn('[Settings] Erreur patch background (async):', err?.message || err));
      showToast(t('settings.backgroundModified'), 'success');
    } catch (error) {
      console.error('[Settings] Erreur changement fond d\'écran:', error);
      showToast(t('settings.backgroundModifyError'), 'error');
    }
  };

  // Fonction pour uploader un fond d'écran personnalisé
  const handleBackgroundUpload = async (event) => {
    let files = [];
    
    if (event instanceof File) {
      files = [event];
    } else if (event.target?.files) {
      files = Array.from(event.target.files);
    }
    
    if (files.length === 0) return;
    
    for (const file of files) {
      await uploadSingleBackground(file);
    }
  };
  
  const uploadSingleBackground = async (file) => {
    if (!file) return;
    
    // Vérifier le type de fichier
    if (!file.type.startsWith('image/')) {
      showToast(t('settings.selectImage'), 'error');
      return;
    }
    
    // Vérifier la taille (max 5MB)
    if (file.size > 10 * 1024 * 1024) {
      showToast(t('settings.imageTooLarge'), 'error');
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
      
      showToast(t('settings.uploadSuccess', { fileName: file.name }), 'success');
    } catch (error) {
      console.error('[Settings] Erreur upload fond d\'écran:', error);
      showToast(t('settings.uploadError'), 'error');
    } finally {
      setUploadingBackground(false);
    }
  };
  
  // Handlers pour le drag and drop
  const dragCounter = useRef(0);
  
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  
  const handleDragIn = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setDragActive(true);
    }
  };
  
  const handleDragOut = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragActive(false);
    }
  };
  
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
      
      if (files.length === 0) {
        showToast('Veuillez déposer des images', 'error');
        return;
      }
      
      files.forEach(file => handleBackgroundUpload(file));
    }
  };

  // Fonction pour supprimer un fond personnalisé
  const handleDeleteBackground = async (filename) => {
    const confirmed = await showConfirm(
      'Supprimer le fond d\'écran',
      'Êtes-vous sûr de vouloir supprimer ce fond d\'écran ?'
    );
    
    if (!confirmed) return;
    
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
      
      showToast('Fond d\'écran supprimé', 'success');
    } catch (error) {
      console.error('[Settings] Erreur suppression fond:', error);
      showToast('Erreur lors de la suppression', 'error');
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
      showToast(`Durée de session modifiée: ${minutes} minute${minutes > 1 ? 's' : ''}`, 'success');
    } catch (error) {
      console.error('[Settings] Erreur lors du changement de durée de session:', error);
      console.error('[Settings] Détails erreur:', error.response?.data);
      
      const errorMessage = error.response?.data?.error || 'Erreur lors de la modification';
      showToast(errorMessage, 'error');
    }
  };

  // Fonction pour changer le mode d'accès
  const handleAccessModeChange = async (newMode) => {
    // Récupérer les informations de l'utilisateur actuel avant le changement
    const currentUser = getCurrentUser();
    const currentRole = getCurrentUserRole();
    const sessionInfo = getSessionInfo();
    const currentToken = sessionInfo.token;
    
    console.log(`[Settings] Changement de mode: ${accessMode} -> ${newMode}`);
    console.log(`[Settings] Utilisateur actuel: ${currentUser}, Rôle: ${currentRole}`);
    
    // Tester la connectivité avant de rediriger
    showToast(`Test de connectivité vers le mode ${newMode === 'remote' ? 'Remote' : 'Privé'}...`, 'info');
    
    const isAccessible = await testServerConnectivity(newMode, 3000);
    
    if (!isAccessible) {
      showToast(`❌ Impossible d'accéder au serveur en mode ${newMode === 'remote' ? 'Remote' : 'Privé'}. Vérifiez votre connexion.`, 'error');
      console.error(`[Settings] Serveur non accessible en mode ${newMode}`);
      return;
    }
    
    // Si accessible, procéder au changement
    // Mettre à jour le mode via le gestionnaire centralisé
    setGlobalAccessMode(newMode);
    
    // Mettre à jour l'état local
    setAccessMode(newMode);
    
    // Notifier le processus principal du changement seulement en mode Electron
    if (isElectron() && window.electronAPI && window.electronAPI.updateAccessMode) {
      window.electronAPI.updateAccessMode(newMode);
    }
    
    // Afficher un toast de confirmation
    showToast(`✓ Connexion réussie. Redirection vers le mode ${newMode === 'remote' ? 'Remote' : 'Privé'}...`, 'success');
    
    // Rediriger vers l'URL correspondante après 1.5 secondes
    setTimeout(() => {
      const frontendUrl = getFrontendUrl(newMode);
      const currentHash = window.location.hash || '#/settings';
      
      // Construire l'URL correctement (hash commence par #, pas besoin de /)
      const newUrl = `${frontendUrl}${currentHash}`;
      
      console.log(`[Settings] Redirection vers ${newMode}: ${newUrl}`);
      // Redirection dans le même onglet
      window.location.replace(newUrl);
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
          showToast('Dossier de téléchargement modifié', 'success');
        } else {
          showToast('Erreur lors de la modification', 'error');
        }
      } else {
        // En mode web, afficher un message informatif
        showToast('Modification du dossier de téléchargement non disponible en mode web', 'info');
      }
    } else if (setting === 'darkMode') {
      // Gestion spéciale pour le mode sombre
      setSettings(prev => ({
        ...prev,
        darkMode: value
      }));
      
      // Sauvegarder dans le backend
      try {
        const serverUrl = getServerUrl(accessMode);
        await axios.patch(`${serverUrl}/api/user/preferences/dark-mode`, { darkMode: value });
        console.log('[Settings] Mode sombre sauvegardé pour utilisateur:', value);
        
        // Mettre à jour le cache localStorage scopé par utilisateur
        try {
          const currentUser = getCurrentUser();
          if (currentUser) {
            localStorage.setItem(`ryvie_dark_mode_${currentUser}`, String(!!value));
          }
        } catch {}
        
        // RÈGLE STRICTE: Ne JAMAIS changer un fond personnalisé
        if (isBackgroundCustom(backgroundImage)) {
          console.log('[Settings] ⚠️ Fond personnalisé détecté, pas de changement automatique');
          return; // Sortir immédiatement sans toucher au fond
        }
        
        // Si on arrive ici, c'est un preset -> on peut le changer
        if (prefsLoaded) {
          console.log('[Settings] 🎨 Changement automatique du fond preset selon le thème');
          
          // Trouver les presets night et default
          const nightPreset = (presetBackgrounds || []).find(p => /night|nuit|dark/i.test(p?.name || p?.filename || ''));
          const defaultPreset = (presetBackgrounds || []).find(p => /default/i.test(p?.name || p?.filename || ''));
          
          const nightKey = nightPreset?.filename ? `preset-${nightPreset.filename}` : 'preset-night.png';
          const defaultKey = defaultPreset?.filename ? `preset-${defaultPreset.filename}` : 'preset-default.webp';
          
          const targetBg = value ? nightKey : defaultKey;
          
          console.log(`[Settings] Passage au fond: ${targetBg}`);
          await axios.patch(`${serverUrl}/api/user/preferences/background`, { backgroundImage: targetBg });
          setBackgroundImage(targetBg);
          // Mettre à jour le cache localStorage scopé par utilisateur
          try {
            const currentUser = getCurrentUser();
            if (currentUser) {
              localStorage.setItem(`ryvie_bg_${currentUser}`, targetBg);
            }
            // Notifier immédiatement les autres pages montées (Home) dans la même SPA
            try { window.dispatchEvent(new CustomEvent('ryvie:background-changed', { detail: targetBg })); } catch {}
          } catch {}
        }
      } catch (error) {
        console.error('[Settings] Erreur sauvegarde mode sombre:', error);
      }
    } else if (setting === 'autoTheme') {
      // Basculer le suivi du thème système
      setSettings(prev => ({
        ...prev,
        autoTheme: value
      }));
      // Sauvegarder autoTheme dans les préférences utilisateur backend
      try {
        const serverUrl = getServerUrl(accessMode);
        await axios.patch(`${serverUrl}/api/user/preferences`, { autoTheme: value });
        console.log('[Settings] AutoTheme sauvegardé pour utilisateur:', value);
        
        // Mettre à jour le cache localStorage scopé par utilisateur
        const currentUser = getCurrentUser();
        if (currentUser) {
          localStorage.setItem(`ryvie_auto_theme_${currentUser}`, String(!!value));
        }
      } catch (e) { console.warn('[Settings] Erreur sauvegarde autoTheme:', e?.message || e); }
      // Si on active Auto, appliquer immédiatement la préférence système
      try {
        if (value) {
          const preferDark = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
          const serverUrl = getServerUrl(accessMode);
          await axios.patch(`${serverUrl}/api/user/preferences/dark-mode`, { darkMode: preferDark });
          setSettings(prev => ({ ...prev, darkMode: preferDark }));
        }
      } catch (e) { console.warn('[Settings] Synchro darkMode avec système échouée:', e?.message || e); }
    } else if (setting === 'twoFactorAuth') {
      // Authentification à deux facteurs pas encore disponible
      showToast('L\'authentification à deux facteurs n\'est pas encore disponible', 'info');
      // Ne pas changer l'état
      return;
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

  // Fonction pour vérifier les mises à jour disponibles
  const fetchUpdates = async () => {
    setUpdatesLoading(true);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      console.log('[Settings] Vérification des mises à jour depuis:', serverUrl);
      const response = await axios.get(`${serverUrl}/api/settings/updates`);
      console.log('[Settings] Mises à jour:', response.data);
      setUpdates(response.data);
    } catch (error) {
      console.error('[Settings] Erreur lors de la vérification des mises à jour:', error);
      setUpdates(null);
    } finally {
      setUpdatesLoading(false);
    }
  };

  // Fonction pour mettre à jour Ryvie
  const handleUpdateRyvie = async () => {
    const confirmed = await showConfirm(
      t('settings.confirmUpdateRyvie'),
      t('settings.confirmUpdateRyvieMessage')
    );
    
    if (!confirmed) {
      return;
    }

    setUpdateInProgress('ryvie');
    
    try {
      const serverUrl = getServerUrl(accessMode);
      
      // ÉTAPE 1 : Démarrer le service de monitoring AVANT la mise à jour
      console.log('[Settings] 1/3 - Démarrage du service de monitoring...');
      try {
        const monitorResponse = await axios.post(`${serverUrl}/api/settings/start-update-monitor`, {}, { timeout: 10000 });
        
        if (!monitorResponse.data.success) {
          throw new Error(monitorResponse.data.error || 'Échec du démarrage du service');
        }
        
        console.log('[Settings] ✓ Service de monitoring démarré (PID:', monitorResponse.data.pid, ')');
        
        // Attendre 2 secondes que le service soit prêt
        console.log('[Settings] 2/3 - Attente que le service soit prêt...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Vérifier que le service répond
        const currentHost = window.location.hostname;
        const monitorHealthUrl = `${window.location.protocol}//${currentHost}:3001/health`;
        
        try {
          await axios.get(monitorHealthUrl, { timeout: 3000 });
          console.log('[Settings] ✓ Service de monitoring prêt et fonctionnel');
        } catch (healthErr) {
          throw new Error('Le service de monitoring ne répond pas sur le port 3001');
        }
        
      } catch (monitorErr) {
        console.error('[Settings] ❌ Erreur démarrage monitoring:', monitorErr);
        setUpdateInProgress(null);
        await showConfirm(
          t('settings.updateRyvieError'),
          `Impossible de démarrer le service de monitoring. La mise à jour a été annulée.\n\nDétails: ${monitorErr.message}`,
          true
        );
        return; // ARRÊTER ICI - ne pas lancer la mise à jour
      }
      
      // ÉTAPE 2 : Lancer la mise à jour (le service de monitoring est OK)
      console.log('[Settings] 3/3 - Lancement de la mise à jour...');
      const response = await axios.post(`${serverUrl}/api/settings/update-ryvie`, {}, {
        timeout: 120000 // 120 secondes pour la création du snapshot
      });
      
      if (response.data.success) {
        const version = response.data.version || 'latest';
        
        // ÉTAPE 3 : Rediriger vers le service de monitoring
        const currentHost = window.location.hostname;
        const monitorUrl = `${window.location.protocol}//${currentHost}:3001/?version=${encodeURIComponent(version)}&mode=${encodeURIComponent(accessMode)}&return=${encodeURIComponent('/#/home')}`;
        console.log('[Settings] ✓ Redirection vers:', monitorUrl);
        window.location.href = monitorUrl;
      } else {
        await showConfirm(
          t('settings.updateRyvieError'),
          `Erreur: ${response.data.message}`,
          true
        );
        setUpdateInProgress(null);
      }
    } catch (error) {
      console.error('[Settings] Erreur lors de la mise à jour de Ryvie:', error);
      await showConfirm(
        t('settings.updateRyvieError'),
        `Erreur lors de la mise à jour: ${error.response?.data?.message || error.message}`,
        true
      );
      setUpdateInProgress(null);
    }
  };

  // Fonction pour mettre à jour une application
  const handleUpdateApp = async (appName) => {
    const confirmed = await showConfirm(
      t('settings.confirmUpdateApp', { appName }),
      t('settings.confirmUpdateAppMessage', { appName })
    );
    
    if (!confirmed) {
      return;
    }

    setUpdateInProgress(appName);
    
    try {
      const serverUrl = getServerUrl(accessMode);
      console.log(`[Settings] Démarrage de la mise à jour de ${appName}...`);
      
      // Utiliser le même endpoint que l'installation pour avoir les notifications persistantes
      // L'endpoint /api/appstore/apps/:id/install gère à la fois l'installation ET la mise à jour
      const response = await axios.post(`${serverUrl}/api/appstore/apps/${appName}/install`, {}, {
        timeout: 10000 // Court timeout car l'installation se fait en arrière-plan
      });
      
      if (response.data.success) {
        // Notifier l'utilisateur que la mise à jour a démarré
        showToast(t('settings.updateStarted', { appName }) || `Mise à jour de ${appName} lancée en arrière-plan`, 'success');
        
        // Rediriger vers Home pour voir la notification persistante
        console.log('[Settings] Redirection vers Home pour suivre la mise à jour...');
        navigate('/home');
      } else {
        await showConfirm(
          '❌ Erreur de mise à jour',
          `Erreur: ${response.data.message}`,
          true
        );
        setUpdateInProgress(null);
      }
    } catch (error) {
      console.error(`[Settings] Erreur lors de la mise à jour de ${appName}:`, error);
      await showConfirm(
        '❌ Erreur de mise à jour',
        `Erreur lors de la mise à jour: ${error.response?.data?.message || error.message}`,
        true
      );
      setUpdateInProgress(null);
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

  // Fonction pour désinstaller une application
  const handleAppUninstall = async (appId, appName) => {
    const confirmed = await showConfirm(
      `🗑️ Désinstaller ${appName}`,
      `Êtes-vous sûr de vouloir désinstaller "${appName}" ?\n\nCette action supprimera :\n- Les containers Docker\n- Les données de l'application\n- Les fichiers de configuration\n\nCette action est irréversible.`
    );
    
    if (!confirmed) {
      return;
    }

    try {
      // Afficher un message de progression
      setAppActionStatus({
        show: true,
        success: false,
        message: `Désinstallation de ${appName} en cours...`,
        appId
      });

      // Appeler l'API de désinstallation
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.delete(`${serverUrl}/api/appstore/apps/${appId}/uninstall`, {
        timeout: 120000 // 120 secondes pour la désinstallation
      });
      
      if (response.data.success) {
        // Afficher un message de succès
        setAppActionStatus({
          show: true,
          success: true,
          message: `${appName} a été désinstallé avec succès`,
          appId
        });
        
        // Fermer la modale si elle est ouverte
        if (selectedApp && selectedApp.id === appId) {
          setSelectedApp(null);
        }
        
        // Rafraîchir la liste des applications après 2 secondes
        setTimeout(() => {
          fetchApplications();
          setAppActionStatus({
            show: false,
            success: false,
            message: '',
            appId: null
          });
        }, 2000);
      } else {
        throw new Error(response.data.message || 'Erreur lors de la désinstallation');
      }
      
    } catch (error) {
      console.error(`Erreur lors de la désinstallation de ${appName}:`, error);
      
      // Afficher un message d'erreur
      setAppActionStatus({
        show: true,
        success: false,
        message: error.response?.data?.message || `Erreur lors de la désinstallation de ${appName}`,
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

  // Fonction pour redémarrer le serveur
  const handleServerRestart = async () => {
    const confirmed = await showConfirm(
      '⚠️ Redémarrage du Système',
      'Êtes-vous sûr de vouloir redémarrer complètement le serveur ? Cette action va redémarrer le système entier et interrompre tous les services pendant quelques minutes. Vous serez déconnecté.'
    );
    
    if (!confirmed) return;
    
    try {
      const serverUrl = getServerUrl(accessMode);
      
      // Envoyer la commande de redémarrage avec un timeout court
      await axios.post(`${serverUrl}/api/server-restart`, {}, { timeout: 10000 });
      
      console.log('[Settings] Commande de redémarrage envoyée avec succès');
    } catch (error) {
      // Si on reçoit une erreur réseau (ECONNABORTED, Network Error, etc.),
      // c'est probablement parce que le serveur a commencé à s'arrêter
      // Dans ce cas, on continue quand même vers la page de redémarrage
      console.log('[Settings] Erreur lors de la requête (normal si le serveur s\'arrête):', error.message);
      
      // Si c'est une vraie erreur d'autorisation (403), on affiche l'erreur
      if (error.response?.status === 403) {
        const errorMessage = error.response?.data?.error || 'Accès refusé';
        showToast(errorMessage, 'error');
        return;
      }
      
      // Pour toutes les autres erreurs (timeout, network error, etc.),
      // on considère que le redémarrage est en cours
    }
    
    // Déconnecter le socket si connecté (comme dans handleLogout de Home.js)
    try {
      if (socket) {
        console.log('[Settings] Déconnexion du socket...');
        socket.disconnect();
      }
    } catch (e) {
      console.warn('[Settings] Erreur lors de la déconnexion du socket:', e);
    }
    
    // Déconnecter l'utilisateur avant de rediriger
    console.log('[Settings] Déconnexion de l\'utilisateur avant le redémarrage...');
    endSession();
    
    // Rediriger vers la page de redémarrage
    navigate('/server-restarting');
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
    
    // Écouter les événements du socket partagé
    if (socket) {
      const handleAppsStatusUpdate = (updatedApps) => {
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
      };
      
      socket.on('appsStatusUpdate', handleAppsStatusUpdate);
      
      return () => {
        socket.off('appsStatusUpdate', handleAppsStatusUpdate);
      };
    }
  }, [accessMode, socket]);

  if (loading) {
    return (
      <div className="settings-skeleton">
        {/* Header skeleton */}
        <div className="skeleton-header">
          <div className="skeleton-back-btn skeleton-pulse"></div>
          <div className="skeleton-title skeleton-pulse"></div>
        </div>

        {/* Customization section skeleton */}
        <div className="skeleton-section">
          <div className="skeleton-section-title skeleton-pulse"></div>
          <div className="skeleton-grid">
            <div className="skeleton-card skeleton-pulse">
              <div className="skeleton-card-title skeleton-pulse"></div>
              <div className="skeleton-card-text skeleton-pulse"></div>
              <div className="skeleton-card-text short skeleton-pulse"></div>
            </div>
          </div>
        </div>

        {/* Stats section skeleton */}
        <div className="skeleton-section">
          <div className="skeleton-section-title skeleton-pulse"></div>
          <div className="skeleton-stats-grid">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="skeleton-stat-card skeleton-pulse">
                <div className="skeleton-stat-title skeleton-pulse"></div>
                <div className="skeleton-stat-bar skeleton-pulse"></div>
                <div className="skeleton-stat-text skeleton-pulse"></div>
              </div>
            ))}
          </div>
        </div>

        {/* Settings cards section skeleton */}
        <div className="skeleton-section">
          <div className="skeleton-section-title skeleton-pulse"></div>
          <div className="skeleton-grid">
            {[1, 2, 3].map(i => (
              <div key={i} className="skeleton-card skeleton-pulse">
                <div className="skeleton-card-title skeleton-pulse"></div>
                <div className="skeleton-card-text skeleton-pulse"></div>
                <div className="skeleton-card-text short skeleton-pulse"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-container">
      {/* En-tête */}
      <div className="settings-header">
        <button className="back-btn" onClick={() => navigate('/home')}>
          ← {t('common.back')}
        </button>
        <h1>{t('settings.title')}</h1>
      </div>

      {/* Section Personnalisation */}
      <section className="settings-section">
        <h2>{t('settings.customization')}</h2>
        <div className="settings-grid">
          <div 
            className="settings-card"
            onDragEnter={handleDragIn}
            onDragLeave={handleDragOut}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            style={{
              position: 'relative',
              border: dragActive ? '3px dashed #4a90e2' : undefined,
              background: dragActive ? 'linear-gradient(135deg, rgba(74, 144, 226, 0.08) 0%, rgba(74, 144, 226, 0.03) 100%)' : undefined,
              transition: 'all 0.3s ease',
              boxShadow: dragActive ? '0 8px 24px rgba(74, 144, 226, 0.15)' : undefined
            }}
          >
            {dragActive && (
              <div style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                fontSize: '64px',
                zIndex: 10,
                pointerEvents: 'none',
                animation: 'bounce 0.5s ease infinite'
              }}>
                📥
              </div>
            )}
            <h3>{t('settings.backgroundImage')}</h3>
            <p className="setting-description">
              {t('settings.backgroundDescription')}
            </p>
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
              
              {/* Fonds personnalisés uploadés - affichés dans la même grille */}
              {customBackgrounds.map((bg) => (
                <div
                  key={bg.id}
                  className={`background-option ${backgroundImage === `custom-${bg.filename}` ? 'active' : ''}`}
                  style={{
                    height: '80px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    border: backgroundImage === `custom-${bg.filename}` ? '3px solid #4a90e2' : '2px solid #ddd',
                    background: `url(${getServerUrl(accessMode)}/api/backgrounds/${bg.filename}) center/cover`,
                    position: 'relative',
                    transition: 'all 0.2s'
                  }}
                  onClick={() => handleBackgroundChange(`custom-${bg.filename}`)}
                >
                  {backgroundImage === `custom-${bg.filename}` && (
                    <div style={{ position: 'absolute', top: '4px', right: '4px', background: '#4a90e2', color: 'white', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px' }}>✓</div>
                  )}
                  {/* Bouton supprimer - uniquement sur les fonds personnalisés */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteBackground(bg.filename);
                    }}
                    style={{
                      position: 'absolute',
                      top: '4px',
                      left: '4px',
                      background: 'rgba(220, 38, 38, 0.9)',
                      color: 'white',
                      border: 'none',
                      borderRadius: '50%',
                      width: '24px',
                      height: '24px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '14px',
                      cursor: 'pointer',
                      padding: 0,
                      transition: 'all 0.2s',
                      opacity: 0.8
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
                    title="Supprimer ce fond"
                  >
                    ×
                  </button>
                  <div style={{ position: 'absolute', bottom: '4px', left: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Perso
                  </div>
                </div>
              ))}
              
              {/* Bouton pour ajouter un nouveau fond */}
              <div 
                className="background-option"
                onClick={() => document.getElementById('background-upload-input').click()}
                style={{
                  height: '80px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  border: '2px dashed #999',
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
                ) : (
                  <>
                    <div style={{ fontSize: '32px', color: '#999' }}>+</div>
                    <div style={{ position: 'absolute', bottom: '4px', left: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', textAlign: 'center' }}>{t('settings.addBackground')}</div>
                  </>
                )}
              </div>
              
              <input
                id="background-upload-input"
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={handleBackgroundUpload}
              />
            </div>
          </div>
        </div>
      </section>
      {/* Section Statistiques */}
      <section className="settings-section stats-section">
        <h2>{t('settings.systemOverview')}</h2>
        <div className="stats-grid">
          {/* Stockage */}
          <div 
            className="stat-card storage" 
            style={{ cursor: 'pointer' }}
            onClick={fetchStorageDetail}
          >
            <h3>{t('settings.storage')}</h3>
            <div className="progress-container">
              <div 
                className="progress-bar" 
                style={{ width: formatPercentage(stats.storageUsed, stats.storageLimit) }}
              ></div>
            </div>
            <div className="stat-details">
              <span>{formatSize(stats.storageUsed)} {t('settings.storageUsed')}</span>
              <span>sur {formatSize(stats.storageLimit)}</span>
            </div>
          </div>

          {/* Performance */}
          <div className="stat-card performance">
            <h3>{t('settings.performance')}</h3>
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
            <h3>{t('settings.statistics')}</h3>
            <div className="general-stats">
              <div className="stat-item">
                <span>{t('settings.activeUsers')}</span>
                <strong>{stats.activeUsers}</strong>
              </div>
              <div className="stat-item">
                <span>{t('settings.applications')}</span>
                <strong>{stats.totalApps}</strong>
              </div>
            </div>
          </div>

          {/* Statut de la duplication RAID */}
          <div className="stat-card backup">
            <h3>{t('settings.duplication')}</h3>
            <div className="backup-info">
              <div className="backup-status">
                <span className={`status-indicator ${stats.raidDuplication === 'actif' ? 'running' : 'pending'}`}></span>
                <span>{stats.raidDuplication === 'actif' ? t('settings.duplicationActive') : t('settings.duplicationInactive')}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section Applications - déplacée juste après la vue d'ensemble */}
      <section className="settings-section">
        <h2>{t('settings.appsManagement')}</h2>
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
                      {selectedApp.status === 'running' && selectedApp.progress === 100 ? t('settings.operational') : 
                       selectedApp.status === 'starting' ? t('settings.startingUp') :
                       selectedApp.status === 'partial' ? t('settings.partialStartup') :
                       t('settings.stopped')}
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
                  <h4>{t('settings.ports')}</h4>
                  {selectedApp.ports && selectedApp.ports.length > 0 ? (
                    <div className="docker-ports-list">
                      {selectedApp.ports.map(port => (
                        <div key={port} className="docker-port-tag">
                          {port}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>{t('settings.noExposedPort')}</p>
                  )}
                </div>
                <div className="docker-app-info-section">
                  <h4>{t('settings.containers')}</h4>
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
                      {(selectedApp.status === 'running' && selectedApp.progress > 0) ? '⏸️ ' + t('settings.stopAllContainers') : '▶️ ' + t('settings.startAllContainers')}
                    </button>
                    <button
                      className="docker-action-btn-large restart"
                      onClick={() => handleAppAction(selectedApp.id, 'restart')}
                      disabled={!(selectedApp.status === 'running' && selectedApp.progress > 0)}
                    >
                      🔄 {t('settings.restartAllContainers')}
                    </button>
                    <button
                      className="docker-action-btn-large uninstall"
                      onClick={() => handleAppUninstall(selectedApp.id, selectedApp.name)}
                      title={t('settings.uninstallApp')}
                    >
                      🗑️ {t('settings.uninstallApp')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {appsLoading ? (
          <div className="docker-apps-grid">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="docker-app-card-skeleton">
                <div className="docker-skeleton-header">
                  <div className="docker-skeleton-icon skeleton-pulse"></div>
                  <div className="docker-skeleton-name skeleton-pulse" style={{ width: `${80 + i * 15}px` }}></div>
                  <div className="docker-skeleton-badge skeleton-pulse"></div>
                </div>
                <div className="docker-skeleton-controls">
                  <div className="docker-skeleton-btn skeleton-pulse"></div>
                  <div className="docker-skeleton-btn skeleton-pulse"></div>
                  <div className="docker-skeleton-btn-small skeleton-pulse"></div>
                </div>
              </div>
            ))}
          </div>
        ) : appsError ? (
          <div className="docker-error-container">
            <p className="docker-error-message">{appsError}</p>
            <button className="docker-retry-button" onClick={fetchApplications}>{t('errors.tryAgain')}</button>
          </div>
        ) : applications.length === 0 ? (
          <div className="docker-empty-state">
            <p>{t('home.noApps')}</p>
          </div>
        ) : (
          <>
            <div className="docker-apps-grid">
              {applications.map((app, index) => {
                // URL standard de l'icône exposée par le backend
                const serverUrl = getServerUrl(accessMode);
                const iconUrl = `${serverUrl}/api/apps/${app.id}/icon`;

                // Afficher seulement les 4 premières apps si showAllApps est false
                if (!showAllApps && index >= 4) return null;

                return (
                  <div 
                    key={app.id} 
                    className={`docker-app-card ${selectedApp && selectedApp.id === app.id ? 'active' : ''}`}
                    onClick={() => handleAppSelect(app)}
                  >
                    <div className="docker-app-header">
                      <div className="docker-app-main">
                        {iconUrl && (
                          <img
                            src={iconUrl}
                            alt={app.name}
                            className="docker-app-logo"
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                        <h3>{app.name}</h3>
                      </div>
                      <span className={`docker-status-badge ${
                        app.status === 'running' && app.progress === 100 ? 'running' : 
                        app.status === 'starting' || app.status === 'partial' ? 'starting' : 
                        'stopped'
                      }`}>
                        {app.status === 'running' && app.progress === 100 ? t('settings.running') : 
                         app.status === 'starting' ? t('settings.starting') :
                         app.status === 'partial' ? t('settings.partial') :
                         t('settings.stopped')}
                      </span>
                    </div>
                {appActionStatus.show && appActionStatus.appId === app.id && (
                  <div className={`docker-action-status ${appActionStatus.success ? 'success' : 'error'}`}>
                    {appActionStatus.message}
                  </div>
                )}
                {isAdmin && (
                  <div className="docker-app-controls">
                    <div className="docker-app-actions-inline">
                      <button
                        className={`docker-action-btn ${app.status === 'running' && app.progress > 0 ? 'stop' : 'start'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAppAction(app.id, (app.status === 'running' && app.progress > 0) ? 'stop' : 'start')
                        }}
                      >
                        {(app.status === 'running' && app.progress > 0) ? t('common.stop') : t('common.start')}
                      </button>
                      <button
                        className="docker-action-btn restart"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAppAction(app.id, 'restart')
                        }}
                        disabled={!(app.status === 'running' && app.progress > 0)}
                      >
                        {t('common.restart')}
                      </button>
                    </div>
                    <button
                      className="docker-action-btn uninstall"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAppUninstall(app.id, app.name)
                      }}
                      title={t('settings.uninstallApp')}
                    >
                      🗑️
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
            );
            })}
          </div>
          {applications.length > 4 && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20px' }}>
              <button
                onClick={() => setShowAllApps(!showAllApps)}
                style={{
                  padding: '12px 32px',
                  backgroundColor: '#0078d4',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '15px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  boxShadow: '0 2px 8px rgba(0, 120, 212, 0.3)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#006cbe';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 120, 212, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#0078d4';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 120, 212, 0.3)';
                }}
              >
                {showAllApps ? '▲ ' + t('settings.showLess') : `▼ ${t('settings.showAllApps')} (${applications.length})`}
              </button>
            </div>
          )}
          </>
        )}
      </section>

      {/* Section Langue */}
      <section className="settings-section">
        <h2>{t('settings.language')}</h2>
        <div className="settings-grid">
          <div className="settings-card">
            <div className="setting-item">
              <select
                value={language || 'fr'}
                onChange={async (e) => {
                  const newLang = e.target.value;
                  
                  // Mettre à jour le contexte global (propage partout)
                  setLanguage(newLang);
                  
                  try {
                    const serverUrl = getServerUrl(accessMode);
                    await axios.patch(`${serverUrl}/api/user/preferences/language`, { language: newLang });
                    console.log('[Settings] Langue sauvegardée:', newLang);
                    showToast(t('settings.languageChanged') + `: ${newLang === 'fr' ? 'Français' : 'English'}`, 'success');
                  } catch (error) {
                    console.error('[Settings] Erreur sauvegarde langue:', error);
                    showToast(t('settings.languageError'), 'error');
                  }
                }}
                style={{
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #ddd',
                  fontSize: '14px',
                  cursor: 'pointer',
                  background: '#fff',
                  width: '100%'
                }}
              >
                <option value="fr">🇫🇷 Français</option>
                <option value="en">🇬🇧 English</option>
              </select>
            </div>
          </div>
        </div>
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
                  <h3>{t('settings.totalStorage')}</h3>
                </div>
                
                <div className="disk-total-content">
                  <div className="disk-info-rows">
                    <div className="disk-info-row">
                      <span>{t('settings.capacity')}:</span>
                      <strong>{systemDisksInfo.total.size}</strong>
                    </div>
                    <div className="disk-info-row">
                      <span>{t('settings.used')}:</span>
                      <strong>{systemDisksInfo.total.used}</strong>
                    </div>
                    <div className="disk-info-row">
                      <span>{t('settings.free')}:</span>
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
                          <span>{t('settings.globalUsage')}:</span>
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
        <h2>{t('settings.downloadConfig')}</h2>
        <div className="settings-grid">
          <div className="setting-item">
            <div className="setting-info">
              <h3>{t('settings.downloadFolder')}</h3>
              <p>{t('settings.downloadFolderDescription')}</p>
              {changeStatus.show && (
                <div className={`status-message ${changeStatus.success ? 'success' : 'error'}`}>
                  {changeStatus.success 
                    ? t('settings.downloadFolderSuccess') 
                    : t('settings.downloadFolderError')}
                </div>
              )}
            </div>
            <div className="setting-control">
              <button 
                onClick={() => handleSettingChange('downloadPath')} 
                className="setting-button"
              >
                <span className="setting-value">{settings.downloadPath}</span>
                <span className="setting-action">{t('settings.modify')}</span>
              </button>
            </div>
          </div>
        </div>
      </section>
      
      {/* Section Paramètres */}
      <section className="settings-section">
        <h2>{t('settings.cloudConfig')}</h2>
        <div className="settings-grid">
          {/* Sécurité */}
          <div className="settings-card">
            <h3>{t('settings.security')}</h3>
            {changeStatus.show && (
              <div className={`status-message ${changeStatus.success ? 'success' : 'error'}`} style={{ marginBottom: '12px' }}>
                {changeStatus.message}
              </div>
            )}
            <div className="setting-item">
              <label>{t('settings.sessionDuration')}</label>
              <select
                value={tokenExpiration}
                onChange={(e) => handleTokenExpirationChange(e.target.value)}
                className="setting-select"
              >
                <option value="5">5 minutes</option>
                <option value="15">15 minutes ({t('common.recommended')})</option>
                <option value="30">30 minutes</option>
                <option value="60">1 heure</option>
                <option value="120">2 heures</option>
                <option value="240">4 heures</option>
                <option value="480">8 heures</option>
                <option value="1440">24 heures</option>
              </select>
              <p className="setting-hint" style={{ fontSize: '0.85em', color: '#666', marginTop: '4px' }}>
                {t('settings.sessionDescription')}
              </p>
            </div>
            <div className="setting-item">
              <label>{t('settings.dataEncryption')}</label>
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
              <label>{t('settings.twoFactorAuth')}</label>
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

          {/* Préférences */}
          <div className="settings-card">
            <h3>{t('settings.preferences')}</h3>
            <div className="setting-item">
              <label>{t('settings.enableNotifications')}</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.notificationsEnabled}
                  onChange={(e) => handleSettingChange('notificationsEnabled', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
            <div className="setting-item">
              <label>{t('settings.autoThemeSystem')}</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={!!settings.autoTheme}
                  onChange={(e) => handleSettingChange('autoTheme', e.target.checked)}
                />
                <span className="slider"></span>
              </label>
            </div>
            {!settings.autoTheme && (
              <div className="setting-item">
                <label>{t('settings.darkMode')}</label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={settings.darkMode}
                    onChange={(e) => handleSettingChange('darkMode', e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>
            )}
          </div>

          {/* Mode d'accès */}
          <div className="setting-item">
            <div className="setting-info">
              <h3>{t('settings.accessMode')}</h3>
              <p>{t('settings.accessModeDescription')}</p>
            </div>
            <div className="setting-control">
              <div className="toggle-buttons">
                <button 
                  className={`toggle-button ${accessMode === 'private' ? 'active' : ''}`}
                  onClick={() => handleAccessModeChange('private')}
                >
                  {t('settings.privateLocal')}
                </button>
                <button 
                  className={`toggle-button ${accessMode === 'remote' ? 'active' : ''}`}
                  onClick={() => handleAccessModeChange('remote')}
                >
                  Remote
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section Mises à Jour */}
      <section id="ryvie-updates" className="settings-section">
        <h2>🔄 {t('settings.updatesSection')}</h2>
        <div className="settings-card" style={{ 
          background: settings.darkMode 
            ? 'linear-gradient(135deg, #1f2937 0%, #111827 100%)' 
            : 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: settings.darkMode ? '1px solid #374151' : '1px solid #e2e8f0',
          boxShadow: settings.darkMode ? '0 4px 16px rgba(0, 0, 0, 0.5)' : '0 4px 16px rgba(0, 0, 0, 0.06)',
          overflow: 'hidden'
        }}>
          <div style={{ padding: '28px' }}>
            {updatesLoading && !updates ? (
              <div style={{ 
                textAlign: 'center', 
                padding: '40px 20px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '16px'
              }}>
                <div style={{
                  width: '48px',
                  height: '48px',
                  border: '4px solid #e2e8f0',
                  borderTopColor: '#3b82f6',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite'
                }}></div>
                <div style={{
                  fontSize: '16px',
                  fontWeight: '600',
                  color: '#64748b'
                }}>
                  {t('settings.checkingUpdates')}...
                </div>
              </div>
            ) : updates ? (
              <div>
                {/* Ryvie Update */}
                <div style={{ 
                  marginBottom: '24px', 
                  padding: '24px', 
                  background: updates.ryvie.updateAvailable 
                    ? (settings.darkMode 
                        ? 'linear-gradient(135deg, rgba(120,53,15,0.35) 0%, rgba(146,64,14,0.35) 100%)' 
                        : 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)')
                    : (settings.darkMode 
                        ? 'linear-gradient(135deg, rgba(6,78,59,0.35) 0%, rgba(5,150,105,0.35) 100%)' 
                        : 'linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)'),
                  borderRadius: '16px',
                  border: settings.darkMode 
                    ? `1px solid ${updates.ryvie.updateAvailable ? 'rgba(245, 158, 11, 0.6)' : 'rgba(34, 197, 94, 0.6)'}`
                    : `1px solid ${updates.ryvie.updateAvailable ? '#f59e0b' : '#22c55e'}`,
                  boxShadow: 'none'
                }}>
                  
                  
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                    <h3 style={{ 
                      margin: 0, 
                      fontSize: '22px', 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '12px',
                      fontWeight: '700',
                      color: settings.darkMode ? '#f8fafc' : '#111827'
                    }}>
                      <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '10px',
                        background: updates.ryvie.updateAvailable ? '#f59e0b' : '#10b981',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '24px',
                        boxShadow: updates.ryvie.updateAvailable 
                          ? '0 4px 12px rgba(251, 191, 36, 0.3)' 
                          : '0 4px 12px rgba(52, 211, 153, 0.3)'
                      }}>
                        {updates.ryvie.updateAvailable ? '🔄' : '✅'}
                      </div>
                      Ryvie
                      {updates?.ryvie?.branch && (
                        <span style={{
                          marginLeft: '8px',
                          fontSize: '12px',
                          color: '#94a3b8',
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: '9999px',
                          background: 'rgba(148,163,184,0.12)',
                          border: '1px solid rgba(148,163,184,0.25)'
                        }}>
                          branch: {updates.ryvie.branch}
                        </span>
                      )}
                    </h3>
                    <div style={{
                      padding: '8px 16px',
                      borderRadius: '8px',
                      background: updates.ryvie.updateAvailable ? '#f59e0b' : '#10b981',
                      color: '#fff',
                      fontSize: '14px',
                      fontWeight: '800',
                      textTransform: 'uppercase',
                      letterSpacing: '0.8px',
                      boxShadow: updates.ryvie.updateAvailable 
                        ? '0 4px 12px rgba(251, 191, 36, 0.3)' 
                        : '0 4px 12px rgba(52, 211, 153, 0.3)'
                    }}>
                      {updates.ryvie.updateAvailable ? t('settings.updateAvailableBadge') : t('settings.upToDateBadge')}
                    </div>
                  </div>
                  <div style={{ fontSize: '15px', color: settings.darkMode ? '#d1d5db' : '#374151', lineHeight: '1.6' }}>
                    <div style={{ 
                      display: 'grid', 
                      gridTemplateColumns: '1fr auto 1fr', 
                      gap: '16px',
                      alignItems: 'center'
                    }}>
                      <div style={{ 
                        padding: '16px', 
                        background: settings.darkMode ? 'rgba(17, 24, 39, 0.6)' : 'rgba(255, 255, 255, 0.8)', 
                        borderRadius: '12px',
                        backdropFilter: 'blur(10px)',
                        border: settings.darkMode ? '1px solid rgba(255, 255, 255, 0.12)' : '1px solid rgba(255, 255, 255, 0.5)',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)'
                      }}>
                        <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '6px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t('settings.currentVersion')}</div>
                        <div style={{ fontSize: '20px', fontWeight: '800', color: settings.darkMode ? '#f8fafc' : '#111827', letterSpacing: '-0.5px' }}>
                          {updates.ryvie.currentVersion || 'N/A'}
                        </div>
                      </div>
                      <div style={{
                        fontSize: '24px',
                        color: updates.ryvie.updateAvailable ? '#f59e0b' : '#10b981',
                        fontWeight: '700'
                      }}>
                        →
                      </div>
                      <div style={{ 
                        padding: '16px', 
                        background: settings.darkMode ? 'rgba(17, 24, 39, 0.6)' : 'rgba(255, 255, 255, 0.8)', 
                        borderRadius: '12px',
                        backdropFilter: 'blur(10px)',
                        border: settings.darkMode ? '1px solid rgba(255, 255, 255, 0.12)' : '1px solid rgba(255, 255, 255, 0.5)',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.05)'
                      }}>
                        <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '6px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{t('settings.latestVersion')}</div>
                        <div style={{ fontSize: '20px', fontWeight: '800', color: settings.darkMode ? '#f8fafc' : '#111827', letterSpacing: '-0.5px' }}>
                          {updates.ryvie.latestVersion || 'N/A'}
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Bouton Mettre à jour pour Ryvie */}
                  {updates.ryvie.updateAvailable && isAdmin && (
                    <div style={{ marginTop: '16px', textAlign: 'center' }}>
                      <button
                        onClick={handleUpdateRyvie}
                        disabled={updateInProgress === 'ryvie'}
                        style={{
                          padding: '12px 24px',
                          background: updateInProgress === 'ryvie' 
                            ? '#94a3b8' 
                            : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '10px',
                          fontSize: '15px',
                          fontWeight: '700',
                          cursor: updateInProgress === 'ryvie' ? 'not-allowed' : 'pointer',
                          boxShadow: updateInProgress === 'ryvie' 
                            ? 'none' 
                            : '0 4px 12px rgba(245, 158, 11, 0.3)',
                          transition: 'all 0.3s ease',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                      >
                        {updateInProgress === 'ryvie' ? (
                          <>
                            <div style={{
                              width: '16px',
                              height: '16px',
                              border: '2px solid #ffffff',
                              borderTopColor: 'transparent',
                              borderRadius: '50%',
                              animation: 'spin 0.8s linear infinite'
                            }}></div>
                            {t('settings.updateInProgress')}
                          </>
                        ) : (
                          <>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 12a9 9 0 11-6.219-8.56"/>
                              <polyline points="21 12 21 6 15 6"/>
                            </svg>
                            {t('settings.updateRyvie')}
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* Applications Updates */}
                {updates.apps && updates.apps.length > 0 && (
                  <div>
                    <h3 style={{ 
                      marginTop: '0', 
                      marginBottom: '20px', 
                      fontSize: '19px',
                      fontWeight: '700',
                      color: '#111827',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px'
                    }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <rect x="3" y="3" width="7" height="7" rx="1"/>
                        <rect x="14" y="3" width="7" height="7" rx="1"/>
                        <rect x="14" y="14" width="7" height="7" rx="1"/>
                        <rect x="3" y="14" width="7" height="7" rx="1"/>
                      </svg>
                      {t('settings.applications')}
                      <span style={{
                        marginLeft: '4px',
                        padding: '4px 10px',
                        background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                        color: '#fff',
                        fontSize: '13px',
                        fontWeight: '700',
                        borderRadius: '8px',
                        boxShadow: '0 2px 8px rgba(59, 130, 246, 0.25)'
                      }}>
                        {updates.apps.length}
                      </span>
                    </h3>
                    <div style={{ display: 'grid', gap: '14px' }}>
                      {updates.apps.map((app, index) => (
                        <div 
                          key={index}
                          style={{ 
                            padding: '20px', 
                            background: app.updateAvailable 
                              ? 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)'
                              : 'linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%)',
                            borderRadius: '14px',
                            border: `2px solid ${app.updateAvailable ? '#fbbf24' : '#34d399'}`,
                            transition: 'all 0.3s ease',
                            cursor: 'default',
                            boxShadow: app.updateAvailable 
                              ? '0 4px 16px rgba(251, 191, 36, 0.12)' 
                              : '0 4px 16px rgba(52, 211, 153, 0.12)',
                            position: 'relative',
                            overflow: 'hidden'
                          }}
                        >
                          {/* Mini barre de couleur en haut */}
                          <div style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            height: '2px',
                            background: app.updateAvailable 
                              ? 'linear-gradient(90deg, transparent, #f59e0b, transparent)' 
                              : 'linear-gradient(90deg, transparent, #10b981, transparent)'
                          }}></div>

                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                                <div style={{ fontWeight: '700', fontSize: '17px', color: '#111827' }}>
                                  {app.name}
                                </div>
                                {app.branch && (
                                  <span style={{
                                    fontSize: '12px',
                                    color: '#94a3b8',
                                    fontWeight: 600,
                                    padding: '2px 8px',
                                    borderRadius: '9999px',
                                    background: 'rgba(148,163,184,0.12)',
                                    border: '1px solid rgba(148,163,184,0.25)'
                                  }}>
                                    branch: {app.branch}
                                  </span>
                                )}
                              </div>
                              <div style={{ 
                                fontSize: '14px', 
                                color: '#6b7280',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px'
                              }}>
                                <span style={{ 
                                  padding: '6px 12px',
                                  background: 'rgba(255, 255, 255, 0.8)',
                                  borderRadius: '8px',
                                  fontSize: '14px',
                                  fontWeight: '700',
                                  color: '#374151',
                                  border: '1px solid rgba(255, 255, 255, 0.5)',
                                  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.05)'
                                }}>
                                  {app.currentVersion || 'N/A'}
                                </span>
                                <span style={{ 
                                  color: app.updateAvailable ? '#f59e0b' : '#10b981',
                                  fontSize: '18px',
                                  fontWeight: '700'
                                }}>→</span>
                                <span style={{ 
                                  padding: '6px 12px',
                                  background: 'rgba(255, 255, 255, 0.8)',
                                  borderRadius: '8px',
                                  fontSize: '14px',
                                  fontWeight: '700',
                                  color: '#374151',
                                  border: '1px solid rgba(255, 255, 255, 0.5)',
                                  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.05)'
                                }}>
                                  {app.latestVersion || 'N/A'}
                                </span>
                              </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                              <div style={{ 
                                padding: '8px 16px',
                                borderRadius: '10px',
                                background: app.updateAvailable 
                                  ? 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)' 
                                  : 'linear-gradient(135deg, #34d399 0%, #10b981 100%)',
                                color: '#fff',
                                fontSize: '13px',
                                fontWeight: '800',
                                textTransform: 'uppercase',
                                letterSpacing: '0.6px',
                                whiteSpace: 'nowrap',
                                boxShadow: app.updateAvailable 
                                  ? '0 4px 12px rgba(251, 191, 36, 0.3)' 
                                  : '0 4px 12px rgba(52, 211, 153, 0.3)'
                              }}>
                                {app.updateAvailable ? t('settings.updateAvailableBadge') : t('settings.upToDateBadge')}
                              </div>
                              
                              {/* Bouton Mettre à jour pour l'app */}
                              {app.updateAvailable && isAdmin && (
                                <button
                                  onClick={() => handleUpdateApp(app.name)}
                                  disabled={updateInProgress === app.name}
                                  style={{
                                    padding: '8px 16px',
                                    background: updateInProgress === app.name 
                                      ? '#94a3b8' 
                                      : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                                    color: '#fff',
                                    border: 'none',
                                    borderRadius: '8px',
                                    fontSize: '13px',
                                    fontWeight: '700',
                                    cursor: updateInProgress === app.name ? 'not-allowed' : 'pointer',
                                    boxShadow: updateInProgress === app.name 
                                      ? 'none' 
                                      : '0 3px 10px rgba(245, 158, 11, 0.3)',
                                    transition: 'all 0.3s ease',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    whiteSpace: 'nowrap'
                                  }}
                                >
                                  {updateInProgress === app.name ? (
                                    <>
                                      <div style={{
                                        width: '12px',
                                        height: '12px',
                                        border: '2px solid #ffffff',
                                        borderTopColor: 'transparent',
                                        borderRadius: '50%',
                                        animation: 'spin 0.8s linear infinite'
                                      }}></div>
                                      {t('settings.updating')}
                                    </>
                                  ) : (
                                    <>
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M21 12a9 9 0 11-6.219-8.56"/>
                                      </svg>
                                      {t('settings.updateNow')}
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ 
                textAlign: 'center', 
                padding: '20px',
                color: '#94a3b8'
              }}>
                {t('settings.noUpdateData')}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section Stockage (lecture seule + accès assistant) */}
      <section className="settings-section">
        <h2>{t('settings.storageConfig')}</h2>
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
              {t('settings.openRaidAssistant')}
            </span>
          </button>
        </div>
        <div className="storage-options">
          {/* Choix du stockage (comme avant) */}
          <div className="settings-card">
            <h3>{t('settings.storageChoice')}</h3>
            <div className="setting-item">
              <label>{t('settings.primaryStorage')}</label>
              <select
                value={settings.storageLocation}
                onChange={(e) => handleSettingChange('storageLocation', e.target.value)}
              >
                <option value="local">{t('settings.localServer')}</option>
                <option value="hybrid">Hybride</option>
              </select>
            </div>
            {settings.storageLocation === 'hybrid' && (
              <div className="ryvie-servers">
                <h4>{t('settings.availableRyvieServers')}</h4>
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
            <h3>{t('settings.detectedDisks')}</h3>
            {storageError ? (
              <div className="docker-error-container"><p className="docker-error-message">{storageError}</p></div>
            ) : !storageInventory ? (
              <p>{t('settings.loadingDiskInventory')}</p>
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
                  if (items.length === 0) return <div className="empty-state"><p>{t('settings.noDiskDetected')}</p></div>;
                  return items.map(disk => (
                    <div key={disk.path} className={`disk-card ${disk.isMounted ? 'mounted' : 'unmounted'}`}>
                      <div className="disk-header">
                        <div className="disk-name-with-status">
                          <FontAwesomeIcon icon={faHdd} className={`disk-icon-visual ${disk.isMounted ? 'mounted' : 'unmounted'}`} />
                          <div className="disk-title-area">
                            <h4>{disk.path}</h4>
                            <div className={`disk-status-badge ${disk.isMounted ? 'mounted' : 'unmounted'}`}>
                              <span className="status-dot"></span>
                              {disk.isMounted ? `${t('settings.mounted')} (${disk.mountInfo})` : t('settings.unmounted')}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="disk-details">
                        <div className="disk-info-rows">
                          <div className="disk-info-row"><span>{t('settings.sizeLabel')}:</span><strong>{disk.size}</strong></div>
                          <div className="disk-info-row"><span>RAID:</span><strong>{disk.inRaid ? t('common.yes') : t('common.no')}</strong></div>
                          {disk.isSystemDisk && (
                            <div className="disk-info-row"><span>{t('settings.roleLabel')}:</span><strong>{t('settings.systemLabel')}</strong></div>
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

      {/* Section Setup Key (Admin uniquement) */}
      {isAdmin && setupKey && (
        <section className="settings-section">
          <h2>
            <FontAwesomeIcon icon={faPlug} style={{ marginRight: '8px' }} />
            {t('settings.setupKeyTitle')}
          </h2>
          <p className="setting-description" style={{ marginBottom: '16px', color: '#666' }}>
            {t('settings.setupKeyDescription')}
          </p>
          
          {!showSetupKey ? (
            <div style={{ textAlign: 'center', padding: '20px' }}>
              <button
                onClick={() => setShowSetupKey(true)}
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
                <FontAwesomeIcon icon={faPlug} />
                {t('settings.discoverSetupKey')}
              </button>
            </div>
          ) : (
            <div className="settings-grid">
              <div className="settings-card" style={{ gridColumn: '1 / -1' }}>
                <div style={{
                  padding: '16px',
                  background: '#f8f9fa',
                  borderRadius: '8px',
                  border: '1px solid #e0e0e0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px'
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px', fontWeight: '600', textTransform: 'uppercase' }}>
                      {t('settings.setupKey')}
                    </div>
                    <code style={{
                      fontSize: '13px',
                      color: '#333',
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'monospace',
                      background: '#fff',
                      padding: '8px 12px',
                      borderRadius: '4px',
                      border: '1px solid #ddd'
                    }}>
                      {setupKey}
                    </code>
                  </div>
                  <button
                    onClick={async () => {
                      try {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                          await navigator.clipboard.writeText(setupKey);
                          setCopiedSetupKey(true);
                          setTimeout(() => setCopiedSetupKey(false), 2000);
                        } else {
                          const textArea = document.createElement('textarea');
                          textArea.value = setupKey;
                          textArea.style.position = 'fixed';
                          textArea.style.left = '-999999px';
                          document.body.appendChild(textArea);
                          textArea.select();
                          try {
                            document.execCommand('copy');
                            setCopiedSetupKey(true);
                            setTimeout(() => setCopiedSetupKey(false), 2000);
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
                      background: copiedSetupKey ? '#4caf50' : '#fff',
                      color: copiedSetupKey ? '#fff' : '#666',
                      border: copiedSetupKey ? '1px solid #4caf50' : '1px solid #ddd',
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
                    title={t('settings.copySetupKey')}
                  >
                    <FontAwesomeIcon icon={copiedSetupKey ? faCheck : faCopy} />
                    {copiedSetupKey ? t('settings.copied') : t('settings.copy')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Section Adresses Publiques */}
      {publicAddresses && (
        <section className="settings-section">
          <h2>
            <FontAwesomeIcon icon={faGlobe} style={{ marginRight: '8px' }} />
            {t('settings.publicAddresses')}
          </h2>
          <p className="setting-description" style={{ marginBottom: '16px', color: '#666' }}>
            {t('settings.publicAddressesDescription')}
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
                {t('settings.discoverAddresses')}
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
            padding: '20px',
            animation: 'fadeIn 0.3s ease-out'
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
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
              animation: 'modalSlideUp 0.4s ease-out'
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
                <div style={{
                  width: '50px',
                  height: '50px',
                  border: '4px solid rgba(0, 0, 0, 0.1)',
                  borderTop: '4px solid #1976d2',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  margin: '0 auto 20px'
                }}></div>
                <div style={{ fontSize: '16px', color: '#666', marginBottom: '12px' }}>
                  {t('settings.analyzingStorage')}
                </div>
                <div style={{ fontSize: '14px', color: '#999' }}>
                  {t('settings.thisMayTakeFewSeconds')}
                </div>
              </div>
            ) : storageDetail ? (
              <div style={{ animation: 'fadeIn 0.5s ease-out' }}>
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
                  transition: 'width 0.3s',
                  animation: 'progressFill 0.8s ease-out'
                }} />
                {/* Apps */}
                <div style={{
                  width: `${(storageDetail.summary.apps / storageDetail.summary.total) * 100}%`,
                  background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
                  transition: 'width 0.3s',
                  animation: 'progressFill 0.8s ease-out 0.1s both'
                }} />
                {/* Autres */}
                <div style={{
                  width: `${(storageDetail.summary.others / storageDetail.summary.total) * 100}%`,
                  background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
                  transition: 'width 0.3s',
                  animation: 'progressFill 0.8s ease-out 0.2s both'
                }} />
              </div>

              {/* Légende */}
              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', animation: 'slideInLeft 0.4s ease-out 0.3s both' }}>
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', animation: 'slideInLeft 0.4s ease-out 0.35s both' }}>
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', animation: 'slideInLeft 0.4s ease-out 0.4s both' }}>
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
                
                {/* Séparateur */}
                <div className="storage-detail-separator" style={{ height: '1px', margin: '8px 0' }} />
                
                {/* Disponible pour écriture */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', animation: 'slideInLeft 0.4s ease-out 0.45s both' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)'
                    }} />
                    <span style={{ fontSize: '14px', fontWeight: '500' }}>Disponible</span>
                  </div>
                  <span style={{ fontSize: '14px', fontWeight: '600', color: '#11998e' }}>
                    {storageDetail.summary.availableFormatted}
                  </span>
                </div>
              </div>
            </div>

            {/* Liste des applications */}
            <div className="storage-detail-apps" style={{
              padding: '0 24px 24px'
            }}>
              <h3 style={{ margin: '16px 0 12px', fontSize: '18px', fontWeight: '600' }}>
                {t('settings.applications')} ({storageDetail.apps.length})
              </h3>
              <div className="storage-detail-apps-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {storageDetail.apps.map((app, idx) => {
                  const serverUrl = getServerUrl(accessMode);
                  return (
                    <div
                      key={app.id}
                      className="storage-detail-app-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px',
                        borderRadius: '8px',
                        animation: `slideInLeft 0.4s ease-out ${idx * 0.05}s both`
                      }}
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
                      <span style={{ fontSize: '15px', fontWeight: '600' }}>
                        {app.sizeFormatted}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
              </div>
            ) : null}
          </div>
        </div>
      )}


      {/* Section Redémarrage du Serveur */}
      {isAdmin && (
        <section className="settings-section" style={{ marginTop: '40px', marginBottom: '40px' }}>
          <h2 style={{ color: '#d32f2f', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FontAwesomeIcon icon={faServer} />
            {t('settings.dangerZone')}
          </h2>
          <div className="settings-card">
            <div style={{ padding: '20px' }}>
              <h3 style={{ marginTop: 0, color: '#d32f2f' }}>{t('settings.restartSystem')}</h3>
              <p className="setting-description" style={{ marginBottom: '20px' }}>
                {t('settings.restartSystemDescription')}
              </p>
              <button
                onClick={handleServerRestart}
                style={{
                  padding: '14px 28px',
                  background: 'linear-gradient(135deg, #d32f2f 0%, #b71c1c 100%)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: '600',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '10px',
                  transition: 'all 0.3s',
                  boxShadow: '0 4px 12px rgba(211, 47, 47, 0.3)'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(211, 47, 47, 0.4)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(211, 47, 47, 0.3)';
                }}
              >
                <FontAwesomeIcon icon={faServer} />
                {t('settings.restartSystemButton')}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Système de Toast Notifications Moderne */}
      <div style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        maxWidth: '400px'
      }}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            style={{
              background: toast.type === 'success' ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 
                          toast.type === 'error' ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' :
                          'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
              color: 'white',
              padding: '16px 20px',
              borderRadius: '12px',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.1)',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              minWidth: '320px',
              animation: 'slideInRight 0.3s ease-out, fadeOut 0.5s ease-in 3.5s',
              fontSize: '14px',
              fontWeight: '500',
              backdropFilter: 'blur(10px)'
            }}
          >
            <span style={{ fontSize: '20px' }}>
              {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✗' : 'ℹ'}
            </span>
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
              onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
              style={{
                background: 'rgba(255, 255, 255, 0.2)',
                border: 'none',
                color: 'white',
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '16px',
                padding: 0,
                transition: 'background 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.3)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Dialog de Confirmation Moderne */}
      {confirmDialog.show && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            animation: 'fadeIn 0.2s ease-out'
          }}
          onClick={confirmDialog.onCancel}
        >
          <div
            style={{
              background: 'white',
              borderRadius: '16px',
              padding: '32px',
              maxWidth: '480px',
              width: '90%',
              boxShadow: '0 24px 48px rgba(0, 0, 0, 0.2)',
              animation: 'scaleIn 0.3s ease-out'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{
              margin: '0 0 16px 0',
              fontSize: '24px',
              fontWeight: '600',
              color: '#1f2937'
            }}>
              {confirmDialog.title}
            </h2>
            <p style={{
              margin: '0 0 32px 0',
              fontSize: '16px',
              lineHeight: '1.6',
              color: '#6b7280'
            }}>
              {confirmDialog.message}
            </p>
            <div style={{
              display: 'flex',
              gap: '12px',
              justifyContent: 'flex-end'
            }}>
              <button
                onClick={confirmDialog.onCancel}
                style={{
                  padding: '12px 24px',
                  borderRadius: '10px',
                  border: '2px solid #e5e7eb',
                  background: 'white',
                  color: '#6b7280',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#f9fafb';
                  e.currentTarget.style.borderColor = '#d1d5db';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'white';
                  e.currentTarget.style.borderColor = '#e5e7eb';
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmDialog.onConfirm}
                style={{
                  padding: '12px 24px',
                  borderRadius: '10px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                  color: 'white',
                  fontSize: '15px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(59, 130, 246, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.3)';
                }}
              >
                {t('common.ok')}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideInRight {
          from {
            transform: translateX(400px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        
        @keyframes fadeOut {
          from {
            opacity: 1;
          }
          to {
            opacity: 0;
          }
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        
        @keyframes scaleIn {
          from {
            transform: scale(0.9);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }
      `}</style>

      {/* Le modal de mise à jour est maintenant géré globalement via GlobalUpdateModal */}
    </div>
  );
};

export default Settings;
