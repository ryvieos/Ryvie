import React, { useState, useEffect, useRef } from 'react';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;

const UpdateModal = ({ isOpen, onClose, targetVersion, accessMode }) => {
  const [status, setStatus] = useState('updating'); // updating, restarting, success, error
  const [message, setMessage] = useState('Téléchargement et application de la mise à jour...');
  const [progress, setProgress] = useState(0);
  const pollingIntervalRef = useRef(null);
  const startTimeRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    startTimeRef.current = Date.now();
    
    // Simuler une progression pendant la phase d'update (0-50%)
    const progressInterval = setInterval(() => {
      setProgress(prev => {
        if (prev < 50) return prev + 2;
        return prev;
      });
    }, 500);

    // Après 5 secondes, passer en mode "redémarrage" et commencer le polling
    const restartTimeout = setTimeout(() => {
      clearInterval(progressInterval);
      setStatus('restarting');
      setMessage('Redémarrage du système en cours...');
      setProgress(60);
      startPolling();
    }, 5000);

    return () => {
      clearInterval(progressInterval);
      clearTimeout(restartTimeout);
      stopPolling();
    };
  }, [isOpen]);

  const startPolling = () => {
    let attempts = 0;
    const maxAttempts = 60; // 60 tentatives = 2 minutes max

    pollingIntervalRef.current = setInterval(async () => {
      attempts++;
      
      // Mettre à jour la progression (60-95%)
      setProgress(Math.min(95, 60 + (attempts * 0.6)));

      try {
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/health`, { 
          timeout: 3000,
          validateStatus: (status) => status === 200
        });

        if (response.status === 200) {
          // Backend est de retour!
          stopPolling();
          setStatus('success');
          setMessage('Mise à jour terminée avec succès!');
          setProgress(100);

          // Attendre 1 seconde puis recharger la page
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        }
      } catch (error) {
        // Backend pas encore prêt, continuer le polling
        if (attempts >= maxAttempts) {
          // Timeout après 2 minutes
          stopPolling();
          setStatus('error');
          setMessage('Le redémarrage prend plus de temps que prévu. Veuillez rafraîchir la page manuellement.');
          setProgress(100);
        }
      }
    }, 2000); // Poll toutes les 2 secondes
  };

  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
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
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10001,
        animation: 'fadeIn 0.3s ease-out'
      }}
    >
      <div
        style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: '24px',
          padding: '48px',
          maxWidth: '520px',
          width: '90%',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.3)',
          color: 'white',
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
                background: 'rgba(255, 255, 255, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '48px',
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
                background: 'rgba(255, 255, 255, 0.2)',
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
                border: '4px solid rgba(255, 255, 255, 0.3)',
                borderTop: '4px solid white',
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
            fontSize: '28px',
            fontWeight: '700',
            textShadow: '0 2px 8px rgba(0, 0, 0, 0.2)'
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
            opacity: 0.95
          }}
        >
          {message}
        </p>

        {/* Version cible */}
        {targetVersion && status !== 'error' && (
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.15)',
              borderRadius: '12px',
              padding: '12px 20px',
              marginBottom: '24px',
              fontSize: '14px',
              fontWeight: '600'
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
              background: 'rgba(255, 255, 255, 0.2)',
              borderRadius: '4px',
              overflow: 'hidden',
              marginBottom: '16px'
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                background: 'white',
                borderRadius: '4px',
                transition: 'width 0.5s ease-out',
                boxShadow: '0 0 12px rgba(255, 255, 255, 0.5)'
              }}
            />
          </div>
        )}

        {/* Pourcentage */}
        {status !== 'error' && (
          <div
            style={{
              fontSize: '14px',
              opacity: 0.8,
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
              border: 'none',
              background: 'white',
              color: '#667eea',
              fontSize: '16px',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
              transition: 'all 0.2s',
              marginTop: '16px'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.3)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.2)';
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
