import React, { useState, useEffect } from 'react';
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
  const [selectedApp, setSelectedApp] = useState(null);
  const [catalogHealth, setCatalogHealth] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [toast, setToast] = useState({ show: false, message: '', type: 'success' });
  const [enlargedImage, setEnlargedImage] = useState(null);

  // Charger les apps au montage
  useEffect(() => {
    fetchApps();
    fetchCatalogHealth();
  }, []);

  // Filtrer les apps selon la recherche
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredApps(apps);
    } else {
      const query = searchQuery.toLowerCase();
      setFilteredApps(
        apps.filter(app => 
          app.name?.toLowerCase().includes(query) ||
          app.description?.toLowerCase().includes(query) ||
          app.category?.toLowerCase().includes(query)
        )
      );
    }
  }, [searchQuery, apps]);

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
      <div className="appstore-loading">
        <div className="spinner"></div>
        <p>Chargement du catalogue...</p>
      </div>
    );
  }

  return (
    <div className="appstore-container">
      {/* Header */}
      <div className="appstore-header">
        <div className="header-title">
          <img src={require('../icons/app-AppStore.jpeg')} alt="App Store" className="header-icon" />
          <div>
            <h1>App Store</h1>
            <p className="header-subtitle">
              {apps.length} application{apps.length > 1 ? 's' : ''} disponible{apps.length > 1 ? 's' : ''}
              {catalogHealth?.storage?.releaseTag && (
                <span className="version-badge">{catalogHealth.storage.releaseTag}</span>
              )}
            </p>
          </div>
        </div>
        
        <div className="header-actions">
          <button 
            className="btn-secondary"
            onClick={checkForUpdates}
            title="Vérifier les mises à jour"
          >
            <FontAwesomeIcon icon={faInfoCircle} />
          </button>
          <button 
            className="btn-primary"
            onClick={updateCatalog}
            disabled={isUpdating}
            title="Mettre à jour le catalogue"
          >
            <FontAwesomeIcon icon={faSync} spin={isUpdating} />
            {isUpdating ? ' Mise à jour...' : ' Actualiser'}
          </button>
        </div>
      </div>

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
          filteredApps.map((app) => (
            <div 
              key={app.id} 
              className="app-card"
              onClick={() => setSelectedApp(app)}
            >
              {app.icon ? (
                <img src={app.icon} alt={app.name} className="app-icon" />
              ) : (
                <div className="app-icon-placeholder">
                  {app.name?.charAt(0).toUpperCase()}
                </div>
              )}
              
              <div className="app-info">
                <h3 className="app-name">{app.name}</h3>
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
              <div>
                <h2>{selectedApp.name}</h2>
                <p className="modal-version">Version {selectedApp.version}</p>
              </div>
            </div>
            
            <div className="modal-body">
              <div className="detail-section">
                <h3>Description</h3>
                <p>{selectedApp.description}</p>
              </div>
              
              {selectedApp.category && (
                <div className="detail-section">
                  <h3>Catégorie</h3>
                  <span 
                    className="category-badge"
                    style={{ backgroundColor: getCategoryColor(selectedApp.category) }}
                  >
                    {selectedApp.category}
                  </span>
                </div>
              )}
              
              {selectedApp.previews && selectedApp.previews.length > 0 && (
                <div className="detail-section">
                  <h3>Aperçu</h3>
                  <div className="preview-gallery">
                    {selectedApp.previews.map((preview, index) => (
                      <img 
                        key={index}
                        src={preview} 
                        alt={`${selectedApp.name} preview ${index + 1}`}
                        className="preview-image"
                        onClick={() => setEnlargedImage(preview)}
                        onError={(e) => e.target.style.display = 'none'}
                      />
                    ))}
                  </div>
                </div>
              )}
              
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
              
              {selectedApp.developer && (
                <div className="detail-section">
                  <h3>Développeur</h3>
                  <p>{selectedApp.developer}</p>
                </div>
              )}
            </div>
            
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setSelectedApp(null)}>
                Fermer
              </button>
              <button className="btn-primary">
                <FontAwesomeIcon icon={faDownload} /> Installer
              </button>
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
