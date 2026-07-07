import React, { useState } from 'react';
import '../styles/InstallIndicator.css';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Indicateur d'installation individuel pour une app
 */
const InstallIndicatorItem = ({ appName, progress, isUpdate, awaitingStart, isMinimized, onToggleMinimize }) => {
  const { t } = useLanguage();
  // Phase de finalisation : téléchargement terminé mais l'app n'est pas encore prête (démarrage)
  // Calculer la largeur de la barre de progression (pleine pendant la finalisation)
  const progressWidth = awaitingStart ? 100 : (progress > 0 ? Math.min(progress, 100) : 5);

  if (isMinimized) {
    return (
      <button
        className="install-indicator-minimized"
        onClick={onToggleMinimize}
        title={t('installIndicator.showProgress', { appName })}
      >
        <div className="minimized-spinner"></div>
        <span className="minimized-app">{appName}</span>
        <span className="minimized-progress">{awaitingStart ? t('installIndicator.finalizing') : `${Math.round(progress || 0)}%`}</span>
      </button>
    );
  }
  
  return (
    <div className="install-indicator">
      <div className="install-indicator-content">
        <div className="install-indicator-icon">
          <div className="install-spinner">
            <div className="spinner-ring"></div>
            <div className="spinner-ring"></div>
            <div className="spinner-ring"></div>
          </div>
          <div className="download-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
        </div>
        
        <div className="install-indicator-info">
          <span className="install-indicator-title">{t(isUpdate ? 'installIndicator.updating' : 'installIndicator.installing')}</span>
          <span className="install-indicator-app">{appName || 'Application'}</span>
          <div className="install-indicator-progress-container">
            <div 
              className="install-indicator-progress-bar" 
              style={{ width: `${progressWidth}%` }}
            />
          </div>
          {awaitingStart ? (
            <span className="install-indicator-percent">{t('installIndicator.finalizing')}</span>
          ) : (progress > 0 && (
            <span className="install-indicator-percent">{Math.round(progress)}%</span>
          ))}
        </div>
        
        <button 
          className="install-indicator-hide"
          onClick={onToggleMinimize}
          title={t('installIndicator.hide')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      
      <div className="install-indicator-pulse"></div>
    </div>
  );
};

/**
 * Conteneur pour gérer plusieurs installations simultanées
 * installations: Map ou objet { appId: { appName, progress } }
 */
const InstallIndicator = ({ installations, topOffset = 24 }) => {
  const [minimizedApps, setMinimizedApps] = useState(new Set());
  
  // Convertir les installations en tableau
  const installList = Object.entries(installations || {}).filter(
    ([_, data]) => data && data.appName
  );
  
  if (installList.length === 0) {
    return null;
  }
  
  const toggleMinimize = (appId) => {
    setMinimizedApps(prev => {
      const newSet = new Set(prev);
      if (newSet.has(appId)) {
        newSet.delete(appId);
      } else {
        newSet.add(appId);
      }
      return newSet;
    });
  };
  
  return (
    <>
      {installList.map(([appId, data]) => {
        const isMinimized = minimizedApps.has(appId);
        
        return (
          <InstallIndicatorItem
            key={appId}
            appName={data.appName}
            progress={data.progress}
            isUpdate={data.isUpdate}
            awaitingStart={data.awaitingStart}
            isMinimized={isMinimized}
            onToggleMinimize={() => toggleMinimize(appId)}
          />
        );
      })}
    </>
  );
};

export default InstallIndicator;
