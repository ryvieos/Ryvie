const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
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
const { getAppStatus } = require('./services/dockerService');

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

// Fonction pour récupérer les conteneurs Docker actifs
async function initializeActiveContainers() {
  return new Promise((resolve, reject) => {
    docker.listContainers({ all: false }, (err, containers) => {
      if (err) return reject(err);

      const containerNames = containers.map((container) => {
        return container.Names[0].replace('/', '');
      });

      console.log('Liste initialisée des conteneurs actifs :', containerNames);
      resolve(containerNames);
    });
  });
}

// Fonction pour récupérer l'adresse IP locale
function getLocalIP() {
  const networkInterfaces = os.networkInterfaces();
  for (const interfaceName in networkInterfaces) {
    const addresses = networkInterfaces[interfaceName];
    for (const addressInfo of addresses) {
      if (addressInfo.family === 'IPv4' && !addressInfo.internal) {
        return addressInfo.address;
      }
    }
  }
  return 'IP not found';
}

// Helper function to trigger LDAP sync
async function triggerLdapSync() {
  return new Promise((resolve) => {
    const client = require('http');
    const options = {
      hostname: 'localhost',
      port: 2283,
      path: '/api/admin/users/sync-ldap',
      method: 'GET',
      timeout: 10000 // 10 second timeout
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        console.log(`LDAP sync completed with status ${res.statusCode}: ${data}`);
        resolve({ statusCode: res.statusCode, data });
      });
    });

    req.on('error', (e) => {
      console.error('Error triggering LDAP sync:', e);
      resolve({ statusCode: 500, error: e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('LDAP sync request timed out');
      resolve({ statusCode: 504, error: 'Request timeout' });
    });

    req.end();
  });
}

 

// Liste des conteneurs actifs
let activeContainers = [];
let isServerDetected = false;

io.on('connection', async (socket) => {
  console.log('Un client est connecté');

  socket.emit('status', { serverStatus: true });
  socket.emit('containers', { activeContainers });

  socket.on('discover', () => {
    io.emit('server-detected', { message: 'Ryvie server found!', ip: getLocalIP() });
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté');
  });
});

// Écouter les événements Docker et mettre à jour la liste des conteneurs
docker.getEvents((err, stream) => {
  if (err) {
    console.error('Erreur lors de l\'écoute des événements Docker', err);
    return;
  }

  stream.on('data', (data) => {
    const event = JSON.parse(data.toString());
    if (event.Type === 'container' && (event.Action === 'start' || event.Action === 'stop')) {
      const containerName = event.Actor.Attributes.name;
      if (event.Action === 'start') {
        if (!activeContainers.includes(containerName)) {
          activeContainers.push(containerName);
        }
      } else if (event.Action === 'stop') {
        activeContainers = activeContainers.filter((name) => name !== containerName);
      }
      io.emit('containers', { activeContainers });
      
      // Émettre l'événement de mise à jour des applications
      // Cela permet au frontend de mettre à jour l'état des applications en temps réel
      getAppStatus().then(apps => {
        io.emit('apps-status-update', apps);
      }).catch(error => {
        console.error('Erreur lors de la mise à jour des statuts d\'applications:', error);
      });
    }
  });
});

// Initialisation et démarrage des serveurs
async function startServer() {
  try {
    activeContainers = await initializeActiveContainers();
    console.log('Liste initialisée des conteneurs actifs :', activeContainers);

    const PORT = process.env.PORT || 3002;
    httpServer.listen(PORT, () => {
      console.log(`HTTP Server running on http://${getLocalIP()}:${PORT}`);
    });
  } catch (err) {
    console.error('Erreur lors de l\'initialisation du serveur :', err);
  }
}

startServer();