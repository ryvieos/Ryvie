import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import axios from '../../utils/setupAxios';
import BaseWidget from './BaseWidget';
import urlsConfig from '../../config/urls';
import '../../styles/StorageWidget.css';
import '../../styles/StorageSettings.css';
import storageIcon from '../../icons/storage-icon.png';
import { useNavigate } from 'react-router-dom';

const { getServerUrl } = urlsConfig;

/**
 * Widget affichant l'utilisation du stockage
 */
const StorageWidget = ({ id, onRemove, accessMode }) => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [barProgress, setBarProgress] = useState(0); // animate from 0
  const [entered, setEntered] = useState(false); // fade-in flag
  const [showModal, setShowModal] = useState(false); // fenêtre flottante
  const [storageDetail, setStorageDetail] = useState(null); // détail complet du stockage
  const [storageDetailLoading, setStorageDetailLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchStorageStats = async () => {
      try {
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/server-info`, {
          timeout: 10000
        });
        
        if (response.data && response.data.stockage) {
          // Extraire les valeurs de stockage depuis l'objet stockage
          const storage = response.data.stockage;
          
          let used = 0;
          let total = 1000;
          
          // Convertir les valeurs de GB en nombre
          if (storage.utilise) {
            const usedMatch = storage.utilise.match(/(\d+(\.\d+)?)/);
            if (usedMatch) used = parseFloat(usedMatch[0]);
          }
          
          if (storage.total) {
            const totalMatch = storage.total.match(/(\d+(\.\d+)?)/);
            if (totalMatch) total = parseFloat(totalMatch[0]);
          }
          
          // Convertir en bytes pour l'affichage
          const usedBytes = used * (1024 ** 3); // GB to bytes
          const totalBytes = total * (1024 ** 3);
          
          // Créer un objet disque unique pour /data
          setData([{
            device: '/data',
            mount: '/data',
            used: usedBytes,
            total: totalBytes
          }]);
          setLoading(false);
        }
      } catch (error) {
        console.error('[StorageWidget] Erreur lors de la récupération du stockage:', error);
        setLoading(false);
      }
    };

    fetchStorageStats();
    const interval = setInterval(fetchStorageStats, 10000); // Mise à jour toutes les 10 secondes

    return () => clearInterval(interval);
  }, [accessMode]);

  // Animate bar progress when data loads or updates
  useEffect(() => {
    if (!loading && data.length > 0) {
      const disk = data[0];
      const usedPercent = Math.round((disk.used / disk.total) * 100);
      requestAnimationFrame(() => setBarProgress(usedPercent));
      setEntered(true);
    }
  }, [loading, data]);

  const getStatus = (value) => {
    if (value < 70) return 'ok';
    if (value < 90) return 'warn';
    return 'danger';
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 GB';
    const gb = bytes / (1024 ** 3);
    if (gb < 1) {
      const mb = bytes / (1024 ** 2);
      return `${mb.toFixed(0)} MB`;
    }
    return `${gb.toFixed(1)} GB`;
  };

  const handleOpenModal = async () => {
    console.log('[StorageWidget] handleOpenModal called', { loading, dataLength: data.length });
    if (loading) {
      console.log('[StorageWidget] Click ignored: still loading');
      return;
    }
    if (data.length === 0) {
      console.log('[StorageWidget] Click ignored: no data');
      return;
    }
    
    // Ouvrir la modal et charger le détail complet
    setShowModal(true);
    setStorageDetailLoading(true);
    setStorageDetail(null);
    console.log('[StorageWidget] Modal set to visible, fetching storage detail...');
    
    try {
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/storage-detail`, { timeout: 120000 });
      console.log('[StorageWidget] Storage detail received:', response.data);
      setStorageDetail(response.data);
    } catch (error) {
      console.error('[StorageWidget] Error fetching storage detail:', error);
      alert('Erreur lors de la récupération du détail du stockage: ' + (error.response?.data?.error || error.message));
      setShowModal(false);
    } finally {
      setStorageDetailLoading(false);
    }
  };

  const handleCloseModal = () => {
    console.log('[StorageWidget] Closing modal');
    setShowModal(false);
  };

  const handleOpenFullSettings = () => {
    try {
      navigate('/settings/storage');
    } catch (e) {
      console.warn('[StorageWidget] Navigation vers /settings/storage échouée:', e);
    }
  };

  return (
    <>
      <BaseWidget
        id={id}
        title="Stockage"
        icon="💾"
        onRemove={onRemove}
        w={2}
        h={2}
        className="gradient"
        action={
          <button
            className="widget-chevron"
            onPointerDown={(e) => {
              // Empêcher le drag de démarrer via GridLauncher
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleOpenModal();
            }}
            title="Voir le détail du stockage"
          >
            ⌂
          </button>
        }
      >
        {loading ? (
          <div className="storage-content">
            <div className="storage-item storage-skeleton">
              <div className="storage-top">
                <div className="skeleton-icon" aria-hidden></div>
                <div className="top-right">
                  <div className="skeleton-badge" aria-hidden></div>
                  <div className="skeleton-line" aria-hidden></div>
                </div>
              </div>
              <div className="stat-bar-container">
                <div className="stat-bar-skeleton" aria-hidden></div>
              </div>
            </div>
          </div>
        ) : data.length === 0 ? (
          <div className="widget-empty">Aucun disque détecté</div>
        ) : (
          <div className="storage-content storage-clickable">
            {data.slice(0, 1).map((disk, index) => {
              const usedPercent = Math.round((disk.used / disk.total) * 100);
              const status = getStatus(usedPercent);

              return (
                <div key={index} className={`storage-item status-${status}`}>
                  {/* Top row: icon left, state + percent right */}
                  <div className={`storage-top ${entered ? 'enter-fade' : ''}`}>
                    <img className="disk-icon-img" src={storageIcon} alt="" aria-hidden />
                    <div className="top-right">
                      <div className={`health-badge health-${status}`}> 
                        {status === 'ok' ? 'Healthy' : status === 'warn' ? 'Warning' : 'Critical'}
                      </div>
                      <div className={`storage-percent percent-${status} ${entered ? 'enter-fade' : ''}`}>{usedPercent}%</div>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div className="stat-bar-container">
                    <div className={`stat-bar bar-${status}`} style={{ width: `${barProgress}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </BaseWidget>
      
      {/* Fenêtre flottante d'aperçu stockage - rendue via Portal en dehors du widget */}
      {showModal && ReactDOM.createPortal(
        <div 
          className="storage-detail-overlay"
          onClick={handleCloseModal}
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
                  onClick={handleCloseModal}
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
                  Analyse du stockage en cours...
                </div>
                <div style={{ fontSize: '14px', color: '#999' }}>
                  Cela peut prendre quelques secondes
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
                    <div style={{ height: '1px', background: '#e0e0e0', margin: '8px 0' }} />
                    
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
                <div style={{
                  padding: '0 24px 24px',
                  borderTop: '1px solid #f0f0f0'
                }}>
                  <h3 style={{ margin: '16px 0 12px', fontSize: '18px', fontWeight: '600' }}>
                    Applications ({storageDetail.apps.length})
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {storageDetail.apps.map((app, idx) => {
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
                            transition: 'background 0.2s',
                            animation: `slideInLeft 0.4s ease-out ${idx * 0.05}s both`
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
                            <span style={{ fontSize: '15px', fontWeight: '500', fontFamily: 'system-ui, -apple-system, sans-serif' }}>{app.name}</span>
                          </div>
                          <span style={{ fontSize: '15px', fontWeight: '600', color: '#666' }}>
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
        </div>,
        document.body
      )}
    </>
  );
};

export default StorageWidget;
