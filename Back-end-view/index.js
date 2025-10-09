const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

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
const { getAppStatus } = require('./services/dockerService');
const { setupRealtime } = require('./services/realtimeService');
const { getLocalIP } = require('./utils/network');
const { syncBackgrounds, watchBackgrounds } = require('./utils/syncBackgrounds');

const docker = new Docker();
const app = express();
// Behind reverse proxies (Docker/Nginx), enable trust proxy so rate limit & req.ip work with X-Forwarded-For safely
app.set('trust proxy', 1);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API server
  crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 500 requests per windowMs (increased for normal usage)
  message: {
    error: 'Trop de requêtes. Réessayez plus tard.',
    retryAfter: 15 * 60
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

// Mount LDAP users routes
app.use('/api', usersRouter);

// Mount Docker apps routes
app.use('/api', appsRouter);

// Mount Auth routes
app.use('/api', authRouter);

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

// Realtime (Socket.IO + Docker events) handled by services/realtimeService.js
let realtime;

 
 
// Inline realtime code removed; replaced by realtimeService

// Charger les paramètres au démarrage
const fs = require('fs');
const SETTINGS_FILE = '/data/config/server-settings.json';
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (settings.tokenExpirationMinutes) {
      process.env.JWT_EXPIRES_MINUTES = settings.tokenExpirationMinutes.toString();
      console.log(`✅ Durée d'expiration du token chargée: ${settings.tokenExpirationMinutes} minutes`);
    }
  }
} catch (error) {
  console.warn('⚠️  Impossible de charger les paramètres serveur, utilisation des valeurs par défaut');
}

// Initialisation et démarrage des serveurs
async function startServer() {
  try {
    // Initialize realtime service
    realtime = setupRealtime(io, docker, getLocalIP, getAppStatus);
    await realtime.initializeActiveContainers();

    // Générer les manifests des applications au démarrage
    console.log('🔧 Génération des manifests des applications...');
    try {
      const { execSync } = require('child_process');
      const manifestScript = require('path').join(__dirname, '..', 'generate-manifests.js');
      execSync(`node ${manifestScript}`, { stdio: 'inherit' });
      console.log('✅ Manifests générés avec succès');
    } catch (manifestError) {
      console.error('⚠️  Erreur lors de la génération des manifests:', manifestError.message);
    }

    // Synchroniser les fonds d'écran au démarrage
    syncBackgrounds();
    
    // Surveiller les changements dans le dossier public/images/backgrounds
    watchBackgrounds();
    
    const PORT = process.env.PORT || 3002;
    httpServer.listen(PORT, () => {
      console.log(`HTTP Server running on http://${getLocalIP()}:${PORT}`);
    });
  } catch (err) {
    console.error('Erreur lors de l\'initialisation du serveur :', err);
  }
}

startServer();