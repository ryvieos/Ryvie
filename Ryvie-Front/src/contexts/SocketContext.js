import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { connectRyvieSocket } from '../utils/detectAccessMode';
import { getCurrentAccessMode } from '../utils/detectAccessMode';

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
  const [serverStatus, setServerStatus] = useState(false);
  const socketRef = useRef(null);
  const accessModeRef = useRef(null);

  useEffect(() => {
    const accessMode = getCurrentAccessMode();
    
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
  }, []); // Vide pour ne se connecter qu'une fois

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
