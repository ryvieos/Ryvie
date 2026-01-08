import React, { useState, useEffect, useRef } from 'react';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;

const UpdateModal = ({ isOpen, targetVersion, accessMode }) => {
  const [status, setStatus] = useState('updating'); // updating, restarting, waiting_health, success, error
  const [message, setMessage] = useState('Téléchargement et application de la mise à jour...');
  const [progress, setProgress] = useState(0);
  const statusPollingRef = useRef(null);
  const healthPollingRef = useRef(null);
  const startTimeRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    startTimeRef.current = Date.now();
    
    // Polling du fichier de statut pour suivre la progression réelle
    startStatusPolling();

    return () => {
      stopStatusPolling();
      stopHealthPolling();
    };
  }, [isOpen]);

  // Polling du fichier de statut de mise à jour
  const startStatusPolling = () => {
    statusPollingRef.current = setInterval(async () => {
      try {
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/settings/update-status`, {
          timeout: 3000
        });
        
        const updateStatus = response.data;
        
        if (updateStatus.step && updateStatus.message) {
          setMessage(updateStatus.message);
          setProgress(updateStatus.progress || 0);
          
          // Quand la mise à jour atteint 100% (fichiers prêts), passer en mode "restarting"
          if (updateStatus.progress >= 100 || updateStatus.step === 'completed') {
            stopStatusPolling();
            setStatus('restarting');
            setMessage('Redémarrage en cours...');
            setProgress(100);
            
            // Commencer le health check
            startHealthPolling();
          }
        }
      } catch (error) {
        // Le backend peut être arrêté pendant l'update, continuer le polling
      }
    }, 1000); // Poll toutes les secondes pour suivre la progression
  };

  // Polling du health check après que les fichiers soient prêts
  const startHealthPolling = () => {
    let attempts = 0;
    const maxAttempts = 120; // 120 tentatives = 4 minutes max
    let consecutiveReady = 0;
    const requiredConsecutiveReady = 3;

    healthPollingRef.current = setInterval(async () => {
      attempts++;

      try {
        const serverUrl = getServerUrl(accessMode);

        // Check health
        const health = await axios.get(`${serverUrl}/api/health`, {
          timeout: 3000,
          validateStatus: (status) => status === 200
        });

        // Check endpoint authentifié
        const authed = await axios.get(`${serverUrl}/api/user/preferences`, {
          timeout: 4000,
          validateStatus: (status) => status === 200
        });

        if (health.status === 200 && authed.status === 200) {
          consecutiveReady += 1;
        } else {
          consecutiveReady = 0;
        }

        if (consecutiveReady >= requiredConsecutiveReady) {
          // Backend prêt, recharger la page
          stopHealthPolling();
          setStatus('success');
          setMessage('Mise à jour terminée avec succès!');
          
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        }
      } catch (error) {
        consecutiveReady = 0;
        // Backend pas encore prêt, continuer le polling
        if (attempts >= maxAttempts) {
          stopHealthPolling();
          setStatus('error');
          setMessage('Le redémarrage prend plus de temps que prévu. Veuillez rafraîchir la page manuellement.');
        }
      }
    }, 2000); // Poll toutes les 2 secondes
  };

  const stopStatusPolling = () => {
    if (statusPollingRef.current) {
      clearInterval(statusPollingRef.current);
      statusPollingRef.current = null;
    }
  };

  const stopHealthPolling = () => {
    if (healthPollingRef.current) {
      clearInterval(healthPollingRef.current);
      healthPollingRef.current = null;
    }
  };

  const handleManualReload = () => {
    window.location.reload();
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10001,
        animation: 'fadeIn 0.3s ease-out',
        pointerEvents: 'all'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="ryvie-update-modal-card"
        style={{
          background: 'var(--ryvie-update-modal-bg)',
          borderRadius: '14px',
          padding: '32px',
          maxWidth: '520px',
          width: '90%',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.22)',
          color: 'var(--ryvie-update-modal-fg)',
          textAlign: 'center',
          animation: 'scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }}
      >
        {/* Icône/Spinner */}
        <div style={{ marginBottom: '24px' }}>
          {status === 'success' ? (
            <div
              style={{
                width: '80px',
                height: '80px',
                margin: '0 auto',
                borderRadius: '50%',
                background: 'rgba(34, 197, 94, 0.12)',
                border: '2px solid rgba(34, 197, 94, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '48px',
                color: 'rgb(22, 163, 74)',
                animation: 'successPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)'
              }}
            >
              ✓
            </div>
          ) : status === 'error' ? (
            <div
              style={{
                width: '80px',
                height: '80px',
                margin: '0 auto',
                borderRadius: '50%',
                background: 'rgba(15, 23, 42, 0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '48px'
              }}
            >
              ⚠
            </div>
          ) : (
            <div
              style={{
                width: '80px',
                height: '80px',
                margin: '0 auto',
                border: '4px solid rgba(30, 58, 138, 0.22)',
                borderTop: '4px solid rgba(2, 132, 199, 0.95)',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }}
            />
          )}
        </div>

        {/* Titre */}
        <h2
          style={{
            margin: '0 0 12px 0',
            fontSize: '22px',
            fontWeight: '700'
          }}
        >
          {status === 'success' ? 'Mise à jour réussie!' : 
           status === 'error' ? 'Attention' :
           status === 'restarting' ? 'Redémarrage...' : 
           'Mise à jour en cours'}
        </h2>

        {/* Message */}
        <p
          style={{
            margin: '0 0 32px 0',
            fontSize: '16px',
            lineHeight: '1.6',
            opacity: 0.85
          }}
        >
          {message}
        </p>

        {/* Version cible */}
        {targetVersion && status !== 'error' && (
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.06)',
              borderRadius: '10px',
              padding: '10px 14px',
              marginBottom: '24px',
              fontSize: '13px',
              fontWeight: '600',
              color: 'rgba(15, 23, 42, 0.85)'
            }}
          >
            Version cible: {targetVersion}
          </div>
        )}

        {/* Barre de progression */}
        {status !== 'error' && (
          <div
            style={{
              width: '100%',
              height: '8px',
              background: 'rgba(30, 58, 138, 0.14)',
              borderRadius: '4px',
              overflow: 'hidden',
              marginBottom: '16px'
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #1e3a8a 0%, #1d4ed8 55%, #0284c7 100%)',
                borderRadius: '4px',
                transition: 'width 0.5s ease-out',
                boxShadow: 'none'
              }}
            />
          </div>
        )}

        {/* Pourcentage */}
        {status !== 'error' && (
          <div
            style={{
              fontSize: '14px',
              opacity: 0.7,
              marginBottom: '24px'
            }}
          >
            {Math.round(progress)}%
          </div>
        )}

        {/* Bouton de reload manuel en cas d'erreur */}
        {status === 'error' && (
          <button
            onClick={handleManualReload}
            style={{
              padding: '14px 32px',
              borderRadius: '12px',
              border: '1px solid rgba(15, 23, 42, 0.18)',
              background: 'rgba(15, 23, 42, 0.06)',
              color: '#0f172a',
              fontSize: '16px',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: 'none',
              transition: 'all 0.2s',
              marginTop: '16px'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = 'none';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            Rafraîchir la page
          </button>
        )}

        {/* Message d'info pendant le redémarrage */}
        {status === 'restarting' && (
          <p
            style={{
              fontSize: '13px',
              opacity: 0.7,
              margin: '16px 0 0 0',
              fontStyle: 'italic'
            }}
          >
            La page se rechargera automatiquement dès que le système sera prêt
          </p>
        )}
      </div>

      <style>{`
        :root {
          --ryvie-update-modal-bg: #ffffff;
          --ryvie-update-modal-fg: #0f172a;
        }

        :root {
          --ryvie-brand-1: #0ea5e9;
          --ryvie-brand-2: #22d3ee;
          --ryvie-brand-3: #38bdf8;
        }

        @media (prefers-color-scheme: dark) {
          :root {
            --ryvie-update-modal-bg: #0b1220;
            --ryvie-update-modal-fg: #e5e7eb;
          }
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @keyframes successPop {
          0% {
            transform: scale(0);
            opacity: 0;
          }
          50% {
            transform: scale(1.2);
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }
        
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        @keyframes scaleIn {
          from {
            transform: scale(0.8);
            opacity: 0;
          }
          to {
            transform: scale(1);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
};

export default UpdateModal;
