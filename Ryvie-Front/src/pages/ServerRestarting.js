import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import urlsConfig from '../config/urls';
const { getServerUrl, getCurrentLocation } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import '../styles/ServerRestarting.css';
import ryvieLogo from '../icons/ryvielogo0.png';

const ServerRestarting = () => {
  const navigate = useNavigate();
  const [dots, setDots] = useState('');
  const [checkCount, setCheckCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Redémarrage en cours');

  // Utiliser l'URL du serveur basée sur l'URL courante du navigateur
  const serverUrl = useMemo(() => getServerUrl(), []);

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
      // Tester l'URL du serveur basée sur l'URL courante
      const paths = ['/api/status', '/status'];
      if (!serverUrl) return false;
      for (const p of paths) {
        try {
          const resp = await axios.get(`${serverUrl}${p}`, { timeout: 5000 });
          if (resp.status === 200) {
            return true;
          }
        } catch (_) {}
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
  }, [serverUrl]);

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
