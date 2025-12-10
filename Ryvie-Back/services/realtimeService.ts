// Set up Socket.IO connections and Docker event bridging
// Params:
// - io: Socket.IO server instance
// - docker: dockerode instance
// - getLocalIP: function returning local IP string
// - getAppStatus: async function returning list of apps with statuses
const POLLING_INTERVAL_MS = 60000;

function setupRealtime(io, docker, getLocalIP, getAppStatus) {
  // Active containers cache
  let activeContainers = [];
  let statusPollingInterval = null;
  let dockerEventStream = null;

  const broadcastAppStatus = () => getAppStatus()
    .then(apps => {
      // Émettre les deux noms d'événement pour compatibilité
      io.emit('apps-status-update', apps);
      io.emit('appsStatusUpdate', apps);
      return apps;
    })
    .catch(err => {
      console.error('[realtime] Erreur lors de la mise à jour des statuts d\'applications:', err);
      throw err;
    });

  const ensureStatusPolling = () => {
    if (!statusPollingInterval) {
      statusPollingInterval = setInterval(() => {
        broadcastAppStatus().catch(() => {});
      }, POLLING_INTERVAL_MS);
    }
  };

  const stopStatusPolling = () => {
    if (statusPollingInterval) {
      clearInterval(statusPollingInterval);
      statusPollingInterval = null;
    }
  };

  // Initialize current containers list
  const initializeActiveContainers = () => new Promise((resolve, reject) => {
    docker.listContainers({ all: false }, (err, containers) => {
      if (err) return reject(err);
      const names = containers.map(c => (c.Names?.[0] || '').replace('/', '')).filter(Boolean);
      activeContainers = names;
      resolve(names);
    });
  });

  // Client connections
  io.on('connection', async (socket) => {
    console.log('Client connected');
    socket.emit('status', { serverStatus: true });
    socket.emit('containers', { activeContainers });

    broadcastAppStatus().catch(() => {});
    ensureStatusPolling();

    socket.on('discover', () => {
      io.emit('server-detected', { message: 'Ryvie server found!', ip: getLocalIP() });
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
      const activeConnections = io.engine?.clientsCount ?? io.sockets?.sockets?.size ?? 0;
      if (activeConnections === 0) {
        stopStatusPolling();
      }
    });
  });

  // Docker events stream
  docker.getEvents((err, stream) => {
    if (err) {
      console.error('Error listening to Docker events', err);
      return;
    }

    dockerEventStream = stream;
    let buffer = '';

    stream.on('data', (chunk) => {
      try {
        // Ajouter le chunk au buffer
        buffer += chunk.toString();
        
        // Essayer de parser chaque ligne JSON complète
        const lines = buffer.split('\n');
        
        // Garder la dernière ligne (potentiellement incomplète) dans le buffer
        buffer = lines.pop() || '';
        
        // Traiter chaque ligne complète
        lines.forEach(line => {
          if (!line.trim()) return;
          
          try {
            const event = JSON.parse(line);
            const containerName = event.Actor?.Attributes?.name;
            
            if (event.Type === 'container') {
              // Événements start/stop
              if (event.Action === 'start' || event.Action === 'stop') {
                if (containerName) {
                  if (event.Action === 'start') {
                    if (!activeContainers.includes(containerName)) {
                      activeContainers.push(containerName);
                    }
                  } else if (event.Action === 'stop') {
                    activeContainers = activeContainers.filter(name => name !== containerName);
                  }
                  io.emit('containers', { activeContainers });
                  // Broadcast updated apps status
                  broadcastAppStatus().then(() => {
                    console.log(`[realtime] Mise à jour statuts après ${event.Action} de ${containerName}`);
                  }).catch(() => {});
                }
              }
            }
          } catch (parseError: any) {
            // Ignorer silencieusement les lignes qui ne sont pas du JSON valide
            // (peut arriver avec des messages de debug Docker)
          }
        });
      } catch (e: any) {
        console.error('Failed to process Docker event stream', e);
        // Réinitialiser le buffer en cas d'erreur
        buffer = '';
      }
    });

    stream.on('error', (streamError) => {
      console.error('Docker event stream error', streamError);
      buffer = '';
    });
  });

  // Public API for server startup coordination
  return {
    initializeActiveContainers: () => initializeActiveContainers().then(() => activeContainers),
    stopPolling: () => stopStatusPolling(),
    cleanup: () => {
      stopStatusPolling();
      if (dockerEventStream) {
        try {
          dockerEventStream.destroy();
          dockerEventStream = null;
          console.log('[realtime] Docker event stream fermé');
        } catch (e) {
          console.error('[realtime] Erreur lors de la fermeture du stream Docker:', e);
        }
      }
    }
  };
}

export = { setupRealtime };
