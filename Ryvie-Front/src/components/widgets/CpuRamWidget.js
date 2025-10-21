import React, { useState, useEffect } from 'react';
import axios from '../../utils/setupAxios';
import BaseWidget from './BaseWidget';
import urlsConfig from '../../config/urls';
import '../../styles/CpuRamWidget.css';

const { getServerUrl } = urlsConfig;

/**
 * Widget affichant l'utilisation CPU et RAM
 */
const CpuRamWidget = ({ id, onRemove, accessMode }) => {
  const [data, setData] = useState({ cpu: 0, ram: 0, ramTotal: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSystemStats = async () => {
      try {
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/server-info`, {
          timeout: 10000
        });
        
        if (response.data) {
          // Extraire CPU et RAM (peuvent être des strings comme "12.8%" ou des nombres)
          let cpuValue = 0;
          let ramValue = 0;
          let ramTotalValue = 0;
          
          // CPU
          if (typeof response.data.cpu === 'string') {
            const cpuMatch = response.data.cpu.match(/(\d+(\.\d+)?)/);
            if (cpuMatch) cpuValue = parseFloat(cpuMatch[1]);
          } else if (typeof response.data.cpu === 'number') {
            cpuValue = response.data.cpu;
          }
          
          // RAM
          if (typeof response.data.ram === 'string') {
            const ramMatch = response.data.ram.match(/(\d+(\.\d+)?)/);
            if (ramMatch) ramValue = parseFloat(ramMatch[1]);
          } else if (typeof response.data.ram === 'number') {
            ramValue = response.data.ram;
          }
          
          // RAM Total (en bytes)
          if (response.data.ramTotal) {
            ramTotalValue = response.data.ramTotal;
          }
          
          setData({
            cpu: Math.round(cpuValue),
            ram: Math.round(ramValue),
            ramTotal: ramTotalValue
          });
          setLoading(false);
        }
      } catch (error) {
        console.error('[CpuRamWidget] Erreur lors de la récupération des stats:', error);
        setLoading(false);
      }
    };

    fetchSystemStats();
    const interval = setInterval(fetchSystemStats, 5000); // Mise à jour toutes les 5 secondes

    return () => clearInterval(interval);
  }, [accessMode]);

  const getCpuColor = (value) => {
    if (value < 50) return '#28a745';
    if (value < 80) return '#ffc107';
    return '#dc3545';
  };

  const getRamColor = (value) => {
    if (value < 60) return '#28a745';
    if (value < 85) return '#ffc107';
    return '#dc3545';
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 GB';
    const gb = bytes / (1024 ** 3);
    return `${gb.toFixed(1)} GB`;
  };

  return (
    <BaseWidget id={id} title="CPU & RAM" icon="💻" onRemove={onRemove} w={2} h={2}>
      {loading ? (
        <div className="widget-loading">Chargement...</div>
      ) : (
        <div className="cpu-ram-content">
          {/* CPU */}
          <div className="stat-item">
            <div className="stat-header">
              <div className="stat-label">CPU</div>
              <div className="stat-value" style={{ color: getCpuColor(data.cpu) }}>
                {data.cpu}%
              </div>
            </div>
            <div className="stat-bar-container">
              <div
                className="stat-bar"
                style={{
                  width: `${data.cpu}%`,
                  background: `linear-gradient(90deg, ${getCpuColor(data.cpu)}, ${getCpuColor(data.cpu)}dd)`
                }}
              />
            </div>
          </div>

          {/* RAM */}
          <div className="stat-item">
            <div className="stat-header">
              <div className="stat-label">RAM</div>
              <div className="stat-value" style={{ color: getRamColor(data.ram) }}>
                {data.ram}%
              </div>
            </div>
            <div className="stat-bar-container">
              <div
                className="stat-bar"
                style={{
                  width: `${data.ram}%`,
                  background: `linear-gradient(90deg, ${getRamColor(data.ram)}, ${getRamColor(data.ram)}dd)`
                }}
              />
            </div>
            {data.ramTotal > 0 && (
              <div className="stat-total">{formatBytes(data.ramTotal)} total</div>
            )}
          </div>
        </div>
      )}
    </BaseWidget>
  );
};

export default CpuRamWidget;
