import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faSearch, 
  faSync, 
  faTimes, 
  faDownload, 
  faInfoCircle,
  faExclamationTriangle,
  faCheckCircle
} from '@fortawesome/free-solid-svg-icons';
import '../styles/Transitions.css';
import '../styles/AppStore.css';
import { getSessionInfo } from '../utils/sessionManager';
import { useLanguage } from '../contexts/LanguageContext';

 type AppStoreApp = {
   id: string;
   name: string;
   category?: string;
   description?: string;
   tagline?: string;
   developer?: string;
   version?: string;
   icon?: string;
   previews?: string[];
   repo?: string;
   website?: string;
   installedBuildId?: string | null;
   updateAvailable?: boolean | string | number;
 };

const AppStore = () => {
  const { t } = useLanguage();
  // Améliore le rendu de description: paragraphes + liens cliquables
  const renderDescription = (text = '') => {
    const urlRegex = /(https?:\/\/[\w.-]+(?:\/[\w\-._~:\/?#[\]@!$&'()*+,;=%]*)?)/gi;
    const paragraphs = String(text).split(/\n{2,}/);
    const isFeaturesHeading = (line = '') => {
      const v = String(line).trim();
      return /^key\s*features\s*:$/i.test(v) || /^fonctionnalit(?:é|e)s\s+cl(?:é|e)s\s*:$/i.test(v);
    };
    return (
      <div className="description-content">
        {paragraphs.map((para, idx) => {
          const lines = String(para).split(/\n+/);
          return (
            <React.Fragment key={idx}>
              {lines.map((line, lineIdx) => {
                if (!String(line).trim()) return null;
                if (isFeaturesHeading(line)) {
                  return <h3 key={`${idx}-h-${lineIdx}`}>{String(line).trim()}</h3>;
                }
                return (
                  <p key={`${idx}-p-${lineIdx}`}>
                    {String(line).split(urlRegex).map((part, i) => {
                      if (urlRegex.test(part)) {
                        urlRegex.lastIndex = 0;
                        return (
                          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
                            {part}
                          </a>
                        );
                      }
                      return <span key={i}>{part}</span>;
                    })}
                  </p>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    );
  };
  const navigate = useNavigate();
  // États locaux pour suivre les données, la recherche et les retours utilisateurs
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [apps, setApps] = useState<AppStoreApp[]>([]);
  const [filteredApps, setFilteredApps] = useState<AppStoreApp[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedApp, setSelectedApp] = useState<AppStoreApp | null>(null);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const [catalogHealth, setCatalogHealth] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [installingApps, setInstallingApps] = useState(new Set());
  const [cleaningApps, setCleaningApps] = useState(new Set());
  const [enlargedImage, setEnlargedImage] = useState(null);
  const [closingImage, setClosingImage] = useState(false);
  const [featuredApps, setFeaturedApps] = useState<AppStoreApp[]>([]);
  const featuredRef = useRef<HTMLDivElement | null>(null);
  const [featuredHovered, setFeaturedHovered] = useState(false);
  const [featuredPage, setFeaturedPage] = useState(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewHovered, setPreviewHovered] = useState(false);
  const activeEventSources = useRef({}); // Stocke les EventSources actifs pour pouvoir les annuler
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  const [logs, setLogs] = useState([]);
  const [logsVisible, setLogsVisible] = useState(false);
  const [installProgress, setInstallProgress] = useState({});
  const [rateLimit, setRateLimit] = useState(null);

  // Ajouter un log avec timestamp
  const addLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { message, type, timestamp }]);
  };

  // Effacer les logs
  const clearLogs = () => {
    setLogs([]);
  };

  // Annuler une installation en cours
  const cancelInstall = async (appId, appName) => {
    const eventSource = activeEventSources.current[appId];
    if (eventSource) {
      eventSource.close();
      delete activeEventSources.current[appId];
    }
    
    // Envoyer une requête au backend pour arrêter réellement l'installation
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const cancelUrl = `${serverUrl}/api/appstore/apps/${appId}/cancel`;
      
      addLog(`🛑 Envoi de la demande d'annulation au serveur...`, 'info');
      await axios.post(cancelUrl, {}, { timeout: 10000 });
      addLog(`✅ Annulation confirmée par le serveur`, 'success');
      
      // Marquer l'app comme en cours de nettoyage
      setCleaningApps(prev => new Set(prev).add(appId));
      addLog(`🧹 Nettoyage en cours pour ${appName}...`, 'info');
      
      // Démarrer un polling pour vérifier quand le nettoyage est terminé
      const checkCleaningInterval = setInterval(async () => {
        try {
          const cleaningUrl = `${serverUrl}/api/appstore/cleaning-apps`;
          const response = await axios.get(cleaningUrl);
          const cleaningList = response.data.cleaning || [];
          const isStillCleaning = cleaningList.some(item => item.appId === appId);
          
          if (!isStillCleaning) {
            // Nettoyage terminé
            clearInterval(checkCleaningInterval);
            setCleaningApps(prev => {
              const newSet = new Set(prev);
              newSet.delete(appId);
              return newSet;
            });
            addLog(`✅ Nettoyage de ${appName} terminé`, 'success');
          }
        } catch (error) {
          console.error('[AppStore] Erreur lors de la vérification du nettoyage:', error);
        }
      }, 1000); // Vérifier toutes les secondes
      
      // Timeout de sécurité après 30 secondes
      setTimeout(() => {
        clearInterval(checkCleaningInterval);
        setCleaningApps(prev => {
          const newSet = new Set(prev);
          newSet.delete(appId);
          return newSet;
        });
      }, 30000);
      
    } catch (error) {
      console.error('[AppStore] Erreur lors de l\'annulation:', error);
      addLog(`⚠️ Impossible de contacter le serveur pour l'annulation`, 'warning');
    }
    
    // Nettoyer les états d'installation
    setInstallingApps(prev => {
      const newSet = new Set(prev);
      newSet.delete(appId);
      return newSet;
    });
    setInstallProgress(prev => {
      const newProgress = { ...prev };
      delete newProgress[appId];
      return newProgress;
    });
    
    addLog(t('appStore.notifications.cancelledByUser').replace('{appName}', appName), 'warning');
    showToast(t('appStore.notifications.cancelled').replace('{appName}', appName), 'info');
    
    // Notifier Home que l'installation a été annulée
    window.parent.postMessage({ 
      type: 'APPSTORE_INSTALL_STATUS', 
      installing: false, 
      appName: appName,
      appId: appId,
      cancelled: true
    }, '*');
    
    // Rafraîchir le bureau pour supprimer l'app (le backend aura supprimé le manifest)
    addLog(t('appStore.notifications.refreshingDesktop').replace('{appName}', appName), 'info');
    setTimeout(() => {
      window.parent.postMessage({ type: 'REFRESH_DESKTOP_ICONS' }, '*');
    }, 1000);
  };

  // Basculer la visibilité des logs
  const toggleLogs = () => {
    setLogsVisible(prev => !prev);
  };

  // Convertit une couleur hex en rgb
  const hexToRgb = (hex) => {
    if (!hex) return '17,24,39';
    const sanitized = hex.replace('#', '');
    const bigint = parseInt(sanitized.length === 3
      ? sanitized.split('').map(c => c + c).join('')
      : sanitized, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `${r},${g},${b}`;
  };

  // Charger les apps au montage
  useEffect(() => {
    (async () => {
      const minDelay = new Promise((r) => setTimeout(r, 1000));
      await Promise.all([minDelay, fetchApps(), fetchCatalogHealth()]);
      setInitialLoading(false);
    })();
  }, []);

  // Polling pour recharger les apps toutes les 5 minutes
  useEffect(() => {
    const interval = setInterval(() => {
      fetchApps(true); // silent = true pour ne pas afficher le loader
    }, 300000); // 5 minutes
    
    return () => clearInterval(interval);
  }, []);

  // Notifier Home du statut d'installation
  useEffect(() => {
    window.parent.postMessage({
      type: 'APPSTORE_INSTALL_STATUS',
      installing: installingApps.size > 0
    }, '*');
  }, [installingApps]);

  // Débouncer la recherche pour fluidifier la saisie
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Filtrer les apps selon la recherche et la catégorie
  useEffect(() => {
    let filtered = apps;
    
    // Filtre par catégorie
    if (selectedCategory !== 'all') {
      filtered = filtered.filter(app => 
        app.category?.toLowerCase() === selectedCategory.toLowerCase()
      );
    }
    
    // Filtre par recherche
    if (debouncedQuery.trim()) {
      const query = debouncedQuery.toLowerCase();
      filtered = filtered.filter(app => 
        app.name?.toLowerCase().includes(query) ||
        app.description?.toLowerCase().includes(query) ||
        app.category?.toLowerCase().includes(query)
      );
    }
    
    setFilteredApps(filtered);
  }, [debouncedQuery, selectedCategory, apps]);

  // Extraire les catégories uniques
  const categories = ['all', ...new Set(apps.map(app => app.category).filter(Boolean))];

  // Sélectionner 6 apps aléatoires pour Featured (défilement par pages de 2)
  useEffect(() => {
    if (apps.length > 0) {
      const shuffled = [...apps].sort(() => 0.5 - Math.random());
      setFeaturedApps(shuffled.slice(0, 6));
    }
  }, [apps]);

  // Auto défilement du carrousel Featured (par "page" de 2 cartes)
  useEffect(() => {
    const container = featuredRef.current;
    if (!container) return;
    let intervalId;
    const tick = () => {
      if (featuredHovered) return; // pause au survol
      const page = container.clientWidth; // avance d'une vue (2 cartes)
      const maxScroll = container.scrollWidth - container.clientWidth;
      const next = container.scrollLeft + page;
      container.scrollTo({ left: next >= maxScroll ? 0 : next, behavior: 'smooth' });
    };
    intervalId = setInterval(tick, 4000);
    return () => clearInterval(intervalId);
  }, [featuredApps, featuredHovered]);

  // Synchroniser la pagination avec le scroll
  const onFeaturedScroll = () => {
    const container = featuredRef.current;
    if (!container) return;
    const pageWidth = container.clientWidth;
    const index = Math.round(container.scrollLeft / pageWidth);
    setFeaturedPage(index);
  };

  const scrollToPage = (index) => {
    const container = featuredRef.current;
    if (!container) return;
    const pageWidth = container.clientWidth;
    const maxIndex = Math.max(0, Math.ceil((featuredApps.length || 0) / 2) - 1);
    const clamped = Math.min(Math.max(index, 0), maxIndex);
    container.scrollTo({ left: clamped * pageWidth, behavior: 'smooth' });
  };

  const nextFeatured = () => scrollToPage(featuredPage + 1);
  const prevFeatured = () => scrollToPage(featuredPage - 1);

  // Auto-défilement de la galerie d'aperçus dans la modale (carrousel dynamique) + garde-bords
  useEffect(() => {
    const container = previewRef.current;
    if (!selectedApp || !container) return;
    
    const originalImages = Array.from(container.querySelectorAll('.preview-image'));
    const count = originalImages.length;
    if (count === 0) return;
    
    // Cas 1 seule image: centrer et sortir
    if (count === 1) {
      setTimeout(() => {
        originalImages[0].scrollIntoView({ block: 'nearest', inline: 'center' });
      }, 0);
      return;
    }
    
    // Ajouter un clone de la dernière image au début
    const lastClone = originalImages[originalImages.length - 1].cloneNode(true);
    container.insertBefore(lastClone, originalImages[0]);
    
    // Ajouter un clone de la première image à la fin (pour boucler)
    const firstClone = originalImages[0].cloneNode(true);
    container.appendChild(firstClone);
    
    // Centrer sur la première vraie image (index 1 maintenant car 3 est avant)
    setTimeout(() => {
      const allImages = Array.from(container.querySelectorAll('.preview-image'));
      if (allImages[1]) {
        allImages[1].scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    }, 0);
    
    let currentIndex = 1; // Commence à la première vraie image (après le clone de fin)

    // Garde-bords: si on atteint visuellement la fin/début, repositionner immédiatement sur la vraie image équivalente
    const onScroll = () => {
      const imgs = Array.from(container.querySelectorAll('.preview-image'));
      if (imgs.length < 3) return;
      const nearEnd = container.scrollLeft >= (container.scrollWidth - container.clientWidth - 8);
      const nearStart = container.scrollLeft <= 8;
      if (nearEnd) {
        // On est sur le clone de la première image; revenir instantanément à la première vraie
        const firstReal = imgs[1];
        if (firstReal) {
          firstReal.scrollIntoView({ block: 'nearest', inline: 'center' });
          currentIndex = 1;
        }
      } else if (nearStart) {
        // Si l'utilisateur revient au tout début, aller à la dernière vraie image
        const lastReal = imgs[imgs.length - 2];
        if (lastReal) {
          lastReal.scrollIntoView({ block: 'nearest', inline: 'center' });
          currentIndex = imgs.length - 2;
        }
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    
    // Auto-défilement (sans pause au survol)
    let timer = setInterval(() => {
      const allImages = Array.from(container.querySelectorAll('.preview-image'));
      if (allImages.length <= 2) {
        // Pour 2 images (+ 2 clones), alterner proprement entre index 1 et 2
        currentIndex = currentIndex === 1 ? 2 : 1;
      } else {
        currentIndex++;
        if (currentIndex >= allImages.length) currentIndex = 1; // sécurité
      }

      const targetIndex = Math.max(0, Math.min(currentIndex, allImages.length - 1));
      const targetImage = allImages[targetIndex];
      if (targetImage) {
        targetImage.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'nearest', 
          inline: 'center' 
        });
      }
    }, 3500);
    
    return () => {
      clearInterval(timer);
      // Nettoyer les clones
      if (lastClone.parentNode) lastClone.remove();
      if (firstClone.parentNode) firstClone.remove();
      container.removeEventListener('scroll', onScroll);
    };
  }, [selectedApp]);

/**
 * Récupère la liste des applications depuis l'API AppStore.
 * Actualise l'état global et gère l'affichage d'erreur si besoin.
 * @param {boolean} silent - Si true, ne bloque pas l'interface pendant le chargement
 */
  const fetchApps = async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
      }
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      // Récupérer la langue de l'utilisateur depuis localStorage ou préférences
      let userLang = 'fr'; // Défaut français
      try {
        const sessionInfo = getSessionInfo();
        if (sessionInfo?.user) {
          const cachedLang = localStorage.getItem(`ryvie_language_${sessionInfo.user}`);
          if (cachedLang && ['fr', 'en'].includes(cachedLang)) {
            userLang = cachedLang;
          }
        }
      } catch (e) {
        console.warn('[AppStore] Impossible de récupérer la langue utilisateur:', e);
      }
      
      // Ajouter le paramètre lang à la requête
      const response = await axios.get(`${serverUrl}/api/appstore/apps?lang=${userLang}`);
      if (response.data.success) {
        setApps(response.data.data || []);
      }
    } catch (error) {
      console.error('Erreur lors du chargement des apps:', error);
      if (!silent) {
        showToast(t('appStore.catalogLoadError'), 'error');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

/**
 * Récupère l'état de santé du catalogue pour afficher la version disponible.
 */
  const fetchCatalogHealth = async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/appstore/health`);
      setCatalogHealth(response.data);
    } catch (error) {
      console.error('Erreur lors de la récupération de la santé:', error);
    }
  };

/**
 * Vérifie auprès du serveur si une mise à jour du catalogue est disponible.
 */
  const checkForUpdates = async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/appstore/check`);
      setUpdateInfo(response.data);
      
      if (response.data.updateAvailable) {
        showToast(t('appStore.updateAvailableWithVersion', { version: response.data.latestVersion }), 'info');
      } else {
        showToast(t('appStore.catalogUpToDate'), 'success');
      }
    } catch (error) {
      console.error('Erreur lors de la vérification:', error);
      showToast(t('appStore.updateError'), 'error');
    }
  };

/**
 * Lance la mise à jour du catalogue et recharge les données en cas de succès.
 */
  const updateCatalog = async () => {
    try {
      setIsUpdating(true);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/appstore/update`);
      
      if (response.data.success) {
        showToast(
          response.data.updated 
            ? t('appStore.catalogUpdated') + ` vers ${response.data.version}` 
            : t('appStore.catalogUpToDate'),
          'success'
        );
        
        const shouldReload = response.data.updated || (Array.isArray(response.data.updates) && response.data.updates.length > 0);
        if (shouldReload) {
          await fetchApps();
          await fetchCatalogHealth();
        }
      } else {
        showToast(response.data.message || t('appStore.notifications.error'), 'error');
      }
    } catch (error) {
      console.error('Erreur lors de la mise à jour:', error);
      showToast(t('appStore.notifications.error'), 'error');
    } finally {
      setIsUpdating(false);
    }
  };

/**
 * Installe ou met à jour une app depuis l'App Store
 */
  const installApp = async (appId, appName) => {
  let eventSource; // Déclaré ici pour être accessible dans finally
  
  try {
    // Vérifier l'authentification avant de commencer
    const sessionInfo = getSessionInfo();
    addLog(`🔍 Vérification de la session: ${sessionInfo.isActive ? 'ACTIVE' : 'INACTIVE'}`, 'info');
    addLog(`🎫 Token présent: ${sessionInfo.token ? 'OUI' : 'NON'}`, 'info');
    
    if (!sessionInfo?.isActive || !sessionInfo?.token) {
      addLog(`❌ Erreur: Utilisateur non connecté`, 'error');
      showToast(t('appStore.notifications.mustBeConnected'), 'error');
      return;
    }

    // Vérifier que le token est valide
    try {
      const tokenParts = sessionInfo.token.split('.');
      if (tokenParts.length !== 3) {
        throw new Error('Token mal formé (pas 3 parties)');
      }
      const payload = JSON.parse(atob(tokenParts[1]));
      const now = Math.floor(Date.now() / 1000);
      
      if (payload.exp && payload.exp < now) {
        throw new Error('Token expiré');
      }
      
      addLog(`✅ Token valide, expiration: ${new Date(payload.exp * 1000).toLocaleString()}`, 'success');
    } catch (tokenError) {
      addLog(`❌ Erreur de validation du token: ${tokenError.message}`, 'error');
      showToast(t('appStore.notifications.sessionExpired'), 'error');
      return;
    }

    setInstallProgress(prev => ({ ...prev, [appId]: { progress: 5, message: 'Initialisation...', stage: 'init' } }));

    // // Vérifier les permissions (rôles autorisés pour gérer les apps)
    // const allowedRoles = ['Admin', 'Manager', 'SuperAdmin'];
    // if (!allowedRoles.includes(sessionInfo.userRole)) {
    //   addLog(`❌ Erreur: Permissions insuffisantes (rôle: ${sessionInfo.userRole})`, 'error');
    //   showToast('Vous n\'avez pas les permissions pour installer des applications', 'error');
    //   return;
    // }

    addLog(`🚀 Démarrage de l'installation/mise à jour de ${appName} (${appId})`, 'info');
    addLog(`👤 Utilisateur: ${sessionInfo.user} (${sessionInfo.userRole})`, 'info');
    
    setInstallingApps(prev => new Set(prev).add(appId));
    
    // Notifier Home qu'une installation commence avec le nom de l'app
    window.parent.postMessage({ 
      type: 'APPSTORE_INSTALL_STATUS', 
      installing: true, 
      appName: appName,
      appId: appId,
      progress: 0
    }, '*');
    setLogsVisible(false); // Masquer automatiquement les logs lors de l'installation

    const accessMode = getCurrentAccessMode() || 'private';
    const serverUrl = getServerUrl(accessMode);
    const requestUrl = `${serverUrl}/api/appstore/apps/${appId}/install`;

    addLog(`📡 Connexion au serveur: ${accessMode} mode`, 'info');
    addLog(`🔗 URL API: ${requestUrl}`, 'info');

    let response;
    // Version améliorée avec options de débogage

try {
  addLog('📤 Envoi de la requête au serveur...', 'info');
  
  // Option 1: Essayer avec un body vide au lieu de null
  response = await axios.post(requestUrl, {}, { 
    timeout: 300000,
    headers: {
      'Content-Type': 'application/json',
      // Ajoutez ici d'autres headers si nécessaires (auth, etc.)
    }
  });
  
  addLog(`📨 Réponse reçue du serveur (status: ${response.status})`, 'info');
  const responsePayload = typeof response.data === 'object'
    ? JSON.stringify(response.data, null, 2)
    : String(response.data || '');
  const truncatedPayload = responsePayload.length > 500 ? `${responsePayload.slice(0, 500)}…` : responsePayload;
  addLog(`🧾 Corps de réponse: ${truncatedPayload || '⌀'}`, 'info');
  
} catch (requestError) {
  if (axios.isAxiosError(requestError)) {
    const { response: errorResponse, config } = requestError;
    const status = errorResponse?.status ?? 'N/A';
    const statusText = errorResponse?.statusText ?? 'inconnu';
    addLog(`❌ Requête axios échouée (status: ${status} - ${statusText})`, 'error');
    
    if (config) {
      addLog(`📑 Requête envoyée: ${config.method?.toUpperCase()} ${config.url}`, 'error');
      addLog(`📋 Body envoyé: ${JSON.stringify(config.data)}`, 'error');
    }
    
    if (errorResponse?.data) {
      const errorPayload = typeof errorResponse.data === 'object'
        ? JSON.stringify(errorResponse.data, null, 2)
        : String(errorResponse.data);
      const truncatedError = errorPayload.length > 500 ? `${errorPayload.slice(0, 500)}…` : errorPayload;
      addLog(`🧨 Corps d'erreur: ${truncatedError}`, 'error');
    }
    
    // Gérer spécifiquement le cas de la limite d'installations atteinte
    if (status === 429) {
      const errorMessage = errorResponse?.data?.message || t('appStore.notifications.maxInstallationsReached');
      addLog(`⚠️ ${errorMessage}`, 'warning');
      showToast(errorMessage, 'warning');
    } else {
      showToast(t('appStore.notifications.errorWithStatus').replace('{status}', statusText), 'error');
    }
  } else {
    addLog(`❌ Erreur inattendue: ${requestError}`, 'error');
    showToast(t('appStore.notifications.unexpectedError'), 'error');
  }
  
  // Nettoyer l'état
  setInstallingApps(prev => {
    const newSet = new Set(prev);
    newSet.delete(appId);
    return newSet;
  });
  
  window.parent.postMessage({ 
    type: 'APPSTORE_INSTALL_STATUS', 
    installing: false, 
    appName: appName,
    appId: appId,
    error: true
  }, '*');
  
  return;
}

    // Maintenant que le worker est lancé, établir la connexion SSE
    const progressUrl = `${serverUrl}/api/appstore/progress/${appId}`;
    addLog(`📊 Connexion aux mises à jour de progression: ${progressUrl}`, 'info');
    
    // Attendre un peu pour que le worker démarre
    await new Promise(resolve => setTimeout(resolve, 500));
    
    eventSource = new EventSource(progressUrl);
    activeEventSources.current[appId] = eventSource;
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setInstallProgress(prev => ({ 
          ...prev, 
          [appId]: { 
            progress: data.progress, 
            message: data.message,
            stage: data.stage 
          } 
        }));
        addLog(data.message, data.stage === 'error' ? 'error' : 'info');
        
        // Sauvegarder la progression dans localStorage pour persistance
        try {
          const stored = localStorage.getItem('ryvie_installing_apps');
          const state = stored ? JSON.parse(stored) : { installations: {}, timestamp: Date.now() };
          if (!state.installations) state.installations = {};
          
          state.installations[appId] = {
            appName: appName,
            progress: data.progress || 0,
            lastUpdate: Date.now()
          };
          state.timestamp = Date.now();
          
          localStorage.setItem('ryvie_installing_apps', JSON.stringify(state));
        } catch (storageError) {
          console.warn('[AppStore] Erreur sauvegarde progression:', storageError);
        }
        
        // Envoyer la progression à Home pour l'indicateur
        window.parent.postMessage({ 
          type: 'APPSTORE_INSTALL_PROGRESS', 
          appName: appName,
          appId: appId,
          progress: data.progress
        }, '*');
        
        // Si une erreur est survenue (rollback, etc.)
        if (data.stage === 'error') {
          addLog(`❌ Erreur lors de l'installation/mise à jour de ${appName}`, 'error');
          showToast(t('appStore.notifications.installationError', { message: data.message }), 'error');
          
          // Fermer la connexion SSE
          eventSource.close();
          delete activeEventSources.current[appId];
          
          // Nettoyer l'état d'installation
          setInstallingApps(prev => {
            const newSet = new Set(prev);
            newSet.delete(appId);
            return newSet;
          });
          
          // Nettoyer la progression
          setInstallProgress(prev => {
            const newProgress = { ...prev };
            delete newProgress[appId];
            return newProgress;
          });
          
          // Notifier Home que l'installation a échoué
          window.parent.postMessage({ 
            type: 'APPSTORE_INSTALL_STATUS', 
            installing: false, 
            appName: appName,
            appId: appId,
            error: true
          }, '*');
          
          // Rafraîchir la liste des apps pour mettre à jour l'état
          setTimeout(async () => {
            await fetchApps(true);
            window.parent.postMessage({ type: 'REFRESH_DESKTOP_ICONS' }, '*');
          }, 1000);
        }
        // Si l'installation est terminée (100%), afficher la notification de succès
        else if (data.progress >= 100) {
          addLog(t('appStore.notifications.completed').replace('{appName}', appName), 'success');
          addLog(`🏁 Processus terminé pour ${appName}`, 'info');
          showToast(t('appStore.notifications.installed').replace('{appName}', appName), 'success');
          
          // Fermer la connexion SSE
          eventSource.close();
          delete activeEventSources.current[appId];
          
          // Nettoyer l'état d'installation
          setInstallingApps(prev => {
            const newSet = new Set(prev);
            newSet.delete(appId);
            return newSet;
          });
          
          // Notifier Home que l'installation est terminée
          window.parent.postMessage({ 
            type: 'APPSTORE_INSTALL_STATUS', 
            installing: false, 
            appName: appName,
            appId: appId,
            progress: 100
          }, '*');
          
          // Rafraîchir IMMÉDIATEMENT le bureau pour afficher l'icône
          window.parent.postMessage({ type: 'REFRESH_DESKTOP_ICONS' }, '*');
          addLog(`🔄 Bureau rafraîchi immédiatement`, 'success');
          
          // Rafraîchir la liste des apps en arrière-plan avec retry
          const refreshWithRetry = async (attempt = 1, maxAttempts = 3) => {
            try {
              await fetchApps(true);
              addLog(`✅ Liste des apps rafraîchie (tentative ${attempt})`, 'success');
            } catch (error) {
              if (attempt < maxAttempts) {
                addLog(`⚠️ Échec refresh, nouvelle tentative dans 2s...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, 2000));
                return refreshWithRetry(attempt + 1, maxAttempts);
              } else {
                addLog(`❌ Impossible de rafraîchir après ${maxAttempts} tentatives`, 'error');
              }
            }
          };
          
          setTimeout(async () => {
            await refreshWithRetry();
            
            // Nettoyer la progression et les logs après un délai
            setTimeout(() => {
              setInstallProgress(prev => {
                const newProgress = { ...prev };
                delete newProgress[appId];
                return newProgress;
              });
              clearLogs();
            }, 50000);
          }, 1000);
        }
      } catch (error) {
        console.error('Erreur lors du parsing des données de progression:', error);
      }
    };
    
    eventSource.onerror = (error) => {
      console.error('Erreur SSE:', error);
      
      // Vérifier si c'est une erreur de rate limit GitHub
      if (error.target && error.target.readyState === EventSource.CLOSED) {
        // L'erreur sera gérée par le message d'erreur du backend
        addLog('❌ Erreur lors de l\'installation', 'error');
      } else {
        addLog(t('appStore.notifications.installationConnectionError'), 'error');
      }
      
      eventSource.close();
      delete activeEventSources.current[appId];
      
      // Nettoyer l'état en cas d'erreur SSE
      setInstallingApps(prev => {
        const newSet = new Set(prev);
        newSet.delete(appId);
        return newSet;
      });
      setInstallProgress(prev => {
        const newProgress = { ...prev };
        delete newProgress[appId];
        return newProgress;
      });
      
      // Notifier Home que l'installation a échoué
      window.parent.postMessage({ 
        type: 'APPSTORE_INSTALL_STATUS', 
        installing: false, 
        appName: appName,
        appId: appId,
        error: true
      }, '*');
      
      // Rafraîchir le bureau pour supprimer l'app si elle avait été ajoutée
      // (le backend aura supprimé le manifest en cas d'échec)
      addLog(`🔄 Rafraîchissement du bureau pour supprimer ${appName} (installation échouée)`, 'warning');
      setTimeout(() => {
        window.parent.postMessage({ type: 'REFRESH_DESKTOP_ICONS' }, '*');
      }, 1000);
    };

    if (response.data.success) {
      // Le serveur a lancé l'installation en arrière-plan
      addLog(t('appStore.notifications.launchedInBackground').replace('{appName}', appName), 'info');
      addLog(`📊 Suivez la progression ci-dessous...`, 'info');
      showToast(t('appStore.notifications.installing').replace('{appName}', appName), 'info');
      
      // Le backend ne crée le manifest qu'à la fin de l'installation
      // L'app apparaîtra sur le bureau quand l'installation sera terminée (progress >= 100)
      
      // La vraie fin de l'installation sera signalée par le SSE à 100%
    } else {
      addLog(`❌ Échec du lancement: ${response.data.message || 'Erreur inconnue'}`, 'error');
      showToast(response.data.message || t('appStore.notifications.launchError'), 'error');
    }
  } catch (error) {
    addLog(`💥 Erreur lors de l'installation/mise à jour de ${appName}: ${error.message}`, 'error');
    console.error(`Erreur lors de l'installation/mise à jour de ${appName}:`, error);
    showToast(t('appStore.notifications.updateError'), 'error');
    
    // En cas d'erreur, nettoyer immédiatement
    setInstallingApps(prev => {
      const newSet = new Set(prev);
      newSet.delete(appId);
      return newSet;
    });
    if (eventSource) {
      eventSource.close();
    }
    setInstallProgress(prev => {
      const newProgress = { ...prev };
      delete newProgress[appId];
      return newProgress;
    });
  }
};

/**
 * Affiche un toast temporaire pour informer l'utilisateur.
 */
  const showToast = (message, type = 'success') => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: '', type: 'success' }), 4000);
  };

/**
 * Retourne une couleur indicative pour la catégorie d'application.
 */
  const getCategoryColor = (category) => {
    const colors = {
      productivity: '#1976d2',
      media: '#e91e63',
      development: '#4caf50',
      communication: '#ff9800',
      storage: '#9c27b0',
      security: '#f44336',
      other: '#607d8b'
    };
    return colors[category?.toLowerCase()] || colors.other;
  };

  const normalizeVersion = (version) => {
    if (!version) return null;
    if (typeof version !== 'string') {
      return String(version);
    }
    return version.trim().replace(/^v/i, '');
  };

  const compareVersions = (installed, latest) => {
    const installedNorm = normalizeVersion(installed);
    const latestNorm = normalizeVersion(latest);
    if (!installedNorm || !latestNorm) {
      return null;
    }

    if (installedNorm === latestNorm) {
      return 'up-to-date';
    }

    const installedParts = installedNorm.split('.').map(part => parseInt(part, 10) || 0);
    const latestParts = latestNorm.split('.').map(part => parseInt(part, 10) || 0);
    const maxLen = Math.max(installedParts.length, latestParts.length);

    for (let i = 0; i < maxLen; i++) {
      const local = installedParts[i] || 0;
      const remote = latestParts[i] || 0;
      if (remote > local) return 'update-available';
      if (remote < local) return 'ahead';
    }

    
    return 'up-to-date';
  };

  const evaluateAppStatus = (app) => {
    if (!app) {
      return {
        installed: false,
        updateAvailable: false,
        label: 'Installer',
        disabled: false,
        isInstalling: false,
      };
    }

    const appId = app.id;
    const installedBuildId = app?.installedBuildId;
    const installed = installedBuildId !== null && installedBuildId !== undefined;

    const updateFlagRaw = app?.updateAvailable;
    const updateFlag = updateFlagRaw === true || updateFlagRaw === 'true' || updateFlagRaw === 1;
    const updateAvailable = updateFlag;

    // Déterminer le label en fonction de l'état
    const isCurrentlyInstalling = appId ? installingApps.has(appId) : false;
    const isCurrentlyCleaning = appId ? cleaningApps.has(appId) : false;
    let label;
    if (isCurrentlyInstalling) {
      label = t('appStore.installing');
    } else if (isCurrentlyCleaning) {
      label = t('appStore.cleaning');
    } else if (updateAvailable) {
      label = t('appStore.update');
    } else if (installed) {
      label = t('appStore.upToDate');
    } else {
      label = t('appStore.install');
    }

    return {
      installed,
      updateAvailable,
      label,
      disabled: (installed && !updateAvailable) || isCurrentlyInstalling || isCurrentlyCleaning,
      isInstalling: isCurrentlyInstalling,
      isCleaning: isCurrentlyCleaning,
    };
  };

  if (initialLoading) {
    return (
      <div className="appstore-container appstore-loading">
        <div className="loading-icon">🛍️</div>
        <div className="loading-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <p>{t('appStore.loadingCatalog')}</p>
      </div>
    );
  }

  const closeAppModal = () => {
    if (!selectedApp) return;
    setIsModalClosing(true);
    setTimeout(() => {
      setSelectedApp(null);
      setIsModalClosing(false);
    }, 350); // correspond à 0.35s d'animation CSS
  };

  if (loading) {
    return (
      <div className="appstore-container">
        <div className="search-bar" style={{opacity:0.5}}>
          <FontAwesomeIcon icon={faSearch} className="search-icon" />
          <input type="text" className="search-input" placeholder={t('appStore.search')} disabled />
        </div>
        <div className="apps-grid">
          {Array.from({length:8}).map((_,i)=> (
            <div className="app-card skeleton" key={i}>
              <div className="app-card-header">
                <div className="skeleton-thumb"></div>
                <div className="app-card-title-section">
                  <div className="skeleton-line w-60"></div>
                  <div className="skeleton-line w-32"></div>
                </div>
                <div className="skeleton-pill"></div>
              </div>
              <div className="app-card-body">
                <div className="skeleton-line w-100"></div>
                <div className="skeleton-line w-80"></div>
                <div className="skeleton-chips"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="appstore-container">

      {/* Avertissement rate limit critique */}
      {rateLimit && rateLimit.status === 'critical' && (() => {
        const remainingInstalls = Math.floor(rateLimit.remaining / 3);
        return (
          <div className="rate-limit-banner critical">
            <FontAwesomeIcon icon={faExclamationTriangle} className="banner-icon" />
            <div className="banner-content">
              <strong>{t('appStore.notifications.installLimitNearlyReached')}</strong>
              <span>
                {t('appStore.notifications.installLimitMessage', { remaining: remainingInstalls, minutes: rateLimit.minutesUntilReset })}
              </span>
            </div>
          </div>
        );
      })()}

      {/* Avertissement rate limit warning */}
      {rateLimit && rateLimit.status === 'warning' && (() => {
        const remainingInstalls = Math.floor(rateLimit.remaining / 3);
        const totalInstalls = Math.floor(rateLimit.limit / 3);
        return (
          <div className="rate-limit-banner warning">
            <FontAwesomeIcon icon={faInfoCircle} className="banner-icon" />
            <div className="banner-content">
              <span>
                {t('appStore.remainingInstalls', { remaining: remainingInstalls, total: totalInstalls })}
              </span>
            </div>
          </div>
        );
      })()}

      {/* Section Featured Apps */}
      {featuredApps.length > 0 && (
        <div className="featured-section">
          <div className="section-header-simple">
            <h2 className="section-title-simple">{t('appStore.featuredApps')}</h2>
          </div>
          <div 
            className="featured-carousel"
            ref={featuredRef}
            onMouseEnter={() => setFeaturedHovered(true)}
            onMouseLeave={() => setFeaturedHovered(false)}
            onScroll={onFeaturedScroll}
          >
            {featuredApps.map((app) => (
              <div 
                key={app.id} 
                className="featured-card"
                onClick={() => setSelectedApp(app)}
              >
                <div 
                  className="featured-card-content"
                  style={(() => {
                    const base = getCategoryColor(app.category);
                    const bg = app.previews && app.previews[0] ? `url(${app.previews[0]})` : '';
                    return {
                      backgroundColor: base,
                      backgroundImage: bg || undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    };
                  })()}
                >
                  <div className="featured-gradient-overlay" />
                  <div className="featured-overlay">
                    <div className="featured-left">
                      {app.icon ? (
                        <img src={app.icon} alt={app.name} className="featured-badge-icon" />
                      ) : (
                        <div className="featured-badge-placeholder">{app.name?.charAt(0).toUpperCase()}</div>
                      )}
                      <div className="featured-texts">
                        <h3 className="featured-title">{app.name}</h3>
                        <p className="featured-subtitle">{app.tagline}</p>
                      </div>
                    </div>
                    {(() => {
                      const { label, disabled, isInstalling } = evaluateAppStatus(app);
                      const progress = (installProgress[app.id]?.progress || 0) / 100;

                      const handleClick = (event) => {
                        event.stopPropagation();

                        if (disabled) {
                          return;
                        }

                        setSelectedApp(app);
                        if (label === 'Installer' || label === 'Mettre à jour') {
                          installApp(app.id, app.name);
                        }
                      };

                      return (
                        <div className="featured-install-section">
                          <button
                            className={`featured-install-btn ${isInstalling ? 'installing' : ''}`}
                            disabled={disabled}
                            onClick={handleClick}
                            style={isInstalling ? { ['--progress']: progress } : undefined}
                          >
                            <span>{label}</span>
                          </button>
                        </div>
                      );
                  })()}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Contrôles carrousel */}
          {featuredApps.length > 2 && (
            <>
              <button className="featured-nav featured-prev" onClick={prevFeatured} aria-label="Précédent">‹</button>
              <button className="featured-nav featured-next" onClick={nextFeatured} aria-label="Suivant">›</button>
              <div className="featured-dots">
                {Array.from({ length: Math.ceil(featuredApps.length / 2) }).map((_, i) => (
                  <button
                    key={i}
                    className={`featured-dot ${i === featuredPage ? 'active' : ''}`}
                    onClick={() => scrollToPage(i)}
                    aria-label={t('appStore.notifications.goToPage', { page: i + 1 })}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Barre de recherche */}
      <div className="search-bar">
        <FontAwesomeIcon icon={faSearch} className="search-icon" />
        <input
          type="text"
          placeholder={t('appStore.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
        />
        {searchQuery && (
          <button 
            className="search-clear"
            onClick={() => setSearchQuery('')}
          >
            <FontAwesomeIcon icon={faTimes} />
          </button>
        )}
      </div>

      {/* Filtres par catégorie */}
      <div className="category-filters">
        {categories.map((category) => (
          <button
            key={category}
            className={`category-chip ${
              selectedCategory === category ? 'active' : ''
            }`}
            onClick={() => setSelectedCategory(category)}
          >
            {category === 'all' ? t('appStore.all') : category.charAt(0).toUpperCase() + category.slice(1)}
          </button>
        ))}
      </div>

      {/* Titre de section */}
      <div className="section-header">
        <p className="section-kicker">{t('appStore.mostInstalled')}</p>
        <h2 className="section-title">Apps</h2>
      </div>

      {/* Grille des applications */}
      <div className="apps-grid">
        {filteredApps.length === 0 ? (
          <div className="empty-state">
            <FontAwesomeIcon icon={faExclamationTriangle} size="3x" />
            <h3>{t('appStore.notifications.noAppsFound')}</h3>
            <p>
              {searchQuery 
                ? t('appStore.notifications.tryDifferentSearch') 
                : t('appStore.notifications.catalogEmpty')}
            </p>
          </div>
        ) : (
          filteredApps.map((app, index) => (
            <div 
              key={app.id} 
              className="app-card card-reveal"
              style={{ ['--i']: index }}
              onClick={() => setSelectedApp(app)}
            >
              <div className="app-card-header">
                {app.icon ? (
                  <img src={app.icon} alt={app.name} className="app-icon" loading="lazy" />
                ) : (
                  <div className="app-icon-placeholder">
                    {app.name?.charAt(0).toUpperCase()}
                  </div>
                )}
                
                <div className="app-card-title-section">
                  <h3 className="app-name">{app.name}</h3>
                  <p className="app-subtitle">
                    {app.category ? app.category.charAt(0).toUpperCase() + app.category.slice(1) : 'App'}
                  </p>
                </div>
              </div>
              
              <div className="app-card-body">
                <p className="app-description">{app.tagline || app.description}</p>
                <div className="app-footer">
                  <div className="app-meta">
                    {app.category && (
                      <span 
                        className="category-badge"
                        style={{ backgroundColor: getCategoryColor(app.category) }}
                      >
                        {app.category}
                      </span>
                    )}
                    {app.version && !(app?.id && installingApps.has(app.id)) && (
                      <span className="version-text">v{app.version}</span>
                    )}
                  </div>
                  {(() => {
                    const { label, disabled, isInstalling } = evaluateAppStatus(app);
                    const progress = (installProgress[app.id]?.progress || 0) / 100;

                    const handleClick = (event) => {
                      event.stopPropagation();

                      if (disabled) {
                        return;
                      }

                      // TODO: branch vers routine d'installation/mise à jour lorsqu'elle sera câblée
                      if (label === t('appStore.install') || label === t('appStore.update')) {
                        installApp(app.id, app.name);
                      }
                    };

                    return (
                      <div className="app-install-section">
                        <div className="install-btn-row">
                          <button
                            className={`app-get-button ${isInstalling ? 'installing' : ''}`}
                            disabled={disabled}
                            onClick={handleClick}
                            style={isInstalling ? { ['--progress']: progress } : undefined}
                          >
                            <span>{label}</span>
                          </button>
                          {isInstalling && (
                            <button 
                              className="cancel-install-btn"
                              onClick={(e) => { e.stopPropagation(); cancelInstall(app.id, app.name); }}
                              title={t('appStore.notifications.cancelInstallation')}
                            >
                              <FontAwesomeIcon icon={faTimes} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal détails application */}
      {selectedApp && (
        <div 
          className={`modal-overlay ${isModalClosing ? 'modal-overlay-closing' : ''}`}
          onClick={closeAppModal}
        >
          <div 
            className={`modal-content ${isModalClosing ? 'modal-content-closing' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              className="modal-close"
              onClick={closeAppModal}
            >
              <FontAwesomeIcon icon={faTimes} />
            </button>
            
            <div className="modal-header">
              {selectedApp.icon ? (
                <img src={selectedApp.icon} alt={selectedApp.name} className="modal-icon" />
              ) : (
                <div className="modal-icon-placeholder">
                  {selectedApp.name?.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="modal-header-info">
                <h2>{selectedApp.name}</h2>
                {selectedApp.category && (
                  <p className="modal-subtitle">
                    {selectedApp.category.charAt(0).toUpperCase() + selectedApp.category.slice(1)}
                  </p>
                )}
                {selectedApp.version && !(selectedApp?.id && installingApps.has(selectedApp.id)) && (
                  <p className="modal-version">Version {selectedApp.version}</p>
                )}
              </div>
              <div className="modal-header-actions">
                {(() => {
                  if (!selectedApp) return null;

                  const { label, disabled, isInstalling } = evaluateAppStatus(selectedApp);
                  const progress = (installProgress[selectedApp.id]?.progress || 0) / 100;

                  const handleClick = (event) => {
                    event.stopPropagation();

                    if (disabled) {
                      return;
                    }

                    // TODO: branch vers routine d'installation/mise à jour lorsqu'elle sera câblée
                    if (label === t('appStore.install') || label === t('appStore.update')) {
                      if (selectedApp) {
                        installApp(selectedApp.id, selectedApp.name);
                      }
                    }
                  };

                  return (
                    <div className="modal-install-section">
                      <button
                        className={`btn-primary btn-install-header ${isInstalling ? 'installing' : ''}`}
                        disabled={disabled}
                        onClick={handleClick}
                        style={isInstalling && selectedApp ? { ['--progress']: progress } : undefined}
                      >
                        <span><FontAwesomeIcon icon={faDownload} /> {label}</span>
                      </button>
                      {selectedApp && installProgress[selectedApp.id] && (
                        <div className="install-progress-container modal-progress">
                          <div className="install-progress-bar">
                            <div 
                              className="install-progress-fill"
                              style={{ width: `${(installProgress[selectedApp.id]?.progress || 0)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
            
            <div className="modal-meta">
              {selectedApp.category && (
                <div className="meta-item">
                  <div className="meta-label">{t('appStore.category')}</div>
                  <div className="meta-value">{selectedApp.category.charAt(0).toUpperCase() + selectedApp.category.slice(1)}</div>
                </div>
              )}
              {selectedApp.developer && (
                <div className="meta-item">
                  <div className="meta-label">{t('appStore.developer')}</div>
                  <div className="meta-value">{selectedApp.developer}</div>
                </div>
              )}
              {selectedApp.version && (
                <div className="meta-item">
                  <div className="meta-label">{t('appStore.version')}</div>
                  <div className="meta-value">{selectedApp.version}</div>
                </div>
              )}
            </div>
            
            <div className="modal-body">
              {selectedApp.previews && selectedApp.previews.length > 0 && (
                <div className="detail-section">
                  <h3>Aperçu</h3>
                  <div 
                    className="preview-gallery"
                    ref={previewRef}
                  >
                    {selectedApp.previews.map((preview, index) => (
                      <img 
                        key={index}
                        src={preview}
                        alt={`${selectedApp.name} preview ${index + 1}`}
                        className="preview-image"
                        loading="lazy"
                        onClick={() => setEnlargedImage(preview)}
                        onError={(e) => e.target.style.display = 'none'}
                      />
                    ))}
                  </div>
                </div>
              )}
              
              <div className="detail-section">
                <h3>Description</h3>
                {renderDescription(selectedApp.description)}
              </div>
              
              {selectedApp.repo && (
                <div className="detail-section">
                  <h3>Dépôt</h3>
                  <a 
                    href={selectedApp.repo} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="repo-link"
                  >
                    {selectedApp.repo}
                  </a>
                </div>
              )}
              
              {selectedApp.website && (
                <div className="detail-section">
                  <h3>Site web</h3>
                  <a 
                    href={selectedApp.website} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="repo-link"
                  >
                    {selectedApp.website}
                  </a>
                </div>
              )}
            </div>
            
            
          </div>
        </div>
      )}

      {/* Image agrandie */}
      {enlargedImage && (
        <div
          className={`image-overlay ${closingImage ? 'image-overlay-closing' : ''}`}
          onClick={() => {
            setClosingImage(true);
            setTimeout(() => {
              setEnlargedImage(null);
              setClosingImage(false);
            }, 200);
          }}
        >
          <div
            className="image-overlay-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button 
              className="image-close"
              onClick={() => {
                setClosingImage(true);
                setTimeout(() => {
                  setEnlargedImage(null);
                  setClosingImage(false);
                }, 200);
              }}
            >
              <FontAwesomeIcon icon={faTimes} />
            </button>
            <img 
              src={enlargedImage} 
              alt="Preview agrandie"
              className="enlarged-image"
            />
          </div>
        </div>
      )}

      {/* Bouton floating actualiser */}
      <button 
        className="floating-refresh-btn"
        onClick={updateCatalog}
        disabled={isUpdating}
        title={t('appStore.notifications.refreshCatalog')}
      >
        <FontAwesomeIcon icon={faSync} spin={isUpdating} />
      </button>

      {/* Bouton pour afficher/masquer les logs - TEMPORAIRE: toujours visible */}
      <button 
        className="floating-logs-btn"
        onClick={toggleLogs}
        title={logsVisible ? t('appStore.notifications.hideLogs') : t('appStore.notifications.showLogs')}
        style={{
          position: 'fixed',
          bottom: '32px',
          right: '104px',
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: '#f59e0b',
          color: 'white',
          border: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '20px',
          cursor: 'pointer',
          zIndex: 1085
        }}
      >
        <FontAwesomeIcon icon={faInfoCircle} />
        {logs.length > 0 && (
          <span className="logs-badge">{logs.length}</span>
        )}
      </button>

      {/* Logs d'installation */}
      {logs.length > 0 && logsVisible && (
        <div className="logs-panel">
          <div className="logs-header">
            <h3>{t('appStore.notifications.installationLogs')}</h3>
            <button 
              className="logs-clear-btn"
              onClick={clearLogs}
              title={t('appStore.notifications.clearLogs')}
            >
              <FontAwesomeIcon icon={faTimes} />
            </button>
          </div>
          <div className="logs-content">
            {logs.map((log, index) => (
              <div key={index} className={`log-entry log-${log.type}`}>
                <span className="log-time">[{log.timestamp}]</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toast notifications */}
      {toast.show && (
        <div className={`toast toast-${toast.type}`}>
          <FontAwesomeIcon 
            icon={toast.type === 'success' ? faCheckCircle : faExclamationTriangle} 
          />
          <span>{toast.message}</span>
        </div>
      )}

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        .logs-panel {
          position: fixed;
          bottom: 20px;
          right: 20px;
          width: 400px;
          max-height: 300px;
          background: rgba(17, 24, 39, 0.95);
          border: 1px solid #374151;
          border-radius: 8px;
          backdrop-filter: blur(10px);
          z-index: 1000;
          display: flex;
          flex-direction: column;
          animation: slideInUp 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes slideInUp {
          from {
            transform: translateY(20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }

        .logs-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid #374151;
        }

        .logs-header h3 {
          margin: 0;
          color: #e5e7eb;
          font-size: 14px;
          font-weight: 600;
        }

        .logs-clear-btn {
          background: none;
          border: none;
          color: #9ca3af;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          transition: color 0.2s;
        }

        .logs-clear-btn:hover {
          color: #ef4444;
        }

        .logs-content {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
          max-height: 240px;
        }

        .log-entry {
          display: flex;
          gap: 8px;
          padding: 4px 0;
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          line-height: 1.4;
        }

        .log-time {
          color: #6b7280;
          flex-shrink: 0;
        }

        .log-message {
          color: #d1d5db;
          word-break: break-word;
        }

        .log-success .log-message { color: #10b981; }
        .log-error .log-message { color: #ef4444; }
        .log-info .log-message { color: #3b82f6; }
        .log-warning .log-message { color: #f59e0b; }

        .install-progress-container {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
          margin-bottom: 8px;
        }

        .install-progress-container.card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 12px;
          margin-bottom: 8px;
          width: 100%;
        }

        .install-progress-container.card .install-progress-details {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }

        .install-progress-container.card .install-progress-text {
          flex: 1;
          text-align: left;
          font-size: 11px;
          color: #9ca3af;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .install-progress-container.card .install-progress-percent {
          font-size: 12px;
          font-weight: 700;
          color: #3b82f6;
          min-width: 40px;
          text-align: right;
        }

        .install-progress-container.featured {
          margin-top: 12px;
          margin-bottom: 12px;
          flex-direction: column;
          align-items: flex-start;
          gap: 6px;
          width: 100%;
          max-width: 300px;
        }

        .install-progress-container.featured .install-progress-bar {
          width: 100%;
        }

        .install-progress-container.featured .install-progress-details {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          width: 100%;
        }

        .install-progress-container.featured .install-progress-text {
          flex: 1;
          text-align: left;
          min-width: 0;
          color: rgba(255, 255, 255, 0.95);
          font-size: 12px;
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .install-progress-container.featured .install-progress-percent {
          font-size: 13px;
          font-weight: 700;
          color: rgba(255, 255, 255, 1);
          min-width: 45px;
          text-align: right;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        }

        .install-progress-bar {
          flex: 1;
          height: 6px;
          background: rgba(75, 85, 99, 0.3);
          border-radius: 3px;
          overflow: hidden;
        }

        .install-progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #3b82f6, #1d4ed8);
          border-radius: 3px;
          transition: width 0.3s ease;
          animation: progressPulse 2s ease-in-out infinite;
        }

        .install-progress-text {
          font-size: 12px;
          font-weight: 600;
          color: #3b82f6;
          min-width: 35px;
          text-align: right;
        }

        @keyframes progressPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.8; }
        }

        /* Section de progression dans la modale */
        .modal-progress-section {
          padding: 16px 24px;
          background: rgba(59, 130, 246, 0.05);
          border-top: 1px solid rgba(59, 130, 246, 0.1);
          border-bottom: 1px solid rgba(59, 130, 246, 0.1);
        }

        .install-progress-container.modal {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin: 0;
        }

        .install-progress-details {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }

        .install-progress-details .install-progress-text {
          flex: 1;
          text-align: left;
          color: #e5e7eb;
          font-size: 13px;
          font-weight: 500;
          min-width: 0;
        }

        .install-progress-percent {
          font-size: 13px;
          font-weight: 700;
          color: #3b82f6;
          min-width: 45px;
          text-align: right;
        }

        .modal-progress-section .install-progress-bar {
          height: 8px;
          background: rgba(75, 85, 99, 0.3);
        }

        .modal-progress-section .install-progress-fill {
          background: linear-gradient(90deg, #3b82f6, #1d4ed8);
        }

        /* Responsive pour le panneau de logs */
        @media (max-width: 768px) {
          .logs-panel {
            bottom: 10px;
            right: 10px;
            left: 10px;
            width: auto;
            max-height: 250px;
          }
        }
      `}</style>
    </div>
  );
};

export default AppStore;