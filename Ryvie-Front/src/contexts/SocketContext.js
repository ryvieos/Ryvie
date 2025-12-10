import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { connectRyvieSocket } from '../utils/detectAccessMode';
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { StorageManager } from '../utils/platformUtils';

const SocketContext = createContext(null);

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket doit être utilisé dans un SocketProvider');
  }
  return context;
};

export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [serverStatus, setServerStatus] = useState(() => {
    // Initialiser depuis le cache préchargé par Welcome.js
    try {
      const cached = StorageManager.getItem('server_status_cache');
      if (cached && cached.connected !== undefined) {
        // Vérifier que le cache n'est pas trop vieux (max 10 secondes)
        const age = Date.now() - (cached.timestamp || 0);
        if (age < 10000) {
          console.log('[SocketContext] État serveur depuis cache:', cached.connected ? 'Connecté' : 'Déconnecté');
          return cached.connected;
        }
      }
    } catch {}
    return false; // Par défaut: déconnecté
  });
  const [accessMode, setAccessMode] = useState(() => getCurrentAccessMode());
  const socketRef = useRef(null);
  const accessModeRef = useRef(null);

  // Vérifier périodiquement si le mode d'accès est disponible
  useEffect(() => {
    if (accessMode) return; // Déjà défini
    
    let interval = null;
    let timeout = null;
    
    const checkAccessMode = () => {
      const mode = getCurrentAccessMode();
      if (mode) {
        console.log('[SocketContext] Mode d\'accès détecté:', mode);
        setAccessMode(mode);
        // Nettoyer immédiatement après détection
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
      }
    };
    
    // Vérifier toutes les 100ms pendant 2 secondes max
    interval = setInterval(checkAccessMode, 100);
    timeout = setTimeout(() => {
      if (interval) clearInterval(interval);
    }, 2000);
    
    return () => {
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
    };
  }, [accessMode]);

  useEffect(() => {
    
    // Ne pas reconnecter si on a déjà un socket pour ce mode
    if (socketRef.current && accessModeRef.current === accessMode) {
      console.log('[SocketContext] Socket déjà connecté pour ce mode, réutilisation');
      return;
    }

    // Déconnecter l'ancien socket si le mode a changé
    if (socketRef.current && accessModeRef.current !== accessMode) {
      console.log('[SocketContext] Changement de mode, déconnexion de l\'ancien socket');
      try {
        socketRef.current.disconnect();
      } catch {}
      socketRef.current = null;
    }

    if (!accessMode) {
      console.log('[SocketContext] Pas de mode d\'accès, pas de connexion socket');
      return;
    }

    console.log('[SocketContext] Connexion socket pour mode:', accessMode);
    accessModeRef.current = accessMode;

    const newSocket = connectRyvieSocket({
      mode: accessMode,
      onConnect: (s) => {
        console.log(`[SocketContext] Socket.io connecté en mode ${accessMode}`);
        socketRef.current = s;
        setSocket(s);
        setIsConnected(true);
        setServerStatus(true);
      },
      onDisconnect: () => {
        console.log('[SocketContext] Socket.io déconnecté');
        setIsConnected(false);
        setServerStatus(false);
      },
      onError: (error) => {
        console.log(`[SocketContext] Erreur de connexion Socket.io:`, error?.message);
        setIsConnected(false);
        setServerStatus(false);
      },
      onServerStatus: (data) => {
        console.log('[SocketContext] Statut serveur reçu:', data.status);
        setServerStatus(data.status);
      }
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    // Cleanup uniquement au démontage complet de l'app
    return () => {
      console.log('[SocketContext] Nettoyage du provider');
      if (socketRef.current) {
        try {
          socketRef.current.disconnect();
        } catch {}
        socketRef.current = null;
      }
    };
  }, [accessMode]); // Se reconnecter si le mode change

  const value = {
    socket,
    isConnected,
    serverStatus,
    setServerStatus
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};
