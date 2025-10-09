import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import '../styles/ServerRestarting.css';
import ryvieLogo from '../icons/ryvielogo0.png';

const ServerRestarting = () => {
  const navigate = useNavigate();
  const [dots, setDots] = useState('');
  const [checkCount, setCheckCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Redémarrage en cours');

  const publicUrl = useMemo(() => getServerUrl('public'), []);
  const privateUrl = useMemo(() => getServerUrl('private'), []);

  useEffect(() => {
    // Animation des points
    const dotsInterval = setInterval(() => {
      setDots(prev => {
        if (prev === '...') return '';
        return prev + '.';
      });
    }, 500);

    return () => clearInterval(dotsInterval);
  }, []);

  // Démarre les vérifications après 30s, puis toutes les 5s
  useEffect(() => {
    let checkInterval = null;
    const tryCheck = async () => {
      // Essayer d'abord l'URL publique, puis l'URL locale, et tester 2 endpoints possibles
      const targets = [publicUrl, privateUrl];
      const paths = ['/api/status', '/status'];
      for (const base of targets) {
        if (!base) continue;
        for (const p of paths) {
          try {
            const resp = await axios.get(`${base}${p}`, { timeout: 5000 });
            if (resp.status === 200) {
              return true;
            }
          } catch (_) {}
        }
      }
      return false;
    };

    const initialDelay = setTimeout(() => {
      setStatusMessage('Vérification de la disponibilité');
      checkInterval = setInterval(async () => {
        setCheckCount(c => c + 1);
        const ok = await tryCheck();
        if (ok) {
          setStatusMessage('Serveur disponible ! Redirection...');
          clearInterval(checkInterval);
          setTimeout(() => { window.location.href = '/#/home'; }, 800);
        }
      }, 5000);
    }, 30000);

    const stopAfter = setTimeout(() => {
      if (checkInterval) clearInterval(checkInterval);
      setStatusMessage('Le serveur met plus de temps que prévu.');
    }, 600000);

    return () => {
      clearTimeout(initialDelay);
      clearTimeout(stopAfter);
      if (checkInterval) clearInterval(checkInterval);
    };
  }, [publicUrl, privateUrl]);

  return (
    <div className="server-restarting-container minimal">
      <img className="ryvie-logo" src={ryvieLogo} alt="Ryvie" />
      <div className="minimal-card">
        <div className="restarting-spinner simple" />
        <h1 className="restarting-title">Votre Ryvie redémarre</h1>
        <p className="restarting-message">Veuillez patienter quelques minutes{dots}</p>
        <div className="restarting-status">{statusMessage}</div>
        {checkCount > 0 && (
          <div className="restarting-info">Tentatives: {checkCount}</div>
        )}
      </div>
    </div>
  );
};

export default ServerRestarting;
