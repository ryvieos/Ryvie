import React, { useState, useEffect } from 'react';
import axios from '../../utils/setupAxios';
import BaseWidget from './BaseWidget';
import urlsConfig from '../../config/urls';
import '../../styles/StorageWidget.css';
import storageIcon from '../../icons/storage-icon.png';

const { getServerUrl } = urlsConfig;

/**
 * Widget affichant l'utilisation du stockage
 */
const StorageWidget = ({ id, onRemove, accessMode }) => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <BaseWidget id={id} title="Stockage" icon="💾" onRemove={onRemove} w={2} h={2} className="gradient">
      {loading ? (
        <div className="widget-loading">Chargement...</div>
      ) : data.length === 0 ? (
        <div className="widget-empty">Aucun disque détecté</div>
      ) : (
        <div className="storage-content">
          {data.slice(0, 1).map((disk, index) => {
            const usedPercent = Math.round((disk.used / disk.total) * 100);
            const status = getStatus(usedPercent);
            return (
              <div key={index} className={`storage-item status-${status}`}>
                {/* Top row: icon left, state + percent right */}
                <div className="storage-top">
                  <img className="disk-icon-img" src={storageIcon} alt="" aria-hidden />
                  <div className="top-right">
                    <div className={`health-badge health-${status}`}>
                      {status === 'ok' ? 'Healthy' : status === 'warn' ? 'Warning' : 'Critical'}
                    </div>
                    <div className={`storage-percent percent-${status}`}>{usedPercent}%</div>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="stat-bar-container">
                  <div className={`stat-bar bar-${status}`} style={{ width: `${usedPercent}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </BaseWidget>
  );
};

export default StorageWidget;
