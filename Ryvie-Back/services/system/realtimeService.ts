// Set up Socket.IO connections and Docker event bridging
// Params:
// - io: Socket.IO server instance
// - docker: dockerode instance
// - getLocalIP: function returning local IP string
// - getAppStatus: async function returning list of apps with statuses
const POLLING_INTERVAL_MS = 30000; // 30 secondes

function setupRealtime(io, docker, getLocalIP, getAppStatus) {
  // Active containers cache
  let activeContainers = [];
  let statusPollingInterval = null;
  let dockerEventStream = null;
  let lastAppStatus = null; // Cache du dernier statut envoyé
  let broadcastPaused = false; // Pause pendant les opérations docker compose

  // ───────────────────── Auto-réparation du provisioning ─────────────────────
  // Certains comptes par défaut se créent via l'API REST de l'app (mode `provision: api`,
  // ex. n8n). Or cette API peut n'être réellement montée que TARD après le démarrage du
  // conteneur — bien après le délai fixe de l'install — ce qui faisait échouer la création
  // (owner jamais créé → bootstrap 401) de façon DÉPENDANTE DE LA MACHINE.
  // Ce poller est le point « garanti-après-prêt » : il ne marque une app `running` que
  // lorsque TOUS ses conteneurs sont healthy, il tourne toutes les 30 s ET à chaque
  // événement Docker (start / health_status). On y (re)tente donc la création — idempotente —
  // jusqu'à réussite, sur N'IMPORTE QUELLE machine, sans timeout fragile.
  const selfHealedAccounts = new Set();  // apps dont le compte par défaut est confirmé créé
  const selfHealInFlight = new Set();     // tentatives en cours (évite la concurrence)

  const selfHealDefaultAccounts = (apps) => {
    if (!Array.isArray(apps)) return;
    for (const app of apps) {
      const id = app && app.id;
      if (!id || selfHealedAccounts.has(id) || selfHealInFlight.has(id)) continue;
      // Attendre que TOUS les conteneurs soient healthy (statut calculé par appManager).
      // NB : l'objet `app` du broadcast est allégé (pas de bloc `accounts`, qui contient le
      // mdp par défaut et ne doit JAMAIS transiter ici) → c'est provisionDefault({apiOnly})
      // qui lit la recette et ne traite que le mode `api` ; les autres apps no-op et passent
      // direct dans selfHealedAccounts (un seul getRecipe, jamais de docker exec).
      if (app.status !== 'running') continue;

      selfHealInFlight.add(id);
      Promise.resolve()
        .then(() => require('../apps/appAccountsService').provisionDefault(id, { apiOnly: true }))
        .then((result) => {
          // Résolu (sans throw) = état atteint → on ne re-balaye plus cette app.
          selfHealedAccounts.add(id);
          if (result === 'created') {
            console.log(`[realtime] ✅ Compte par défaut de ${id} créé (auto-réparation après readiness)`);
            // Best-effort : pré-créer le secret d'app (ex. clé API n8n), comme à l'install.
            try {
              const aiSvc = require('../ai/aiService');
              if (aiSvc && aiSvc.bootstrapAppSecret) return aiSvc.bootstrapAppSecret(id);
            } catch (_) { /* ignore */ }
          } else if (result === 'exists') {
            console.log(`[realtime] ✓ Compte par défaut de ${id} déjà présent (vérifié par auto-réparation)`);
          }
          // result undefined (app sans provisioning api) → silencieux, juste débounce.
        })
        .catch(() => { /* API REST pas encore prête → on retentera au prochain tick/événement */ })
        .finally(() => { selfHealInFlight.delete(id); });
    }
  };

  const broadcastAppStatus = () => {
    if (broadcastPaused) {
      return Promise.resolve(lastAppStatus || []);
    }
    return getAppStatus()
    .then(apps => {
      // Auto-réparation idempotente du provisioning (best-effort, non bloquant) — exécutée
      // à CHAQUE cycle, indépendamment de la détection de changement de statut ci-dessous.
      try { selfHealDefaultAccounts(apps); } catch (_) { /* ne jamais casser la diffusion */ }

      // Comparer avec le dernier statut pour détecter les changements
      const currentStatusStr = JSON.stringify(apps);
      const lastStatusStr = lastAppStatus ? JSON.stringify(lastAppStatus) : null;
      
      if (currentStatusStr === lastStatusStr) {
        // Aucun changement, ne pas diffuser
        return apps;
      }
      
      // Changement détecté, diffuser et mettre à jour le cache
      console.log('[realtime] Changement de statut détecté, diffusion...');
      lastAppStatus = apps;
      io.emit('apps-status-update', apps);
      io.emit('appsStatusUpdate', apps);
      return apps;
    })
    .catch(err => {
      console.error('[realtime] Erreur lors de la mise à jour des statuts d\'applications:', err);
      throw err;
    });
  };

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
      const names = containers.map(c => (c.Names?.[0] || '').replace('/', '')).filter(Boolean);      activeContainers = names;
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
                    activeContainers = activeContainers.filter(name => name !== containerName);                  }
                  io.emit('containers', { activeContainers });
                  // Broadcast updated apps status
                  broadcastAppStatus().then(() => {
                    console.log(`[realtime] Mise à jour statuts après ${event.Action} de ${containerName}`);
                  }).catch(() => {});
                }
              } else if (typeof event.Action === 'string' && event.Action.indexOf('health_status') === 0) {
                // Le passage à "healthy" survient APRÈS le 'start' → c'est ce moment qui rend
                // l'API REST de l'app réellement opérationnelle. On rafraîchit le statut (donc                // l'auto-réparation du provisioning) même sans aucun client UI connecté.
                broadcastAppStatus().catch(() => {});
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
    pauseBroadcast: () => {
      broadcastPaused = true;
      console.log('[realtime] ⏸️  Broadcast des statuts mis en pause');
    },
    resumeBroadcast: () => {
      broadcastPaused = false;
      console.log('[realtime] ▶️  Broadcast des statuts repris');
      // Forcer une mise à jour immédiate après la reprise
      lastAppStatus = null;
      broadcastAppStatus().catch(() => {});
    },
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
