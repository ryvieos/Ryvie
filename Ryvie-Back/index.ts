export {};
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Récupérer automatiquement le .env depuis /data/config/backend-view/.env
const persistentEnvPath = '/data/config/backend-view/.env';
const localEnvPath = path.join(__dirname, '.env');

if (fs.existsSync(persistentEnvPath)) {
  try {
    fs.copyFileSync(persistentEnvPath, localEnvPath);
    console.log('✅ Configuration .env récupérée depuis /data/config/backend-view/');
  } catch (error: any) {
    console.warn('⚠️  Impossible de copier le .env depuis /data/config/backend-view/:', error.message);
  }
} else {
  console.warn('⚠️  Aucun .env trouvé dans /data/config/backend-view/');
}

// Charger les variables d'environnement du fichier .env
dotenv.config();

// Validate critical environment variables
const requiredEnvVars = {
  JWT_SECRET: 'JWT signing secret',
  LDAP_URL: 'LDAP server URL',
  LDAP_BIND_DN: 'LDAP bind DN',
  LDAP_BIND_PASSWORD: 'LDAP bind password'
};

const optionalEnvVars = {
  ENCRYPTION_KEY: 'Data encryption key',
  DEFAULT_EMAIL_DOMAIN: 'Default email domain for users without email'
};

let hasErrors = false;

// Check required variables
Object.entries(requiredEnvVars).forEach(([key, description]) => {
  if (!process.env[key]) {
    console.error(`❌ CRITICAL: ${key} environment variable is required (${description})`);
    hasErrors = true;
  }
});

// Warn about missing optional variables
Object.entries(optionalEnvVars).forEach(([key, description]) => {
  if (!process.env[key]) {
    console.warn(`⚠️  OPTIONAL: ${key} not set (${description})`);
  }
});

if (hasErrors) {
  console.error('\n💡 Please add the missing variables to your .env file');
  console.error('📖 See SECURITY.md for configuration details');
  process.exit(1);
}

console.log('✅ Environment variables validated successfully');

const usersRouter = require('./routes/users');
const appsRouter = require('./routes/apps');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const systemRouter = require('./routes/system');
const storageRouter = require('./routes/storage');
const userPreferencesRouter = require('./routes/userPreferences');
const appStoreRouter = require('./routes/appStore');
const healthRouter = require('./routes/health');
const { getAppStatus } = require('./services/dockerService');
const { setupRealtime } = require('./services/realtimeService');
const { getLocalIP, getPrivateIP, waitForWifiInterface, listNetworkInterfaces } = require('./utils/network');
const { syncBackgrounds, watchBackgrounds } = require('./utils/syncBackgrounds');
const { syncNetbirdConfig } = require('./utils/syncNetbirdConfig');

// Flag de readiness : true uniquement quand toute l'initialisation (Keycloak, AppStore, etc.) est terminée
(global as any).serverReady = false;

// Tracker de démarrage des services
const startupTracker = require('./services/startupTracker');

const docker = new Docker();
const app = express();
// Behind reverse proxies (Docker/Nginx), enable trust proxy so rate limit & req.ip work with X-Forwarded-For safely
app.set('trust proxy', 1);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: true, // Allow all origins
    methods: ["GET", "POST"],
    credentials: true,
  },
  // Allow Private Network Access for Socket.IO
  allowRequest: (req, callback) => {
    // Always allow the request, but set the Private Network Access header if needed
    callback(null, true);
  }
});

// Exposer Socket.IO dans global pour qu'il soit accessible depuis les routes et workers
(global as any).io = io;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API server
  crossOriginEmbedderPolicy: false
}));

// CORS configuration with Private Network Access support
// Required for Chrome/Edge to allow requests from http://172.55.100.228:3000 to http://172.55.100.228:3002
app.use((req: any, res: any, next: any) => {
  const origin = req.headers.origin;
  
  // Allow the request origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Handle Private Network Access preflight requests (Chrome/Edge security feature)
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json({ limit: '10mb' }));

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs (increased for polling + normal usage)
  message: {
    error: 'Trop de requêtes. Réessayez plus tard.',
    retryAfter: 15 * 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for certain endpoints if needed
  skip: (req) => {
    // Optionally skip rate limiting for health checks
    return req.path === '/status' || req.path === '/api/status';
  }
});

app.use('/api/', apiLimiter);

// Mount LDAP users routes
app.use('/api', usersRouter);

// Mount Docker apps routes
app.use('/api', appsRouter);

// Mount Auth routes
app.use('/api', authRouter);

// Mount OIDC Auth routes (SSO)
const oidcAuthRouter = require('./routes/oidcAuth');
app.use('/api/auth', oidcAuthRouter);

// Mount Admin routes
app.use('/api', adminRouter);

// Mount System routes
app.use('/api', systemRouter);
// Also mount at root to expose /status without /api prefix
app.use('/', systemRouter);

// Mount Storage routes (Step 0 skeleton)
app.use('/api', storageRouter);

// Initialiser Socket.IO dans le router storage pour les logs en temps réel
if (storageRouter.setSocketIO) {
  storageRouter.setSocketIO(io);
}

// Mount User Preferences routes
app.use('/api', userPreferencesRouter);

// Mount Settings routes
const settingsRouter = require('./routes/settings');
app.use('/api', settingsRouter);

// Mount App Store routes
app.use('/api', appStoreRouter);

// Mount Health check route (for update polling)
app.use('/api', healthRouter);

// Servir les fichiers de configuration JSON de manière statique pour le frontend
app.get('/config/netbird-data.json', (req, res) => {
  const netbirdPath = path.join(__dirname, '../Ryvie-Front/src/config/netbird-data.json');
  
  if (fs.existsSync(netbirdPath)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(netbirdPath);
  } else {
    res.json({
      domains: {},
      received: { backendHost: '' }
    });
  }
});

app.get('/config/app-ports.json', (req, res) => {
  const appPortsPath = path.join(__dirname, '../Ryvie-Front/src/config/app-ports.json');
  
  if (fs.existsSync(appPortsPath)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(appPortsPath);
  } else {
    // Retourner un objet vide par défaut si le fichier n'existe pas
    res.json({});
  }
});

// Realtime (Socket.IO + Docker events) handled by services/realtimeService.js
let realtime;

 
 
// Inline realtime code removed; replaced by realtimeService

// Charger les paramètres au démarrage
const { SETTINGS_FILE } = require('./config/paths');
try {
  // S'assurer que le dossier existe et créer un fichier avec id si absent
  const path = require('path');
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(SETTINGS_FILE)) {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Générer un id si manquant
    if (!settings.id) {
      settings.id = (crypto.randomUUID ? crypto.randomUUID() : 'ryvie-' + crypto.randomBytes(16).toString('hex'));
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
    if (settings.tokenExpirationMinutes) {
      process.env.JWT_EXPIRES_MINUTES = settings.tokenExpirationMinutes.toString();
      console.log(`✅ Durée d'expiration du token chargée: ${settings.tokenExpirationMinutes} minutes`);
    }
  } else {
    const defaults = {
      id: (crypto.randomUUID ? crypto.randomUUID() : 'ryvie-' + crypto.randomBytes(16).toString('hex')),
      tokenExpirationMinutes: 60
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaults, null, 2));
    process.env.JWT_EXPIRES_MINUTES = defaults.tokenExpirationMinutes.toString();
    console.log(`✅ Fichier de paramètres créé avec id ${defaults.id} et durée ${defaults.tokenExpirationMinutes} minutes`);
  }
} catch (error: any) {
  console.warn('⚠️  Impossible de charger/créer les paramètres serveur, utilisation des valeurs par défaut');
}

try {
  // Deuxième passe lecture pour log (si premier bloc a déjà fait le nécessaire)
  if (fs.existsSync(SETTINGS_FILE)) {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (settings.tokenExpirationMinutes) {
      process.env.JWT_EXPIRES_MINUTES = settings.tokenExpirationMinutes.toString();
      console.log(`✅ Durée d'expiration du token chargée: ${settings.tokenExpirationMinutes} minutes`);
    }
  }
} catch (_: any) {}

// Initialisation et démarrage des serveurs
async function startServer() {
  try {
    // Enregistrer tous les services de démarrage
    startupTracker.registerService('redis');
    startupTracker.registerService('network');
    startupTracker.registerService('caddy');
    startupTracker.registerService('keycloak');
    startupTracker.registerService('snapshots');
    startupTracker.registerService('realtime');
    startupTracker.registerService('manifests');
    startupTracker.registerService('appstore');
    startupTracker.registerService('backgrounds');
    startupTracker.registerService('netbird');

    // Vérifier et redémarrer Redis si nécessaire
    const { ensureRedisRunning } = require('./utils/redisHealthCheck');
    try {
      await ensureRedisRunning();
      startupTracker.markDone('redis');
    } catch (redisError: any) {
      startupTracker.markError('redis', redisError.message);
      throw redisError;
    }
    
    // Attendre qu'une interface réseau soit disponible (max 30 secondes)
    console.log('📶 Attente d\'une interface réseau valide...');
    listNetworkInterfaces(); // Debug: afficher les interfaces disponibles
    const networkIP = await waitForWifiInterface(30000, 1000);
    console.log(`✅ Interface réseau prête: ${networkIP}`);
    startupTracker.markDone('network');
    
    // Afficher aussi l'IP privée si disponible (VPN/Netbird)
    const privateIP = getPrivateIP();
    if (privateIP !== networkIP) {
      console.log(`🔒 IP privée (VPN): ${privateIP}`);
    }
    
    // Vérifier et démarrer le reverse proxy Caddy si nécessaire
    console.log('🔍 Vérification du reverse proxy Caddy...');
    try {
      const { ensureCaddyRunning } = require('./services/reverseProxyService');
      const caddyResult = await ensureCaddyRunning();
      if (caddyResult.success) {
        if (caddyResult.alreadyRunning) {
          console.log('✅ Caddy est déjà en cours d\'exécution');
        } else if (caddyResult.started) {
          console.log('✅ Caddy a été démarré avec succès');
        }
        startupTracker.markDone('caddy');
      } else {
        console.error('❌ Erreur lors de la vérification/démarrage de Caddy:', caddyResult.error);
        console.error('⚠️  Le reverse proxy n\'est pas disponible, l\'application peut ne pas être accessible via ryvie.local');
        startupTracker.markError('caddy', caddyResult.error || 'Caddy startup failed');
      }
    } catch (caddyError: any) {
      console.error('❌ Erreur critique lors de la vérification de Caddy:', caddyError.message);
      console.error('⚠️  Continuons le démarrage sans le reverse proxy...');
      startupTracker.markError('caddy', caddyError.message);
    }
    
    // Vérifier et démarrer Keycloak si nécessaire
    console.log('🔍 Vérification de Keycloak...');
    try {
      const { ensureKeycloakRunning } = require('./services/keycloakService');
      const keycloakResult = await ensureKeycloakRunning();
      if (keycloakResult.success) {
        if (keycloakResult.alreadyRunning) {
          console.log('✅ Keycloak est déjà en cours d\'exécution');
        } else if (keycloakResult.started) {
          console.log('✅ Keycloak a été démarré avec succès');
        }
        startupTracker.markDone('keycloak');
      } else {
        console.error('❌ Erreur lors de la vérification/démarrage de Keycloak:', keycloakResult.error);
        startupTracker.markError('keycloak', keycloakResult.error || 'Keycloak startup failed');
      }
    } catch (keycloakError: any) {
      console.error('❌ Erreur critique lors de la vérification de Keycloak:', keycloakError.message);
      console.error('⚠️  Continuons le démarrage sans Keycloak...');
      startupTracker.markError('keycloak', keycloakError.message);
    }
    
    // Vérifier les snapshots en attente (après une mise à jour)
    const { checkPendingSnapshots } = require('./utils/snapshotCleanup');
    try {
      checkPendingSnapshots();
      startupTracker.markDone('snapshots');
    } catch (snapError: any) {
      startupTracker.markError('snapshots', snapError.message);
    }
    
    // Initialize realtime service
    try {
      realtime = setupRealtime(io, docker, getLocalIP, getAppStatus);
      await realtime.initializeActiveContainers();
      startupTracker.markDone('realtime');
    } catch (realtimeError: any) {
      console.error('❌ Erreur lors de l\'initialisation du service realtime:', realtimeError.message);
      startupTracker.markError('realtime', realtimeError.message);
    }

    // Générer les manifests des applications au démarrage
    console.log('🔧 Génération des manifests des applications...');
    try {
      const { execSync } = require('child_process');
      const manifestScript = require('path').join(__dirname, '..', '..', 'generate-manifests.js');
      execSync(`node ${manifestScript}`, { stdio: 'inherit' });
      console.log('✅ Manifests générés avec succès');
      startupTracker.markDone('manifests');
    } catch (manifestError: any) {
      console.error('⚠️  Erreur lors de la génération des manifests:', manifestError.message);
      startupTracker.markError('manifests', manifestError.message);
    }
    
    // Initialiser le service App Store
    const { initialize: initAppStore } = require('./services/appStoreService');
    try {
      await initAppStore();
      startupTracker.markDone('appstore');
    } catch (appStoreError: any) {
      console.error('❌ Erreur lors de l\'initialisation de l\'App Store:', appStoreError.message);
      startupTracker.markError('appstore', appStoreError.message);
    }
    
    // Synchroniser les fonds d'écran au démarrage
    try {
      syncBackgrounds();
      // Surveiller les changements dans le dossier public/images/backgrounds
      watchBackgrounds();
      startupTracker.markDone('backgrounds');
    } catch (bgError: any) {
      console.error('⚠️  Erreur lors de la synchronisation des fonds d\'écran:', bgError.message);
      startupTracker.markError('backgrounds', bgError.message);
    }
    
    // Synchroniser la configuration Netbird au démarrage
    try {
      syncNetbirdConfig();
      startupTracker.markDone('netbird');
    } catch (netbirdError: any) {
      console.error('⚠️  Erreur lors de la synchronisation Netbird:', netbirdError.message);
      startupTracker.markError('netbird', netbirdError.message);
    }
    
    // Note: serverReady est maintenant géré automatiquement par startupTracker
    // quand tous les services enregistrés sont terminés (done ou error)
    
    const PORT = process.env.PORT || 3002;
    httpServer.listen(PORT, () => {
      console.log(`HTTP Server running on http://${getLocalIP()}:${PORT}`);
    });
  } catch (err: any) {
    console.error('Erreur lors de l\'initialisation du serveur :', err);
  }
}

startServer();

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('SIGTERM reçu, arrêt gracieux...');
  if (realtime && realtime.cleanup) {
    realtime.cleanup();
  }
  httpServer.close(() => {
    console.log('Serveur HTTP fermé');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT reçu, arrêt gracieux...');
  if (realtime && realtime.cleanup) {
    realtime.cleanup();
  }
  httpServer.close(() => {
    console.log('Serveur HTTP fermé');
    process.exit(0);
  });
});
