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

const AppStore = () => {
  const navigate = useNavigate();
  // États locaux pour suivre les données, la recherche et les retours utilisateurs
  const [loading, setLoading] = useState(true);
  const [apps, setApps] = useState([]);
  const [filteredApps, setFilteredApps] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedApp, setSelectedApp] = useState(null);
  const [catalogHealth, setCatalogHealth] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  const [enlargedImage, setEnlargedImage] = useState(null);
  const [featuredApps, setFeaturedApps] = useState([]);
  const featuredRef = useRef(null);
  const [featuredHovered, setFeaturedHovered] = useState(false);
  const [featuredPage, setFeaturedPage] = useState(0);
  const previewRef = useRef(null);
  const [previewHovered, setPreviewHovered] = useState(false);

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
    fetchApps();
    fetchCatalogHealth();
  }, []);

  // Déboucer la recherche pour fluidifier la saisie
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

  // Auto-défilement de la galerie d'aperçus dans la modale (carrousel simple 3-1-2-3) + garde-bords
  useEffect(() => {
    const container = previewRef.current;
    if (!selectedApp || !container) return;
    
    const originalImages = Array.from(container.querySelectorAll('.preview-image'));
    if (originalImages.length === 0) return;
    
    // Ajouter un clone de la dernière image au début (3 avant 1)
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
    
    let currentIndex = 1; // Commence à la première vraie image

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
      currentIndex++;
      
      const targetImage = allImages[currentIndex];
      if (targetImage) {
        targetImage.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'nearest', 
          inline: 'center' 
        });
        
        // La garde-bords onScroll se chargera de resynchroniser si on atteint le clone en bout de liste
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
 */
  const fetchApps = async () => {
    try {
      setLoading(true);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/appstore/apps`);
      if (response.data.success) {
        setApps(response.data.data || []);
      }
    } catch (error) {
      console.error('Erreur lors du chargement des apps:', error);
      showToast('Erreur lors du chargement du catalogue', 'error');
    } finally {
      setLoading(false);
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
        showToast(`Mise à jour disponible: ${response.data.latestVersion}`, 'info');
      } else {
        showToast('Catalogue déjà à jour', 'success');
      }
    } catch (error) {
      console.error('Erreur lors de la vérification:', error);
      showToast('Erreur lors de la vérification des mises à jour', 'error');
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
            ? `Catalogue mis à jour vers ${response.data.version}` 
            : 'Catalogue déjà à jour',
          'success'
        );
        
        if (response.data.updated) {
          await fetchApps();
          await fetchCatalogHealth();
        }
      } else {
        showToast(response.data.message || 'Erreur lors de la mise à jour', 'error');
      }
    } catch (error) {
      console.error('Erreur lors de la mise à jour:', error);
      showToast('Erreur lors de la mise à jour du catalogue', 'error');
    } finally {
      setIsUpdating(false);
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

  if (loading) {
    return (
      <div className="appstore-container">
        <div className="search-bar" style={{opacity:0.5}}>
          <FontAwesomeIcon icon={faSearch} className="search-icon" />
          <input type="text" className="search-input" placeholder="Rechercher une application..." disabled />
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

      {/* Section Featured Apps */}
      {featuredApps.length > 0 && (
        <div className="featured-section">
          <div className="section-header-simple">
            <h2 className="section-title-simple">Applications en vedette</h2>
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
                    const rgb = hexToRgb(base);
                    const bg = app.previews && app.previews[0] ? `, url(${app.previews[0]})` : '';
                    return {
                      backgroundImage: `linear-gradient(90deg, rgba(${rgb},0.55) 0%, rgba(17,24,39,0.35) 60%)${bg}`
                    };
                  })()}
                >
                  <div className="featured-overlay">
                    <div className="featured-left">
                      {app.icon ? (
                        <img src={app.icon} alt={app.name} className="featured-badge-icon" />
                      ) : (
                        <div className="featured-badge-placeholder">{app.name?.charAt(0).toUpperCase()}</div>
                      )}
                      <div className="featured-texts">
                        <h3 className="featured-title">{app.name}</h3>
                        <p className="featured-subtitle">{app.description}</p>
                      </div>
                    </div>
                    <button
                      className="featured-install-btn"
                      onClick={(e) => { e.stopPropagation(); setSelectedApp(app); }}
                    >
                      Installer
                    </button>
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
                    aria-label={`Aller à la page ${i + 1}`}
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
          placeholder="Rechercher une application..."
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
            {category === 'all' ? 'Toutes' : category.charAt(0).toUpperCase() + category.slice(1)}
          </button>
        ))}
      </div>

      {/* Titre de section */}
      <div className="section-header">
        <p className="section-kicker">MOST INSTALLS</p>
        <h2 className="section-title">In popular demand</h2>
        <span className="section-meta">{apps.length} app{apps.length > 1 ? 's' : ''}</span>
      </div>

      {/* Grille des applications */}
      <div className="apps-grid">
        {filteredApps.length === 0 ? (
          <div className="empty-state">
            <FontAwesomeIcon icon={faExclamationTriangle} size="3x" />
            <h3>Aucune application trouvée</h3>
            <p>
              {searchQuery 
                ? 'Essayez une autre recherche' 
                : 'Le catalogue est vide'}
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
                
                <button className="app-get-button" onClick={(e) => { e.stopPropagation(); }}>
                  Installer
                </button>
              </div>
              
              <div className="app-card-body">
                <p className="app-description">{app.description}</p>
                
                <div className="app-meta">
                  {app.category && (
                    <span 
                      className="category-badge"
                      style={{ backgroundColor: getCategoryColor(app.category) }}
                    >
                      {app.category}
                    </span>
                  )}
                  {app.version && (
                    <span className="version-text">v{app.version}</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal détails application */}
      {selectedApp && (
        <div className="modal-overlay" onClick={() => setSelectedApp(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button 
              className="modal-close"
              onClick={() => setSelectedApp(null)}
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
                <p className="modal-version">Version {selectedApp.version}</p>
              </div>
              <div className="modal-header-actions">
                <button className="btn-primary btn-install-header">
                  <FontAwesomeIcon icon={faDownload} /> Installer
                </button>
              </div>
            </div>
            
            <div className="modal-meta">
              {selectedApp.category && (
                <div className="meta-item">
                  <div className="meta-label">Catégorie</div>
                  <div className="meta-value">{selectedApp.category.charAt(0).toUpperCase() + selectedApp.category.slice(1)}</div>
                </div>
              )}
              {selectedApp.developer && (
                <div className="meta-item">
                  <div className="meta-label">Développeur</div>
                  <div className="meta-value">{selectedApp.developer}</div>
                </div>
              )}
              {selectedApp.version && (
                <div className="meta-item">
                  <div className="meta-label">Version</div>
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
                    onMouseEnter={() => setPreviewHovered(true)}
                    onMouseLeave={() => setPreviewHovered(false)}
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
                <p>{selectedApp.description}</p>
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
        <div className="image-overlay" onClick={() => setEnlargedImage(null)}>
          <div className="image-overlay-content" onClick={(e) => e.stopPropagation()}>
            <button 
              className="image-close"
              onClick={() => setEnlargedImage(null)}
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
        title="Actualiser le catalogue"
      >
        <FontAwesomeIcon icon={faSync} spin={isUpdating} />
      </button>

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
      `}</style>
    </div>
  );
};

export default AppStore;
