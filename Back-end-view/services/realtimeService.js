const { Server } = require('socket.io');

// Set up Socket.IO connections and Docker event bridging
// Params:
// - io: Socket.IO server instance
// - docker: dockerode instance
// - getLocalIP: function returning local IP string
// - getAppStatus: async function returning list of apps with statuses
function setupRealtime(io, docker, getLocalIP, getAppStatus) {
  // Active containers cache
  let activeContainers = [];

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

    socket.on('discover', () => {
      io.emit('server-detected', { message: 'Ryvie server found!', ip: getLocalIP() });
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });

  // Docker events stream
  docker.getEvents((err, stream) => {
    if (err) {
      console.error('Error listening to Docker events', err);
      return;
    }

    stream.on('data', (data) => {
      try {
        const event = JSON.parse(data.toString());
        if (event.Type === 'container' && (event.Action === 'start' || event.Action === 'stop')) {
          const containerName = event.Actor?.Attributes?.name;
          if (containerName) {
            if (event.Action === 'start') {
              if (!activeContainers.includes(containerName)) activeContainers.push(containerName);
            } else if (event.Action === 'stop') {
              activeContainers = activeContainers.filter(name => name !== containerName);
            }
            io.emit('containers', { activeContainers });
            // Broadcast updated apps status
            getAppStatus().then(apps => io.emit('apps-status-update', apps)).catch(err => {
              console.error('Erreur lors de la mise à jour des statuts d\'applications:', err);
            });
          }
        }
      } catch (e) {
        console.error('Failed to parse Docker event', e);
      }
    });
  });

  // Public API for server startup coordination
  return { initializeActiveContainers: () => initializeActiveContainers().then(() => activeContainers) };
}

module.exports = { setupRealtime };
