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

  const CPU_BASE = '#23D780'; // vert
  const RAM_BASE = '#23D780'; // vert
  const DANGER = '#dc3545';

  const getCpuColor = (value) => {
    return value > 90 ? DANGER : CPU_BASE;
  };

  const getRamColor = (value) => {
    return value > 90 ? DANGER : RAM_BASE;
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 GB';
    const gb = bytes / (1024 ** 3);
    return `${gb.toFixed(1)} GB`;
  };

  const usedRam = data.ramTotal > 0 ? (data.ramTotal * (data.ram / 100)) : 0;

  const Gauge = ({ value = 0, color = '#22c55e', label = '', sub = '' }) => {
    const size = 80;
    const stroke = 10;
    const center = size / 2;
    const r = center - stroke / 2;
    const circumference = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, value));
    const dash = (clamped / 100) * circumference;
    const gap = circumference - dash;

    return (
      <div className="gauge">
        <svg
          className="gauge-svg"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Trail */}
          <circle
            cx={center}
            cy={center}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={stroke}
          />
          {/* Value arc */}
          <circle
            cx={center}
            cy={center}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${gap}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        </svg>
        <div className="gauge-center">
          <span className="gauge-value">{clamped}</span>
          <span className="gauge-unit">%</span>
        </div>
        <div className="gauge-label">{label}</div>
        <div className="gauge-sub">{sub}</div>
      </div>
    );
  };
  return (
    <BaseWidget 
      id={id} 
      title="System status" 
      icon="💻" 
      onRemove={onRemove} 
      w={2} 
      h={2}
      className="gradient"
      action={<button className="widget-chevron" aria-label="Open">›</button>}
    >
      {loading ? (
        <div className="widget-loading">Chargement...</div>
      ) : (
        <div className="cpu-ram-card">
          <div className="gauges">
            <Gauge
              value={data.cpu}
              color={getCpuColor(data.cpu)}
              label="CPU"
            />
            <Gauge
              value={data.ram}
              color={getRamColor(data.ram)}
              label="RAM"
            />
          </div>
        </div>
      )}
    </BaseWidget>
  );
};

export default CpuRamWidget;
