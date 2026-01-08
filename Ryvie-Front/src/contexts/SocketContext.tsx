import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import type { ReactNode, FC } from 'react';
import { connectRyvieSocket } from '../utils/detectAccessMode';
import { getCurrentAccessMode } from '../utils/detectAccessMode';
import { StorageManager } from '../utils/platformUtils';
import type { Socket } from 'socket.io-client';

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  serverStatus: boolean;
  setServerStatus: (status: boolean) => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export const useSocket = (): SocketContextValue => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket doit être utilisé dans un SocketProvider');
  }
  return context;
};

interface SocketProviderProps {
  children: ReactNode;
}

export const SocketProvider: FC<SocketProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [serverStatus, setServerStatus] = useState<boolean>(() => {
    try {
      const cached = StorageManager.getItem<any>('server_status_cache');
      if (cached && cached.connected !== undefined) {
        const age = Date.now() - (cached.timestamp || 0);
        if (age < 10000) {
          console.log('[SocketContext] État serveur depuis cache:', cached.connected ? 'Connecté' : 'Déconnecté');
          return cached.connected;
        }
      }
    } catch {}
    return false;
  });
  const [accessMode, setAccessMode] = useState<string | null>(() => getCurrentAccessMode());
  const socketRef = useRef<Socket | null>(null);
  const accessModeRef = useRef<string | null>(null);

  useEffect(() => {
    if (accessMode) return;
    
    let interval: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    
    const checkAccessMode = () => {
      const mode = getCurrentAccessMode();
      if (mode) {
        console.log('[SocketContext] Mode d\'accès détecté:', mode);
        setAccessMode(mode);
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
      }
    };
    
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
    if (socketRef.current && accessModeRef.current === accessMode) {
      console.log('[SocketContext] Socket déjà connecté pour ce mode, réutilisation');
      return;
    }

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
      mode: accessMode as any,
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
      onServerStatus: (data: any) => {
        console.log('[SocketContext] Statut serveur reçu:', data.status);
        setServerStatus(data.status);
      }
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    return () => {
      console.log('[SocketContext] Nettoyage du provider');
      if (socketRef.current) {
        try {
          socketRef.current.disconnect();
        } catch {}
        socketRef.current = null;
      }
    };
  }, [accessMode]);

  const value: SocketContextValue = {
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
