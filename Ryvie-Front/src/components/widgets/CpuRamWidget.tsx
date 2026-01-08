import React, { useState, useEffect, useRef } from 'react';
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
  const [smoothed, setSmoothed] = useState({ cpu: 0, ram: 0 });
  const [displayed, setDisplayed] = useState({ cpu: 0, ram: 0 });
  const cpuAnimRef = useRef(null);
  const ramAnimRef = useRef(null);
  
  // Historique des valeurs pour moyenne mobile (CasaOS-style)
  const cpuHistoryRef = useRef([]);
  const ramHistoryRef = useRef([]);
  const HISTORY_SIZE = 6; // 6 échantillons = 1 minute (10s * 6)

  useEffect(() => {
    const fetchSystemStats = async () => {
      try {
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/server-info`, {
          timeout: 30000
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
    const interval = setInterval(fetchSystemStats, 15000); // Mise à jour toutes les 15 secondes

    return () => clearInterval(interval);
  }, [accessMode]);

  // Moyenne mobile pour ignorer les pics courts (CasaOS-style)
  useEffect(() => {
    // Ajouter les nouvelles valeurs à l'historique
    cpuHistoryRef.current.push(data.cpu);
    ramHistoryRef.current.push(data.ram);
    
    // Garder seulement les N derniers échantillons
    if (cpuHistoryRef.current.length > HISTORY_SIZE) {
      cpuHistoryRef.current.shift();
    }
    if (ramHistoryRef.current.length > HISTORY_SIZE) {
      ramHistoryRef.current.shift();
    }
    
    // Fonction pour calculer la moyenne en ignorant les outliers extrêmes
    const calculateSmartAverage = (values) => {
      if (values.length === 0) return 0;
      if (values.length <= 2) return values.reduce((sum, val) => sum + val, 0) / values.length;
      
      // Trier pour trouver la médiane et ignorer les valeurs extrêmes
      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      
      // Filtrer les valeurs qui sont trop éloignées de la médiane (>30% d'écart)
      const threshold = median * 0.3;
      const filtered = values.filter(val => Math.abs(val - median) <= threshold);
      
      // Si on a filtré trop de valeurs, utiliser toutes les valeurs
      if (filtered.length < values.length / 2) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
      }
      
      // Calculer la moyenne des valeurs filtrées
      return filtered.reduce((sum, val) => sum + val, 0) / filtered.length;
    };
    
    // Calculer la moyenne intelligente
    const cpuAvg = calculateSmartAverage(cpuHistoryRef.current);
    const ramAvg = calculateSmartAverage(ramHistoryRef.current);
    
    // Appliquer un lissage exponentiel léger sur la moyenne pour des transitions douces
    const ALPHA = 0.3; // Lissage plus doux qu'avant
    setSmoothed((prev) => ({
      cpu: prev.cpu === 0 ? cpuAvg : ALPHA * cpuAvg + (1 - ALPHA) * prev.cpu,
      ram: prev.ram === 0 ? ramAvg : ALPHA * ramAvg + (1 - ALPHA) * prev.ram,
    }));
  }, [data.cpu, data.ram]);

  const ANIM_INTERVAL_MS = 50; // animation speed

  // Animate CPU value 1-by-1 toward smoothed target
  useEffect(() => {
    if (cpuAnimRef.current) {
      cancelAnimationFrame(cpuAnimRef.current);
      cpuAnimRef.current = null;
    }
    let current = displayed.cpu;
    const target = Math.round(Math.max(0, Math.min(100, smoothed.cpu)));
    if (current === target) return;
    let last = performance.now();
    const step = (now) => {
      if (now - last >= ANIM_INTERVAL_MS) {
        if (current < target) current += 1;
        else if (current > target) current -= 1;
        setDisplayed((prev) => ({ ...prev, cpu: current }));
        last = now;
      }
      if (current !== target) {
        cpuAnimRef.current = requestAnimationFrame(step);
      } else {
        cpuAnimRef.current = null;
      }
    };
    cpuAnimRef.current = requestAnimationFrame(step);
    return () => {
      if (cpuAnimRef.current) {
        cancelAnimationFrame(cpuAnimRef.current);
        cpuAnimRef.current = null;
      }
    };
  }, [smoothed.cpu, displayed.cpu]);

  // Animate RAM value 1-by-1 toward smoothed target
  useEffect(() => {
    if (ramAnimRef.current) {
      cancelAnimationFrame(ramAnimRef.current);
      ramAnimRef.current = null;
    }
    let current = displayed.ram;
    const target = Math.round(Math.max(0, Math.min(100, smoothed.ram)));
    if (current === target) return;
    let last = performance.now();
    const step = (now) => {
      if (now - last >= ANIM_INTERVAL_MS) {
        if (current < target) current += 1;
        else if (current > target) current -= 1;
        setDisplayed((prev) => ({ ...prev, ram: current }));
        last = now;
      }
      if (current !== target) {
        ramAnimRef.current = requestAnimationFrame(step);
      } else {
        ramAnimRef.current = null;
      }
    };
    ramAnimRef.current = requestAnimationFrame(step);
    return () => {
      if (ramAnimRef.current) {
        cancelAnimationFrame(ramAnimRef.current);
        ramAnimRef.current = null;
      }
    };
  }, [smoothed.ram, displayed.ram]);

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
        <div className="cpu-ram-card">
          <div className="gauges">
            <div className="gauge-skeleton">
              <div className="gauge-circle-skeleton" />
              <div className="gauge-text-skeleton">
                <div className="gauge-value-skeleton" />
                <div className="gauge-label-skeleton" />
              </div>
            </div>
            <div className="gauge-skeleton">
              <div className="gauge-circle-skeleton" />
              <div className="gauge-text-skeleton">
                <div className="gauge-value-skeleton" />
                <div className="gauge-label-skeleton" />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="cpu-ram-card">
          <div className="gauges">
            <Gauge
              value={displayed.cpu}
              color={getCpuColor(displayed.cpu)}
              label="CPU"
            />
            <Gauge
              value={displayed.ram}
              color={getRamColor(displayed.ram)}
              label="RAM"
            />
          </div>
        </div>
      )}
    </BaseWidget>
  );
};

export default CpuRamWidget;
