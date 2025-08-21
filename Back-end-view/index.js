const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const Docker = require('dockerode');
const diskusage = require('diskusage');
const path = require('path');
const ldap = require('ldapjs');
const si = require('systeminformation');
const osutils = require('os-utils');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const { ensureConnected } = require('./redisClient');

// Charger les variables d'environnement du fichier .env
dotenv.config();

// Secret pour les JWT tokens
const JWT_SECRET = process.env.JWT_SECRET;
// Durée d'expiration des JWT (en minutes) configurable via .env
const JWT_EXPIRES_MINUTES = Math.max(
  1,
  parseInt(process.env.JWT_EXPIRES_MINUTES || '15', 10) || 15
);
const JWT_EXPIRES_SECONDS = JWT_EXPIRES_MINUTES * 60;

// Validate critical environment variables
const requiredEnvVars = {
  JWT_SECRET: 'JWT signing secret',
  LDAP_URL: 'LDAP server URL',
  LDAP_BIND_DN: 'LDAP bind DN',
  LDAP_BIND_PASSWORD: 'LDAP bind password'
};

const optionalEnvVars = {
  ENCRYPTION_KEY: 'Data encryption key',
  JWT_ENCRYPTION_KEY: 'JWT encryption key',
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

const { verifyToken, isAdmin, hasPermission } = require('./middleware/auth');

const docker = new Docker();
const app = express();
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

// Rate limiting for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.',
    retryAfter: 15 * 60
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests
  skipSuccessfulRequests: true,
  // Custom key generator to include user ID
  keyGenerator: (req) => {
    return `${req.ip}_${req.body?.uid || 'unknown'}`;
  }
});

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

// Correspondances des noms de conteneurs Docker avec des noms personnalisés
const containerMapping = {
  'rcloud': 'Cloud',
  'portainer': 'Portainer',
  'rtransfer': 'rTransfer',
  'rdrop': 'rDrop',
  'rpictures': 'rPictures',
};

// Fonction pour extraire le nom de l'application à partir du nom du conteneur
function extractAppName(containerName) {
  // Vérifier si le conteneur commence par 'app-'
  if (containerName.startsWith('app-')) {
    // Extraire la partie après 'app-'
    const appNameWithSuffix = containerName.substring(4);
    // Extraire la partie avant le prochain tiret ou prendre tout si pas de tiret
    const dashIndex = appNameWithSuffix.indexOf('-');
    if (dashIndex > 0) {
      return appNameWithSuffix.substring(0, dashIndex);
    }
    return appNameWithSuffix;
  }
  // Pour les conteneurs qui ne commencent pas par 'app-', retourner null
  return null;
}

// Fonction pour récupérer tous les conteneurs Docker (actifs et inactifs)
async function getAllContainers() {
  return new Promise((resolve, reject) => {
    docker.listContainers({ all: true }, (err, containers) => {
      if (err) return reject(err);
      resolve(containers);
    });
  });
}

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

// Fonction pour regrouper les conteneurs par application
async function getAppStatus() {
  try {
    const containers = await getAllContainers();
    const apps = {};
    
    // Regrouper les conteneurs par application
    containers.forEach(container => {
      const containerName = container.Names[0].replace('/', '');
      const appName = extractAppName(containerName);
      
      // Si ce n'est pas un conteneur d'application, ignorer
      if (!appName) return;
      
      // Créer l'entrée de l'application si elle n'existe pas
      if (!apps[appName]) {
        // Utiliser le nom personnalisé s'il existe, sinon utiliser le nom extrait
        const displayName = containerMapping[appName] || appName;
        apps[appName] = {
          id: `app-${appName}`,
          name: displayName,
          containers: [],
          running: false,
          total: 0,
          active: 0,
          ports: []
        };
      }
      
      // Ajouter le conteneur à l'application
      apps[appName].total++;
      if (container.State === 'running') {
        apps[appName].active++;
        
        // Collecter les ports exposés
        if (container.Ports && container.Ports.length > 0) {
          container.Ports.forEach(port => {
            if (port.PublicPort && !apps[appName].ports.includes(port.PublicPort)) {
              apps[appName].ports.push(port.PublicPort);
            }
          });
        }
      }
      
      apps[appName].containers.push({
        id: container.Id,
        name: containerName,
        state: container.State,
        status: container.Status
      });
    });
    
    // Déterminer si l'application est considérée comme "running"
    // Une application est "running" seulement si TOUS ses conteneurs sont actifs
    for (const appName in apps) {
      const app = apps[appName];
      app.running = app.total > 0 && app.active === app.total;
    }
    
    // Formater la sortie finale
    return Object.values(apps).map(app => ({
      id: app.id,
      name: app.name,
      status: app.running ? 'running' : 'stopped',
      progress: app.total > 0 ? Math.round((app.active / app.total) * 100) : 0,
      containersRunning: `${app.active}/${app.total}`,
      ports: app.ports.sort((a, b) => a - b), // Trier les ports
      containers: app.containers
    }));
  } catch (error) {
    console.error('Erreur lors de la récupération du statut des applications:', error);
    throw error;
  }
}

// Fonction pour démarrer une application (tous ses conteneurs)
async function startApp(appId) {
  try {
    const containers = await getAllContainers();
    let startedCount = 0;
    let failedCount = 0;
    
    // Filtrer les conteneurs appartenant à cette application
    const appContainers = containers.filter(container => {
      const containerName = container.Names[0].replace('/', '');
      return containerName.startsWith(appId);
    });
    
    if (appContainers.length === 0) {
      throw new Error(`Aucun conteneur trouvé pour l'application ${appId}`);
    }
    
    // Démarrer chaque conteneur arrêté
    for (const container of appContainers) {
      if (container.State !== 'running') {
        try {
          const containerObj = docker.getContainer(container.Id);
          await containerObj.start();
          startedCount++;
        } catch (err) {
          console.error(`Erreur lors du démarrage du conteneur ${container.Names[0]}:`, err);
          failedCount++;
        }
      }
    }
    
    return {
      success: failedCount === 0,
      message: `${startedCount} conteneur(s) démarré(s), ${failedCount} échec(s)`,
      appId
    };
  } catch (error) {
    console.error(`Erreur lors du démarrage de l'application ${appId}:`, error);
    throw error;
  }
}

// Fonction pour arrêter une application (tous ses conteneurs)
async function stopApp(appId) {
  try {
    const containers = await getAllContainers();
    let stoppedCount = 0;
    let failedCount = 0;
    
    // Filtrer les conteneurs appartenant à cette application
    const appContainers = containers.filter(container => {
      const containerName = container.Names[0].replace('/', '');
      return containerName.startsWith(appId);
    });
    
    if (appContainers.length === 0) {
      throw new Error(`Aucun conteneur trouvé pour l'application ${appId}`);
    }
    
    // Arrêter chaque conteneur en cours d'exécution
    for (const container of appContainers) {
      if (container.State === 'running') {
        try {
          const containerObj = docker.getContainer(container.Id);
          await containerObj.stop();
          stoppedCount++;
        } catch (err) {
          console.error(`Erreur lors de l'arrêt du conteneur ${container.Names[0]}:`, err);
          failedCount++;
        }
      }
    }
    
    return {
      success: failedCount === 0,
      message: `${stoppedCount} conteneur(s) arrêté(s), ${failedCount} échec(s)`,
      appId
    };
  } catch (error) {
    console.error(`Erreur lors de l'arrêt de l'application ${appId}:`, error);
    throw error;
  }
}

// Fonction pour redémarrer une application (tous ses conteneurs)
async function restartApp(appId) {
  try {
    const containers = await getAllContainers();
    let restartedCount = 0;
    let failedCount = 0;
    
    // Filtrer les conteneurs appartenant à cette application
    const appContainers = containers.filter(container => {
      const containerName = container.Names[0].replace('/', '');
      return containerName.startsWith(appId);
    });
    
    if (appContainers.length === 0) {
      throw new Error(`Aucun conteneur trouvé pour l'application ${appId}`);
    }
    
    // Redémarrer chaque conteneur
    for (const container of appContainers) {
      try {
        const containerObj = docker.getContainer(container.Id);
        if (container.State === 'running') {
          await containerObj.restart();
        } else {
          await containerObj.start();
        }
        restartedCount++;
      } catch (err) {
        console.error(`Erreur lors du redémarrage du conteneur ${container.Names[0]}:`, err);
        failedCount++;
      }
    }
    
    return {
      success: failedCount === 0,
      message: `${restartedCount} conteneur(s) redémarré(s), ${failedCount} échec(s)`,
      appId
    };
  } catch (error) {
    console.error(`Erreur lors du redémarrage de l'application ${appId}:`, error);
    throw error;
  }
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

// Fonction pour récupérer les informations du serveur
async function getServerInfo() {
  // 1) Mémoire
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const ramUsagePercentage = (((totalRam - freeRam) / totalRam) * 100).toFixed(1);

  // 2) Disques
  const diskLayout = await si.diskLayout();
  const fsSizes = await si.fsSize();

  // 3) Compose la réponse disque par disque (sans 'type')
  const disks = diskLayout.map(d => {
    const totalBytes = d.size;
    const parts = fsSizes.filter(f =>
      f.fs && f.fs.startsWith(d.device)
    );
    const mounted = parts.length > 0;
    const usedBytes = parts.reduce((sum, p) => sum + p.used, 0);
    const freeBytes = totalBytes - usedBytes;

    return {
      device: d.device,                         // ex: '/dev/sda'
      size: `${(totalBytes / 1e9).toFixed(1)} GB`,
      used: `${(usedBytes / 1e9).toFixed(1)} GB`,
      free: `${(freeBytes / 1e9).toFixed(1)} GB`,
      mounted: mounted
    };
  });

  // 4) Totaux globaux (uniquement pour les disques montés)
  const mountedDisks = disks.filter(d => d.mounted);
  const totalSize = mountedDisks.reduce((sum, d) => sum + parseFloat(d.size), 0);
  const totalUsed = mountedDisks.reduce((sum, d) => sum + parseFloat(d.used), 0);
  const totalFree = mountedDisks.reduce((sum, d) => sum + parseFloat(d.free), 0);
  
  // 5) CPU
  const cpuUsagePercentage = await new Promise(resolve => {
    osutils.cpuUsage(u => resolve((u * 100).toFixed(1)));
  });
  
  return {
    stockage: {
      utilise: `${totalUsed.toFixed(1)} GB`,
      total: `${totalSize.toFixed(1)} GB`,
    },
    performance: {
      cpu: `${cpuUsagePercentage}%`,
      ram: `${ramUsagePercentage}%`,
    },
  };
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

// LDAP Configuration
const ldapConfig = {
  url: process.env.LDAP_URL,
  bindDN: process.env.LDAP_BIND_DN,
  bindPassword: process.env.LDAP_BIND_PASSWORD,
  userSearchBase: process.env.LDAP_USER_SEARCH_BASE,
  groupSearchBase: process.env.LDAP_GROUP_SEARCH_BASE,
  userFilter: process.env.LDAP_USER_FILTER,
  groupFilter: process.env.LDAP_GROUP_FILTER,
  adminGroup: process.env.LDAP_ADMIN_GROUP,
  userGroup: process.env.LDAP_USER_GROUP,
  guestGroup: process.env.LDAP_GUEST_GROUP,
};

// Échapper les valeurs insérées dans les filtres LDAP (RFC 4515)
function escapeLdapFilterValue(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

// Fonction pour déterminer le rôle
function getRole(dn, groupMemberships) {
  if (groupMemberships.includes(ldapConfig.adminGroup)) return 'Admin';
  if (groupMemberships.includes(ldapConfig.userGroup)) return 'User';
  if (groupMemberships.includes(ldapConfig.guestGroup)) return 'Guest';
  return 'Unknown';
}

// Endpoint : Récupérer les utilisateurs LDAP
app.get('/api/users', verifyToken, async (req, res) => {
  const ldapClient = ldap.createClient({ url: ldapConfig.url });

  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Échec de la connexion LDAP :', err);
      res.status(500).json({ error: 'Échec de la connexion LDAP' });
      return;
    }

    const ldapUsers = [];
    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter: ldapConfig.userFilter, scope: 'sub', attributes: ['cn', 'uid', 'mail', 'dn'] },
      (err, ldapRes) => {
        if (err) {
          console.error('Erreur de recherche LDAP :', err);
          res.status(500).json({ error: 'Erreur de recherche LDAP' });
          return;
        }

        ldapRes.on('searchEntry', (entry) => {
          try {
            const cn = entry.pojo.attributes.find(attr => attr.type === 'cn')?.values[0] || 'Nom inconnu';
            const uid = entry.pojo.attributes.find(attr => attr.type === 'uid')?.values[0] || 'UID inconnu';
            const mail = entry.pojo.attributes.find(attr => attr.type === 'mail')?.values[0] || 'Email inconnu';
            const dn = entry.pojo.objectName;

            // Exclure l'utilisateur `read-only`
            if (uid !== 'read-only') {
              ldapUsers.push({ dn, name: cn, uid, email: mail });
            }
          } catch (err) {
            console.error('Erreur lors du traitement de l\'entrée LDAP :', err);
          }
        });

        ldapRes.on('end', () => {
          console.log('Recherche utilisateur terminée. Vérification des rôles...');
          const roles = {};

          ldapClient.search(
            ldapConfig.groupSearchBase,
            { filter: ldapConfig.groupFilter, scope: 'sub', attributes: ['cn', 'member'] },
            (err, groupRes) => {
              if (err) {
                console.error('Erreur lors de la recherche des groupes LDAP :', err);
                res.status(500).json({ error: 'Erreur lors de la recherche des groupes LDAP' });
                return;
              }

              groupRes.on('searchEntry', (groupEntry) => {
                const groupName = groupEntry.pojo.attributes.find(attr => attr.type === 'cn')?.values[0];
                const members = groupEntry.pojo.attributes.find(attr => attr.type === 'member')?.values || [];

                members.forEach((member) => {
                  if (!roles[member]) roles[member] = [];
                  roles[member].push(groupEntry.pojo.objectName);
                });
              });

              groupRes.on('end', () => {
                console.log('Recherche des groupes terminée.');

                const usersWithRoles = ldapUsers.map(user => ({
                  ...user,
                  role: getRole(user.dn, roles[user.dn] || []),
                }));

                console.log('Utilisateurs avec rôles :', usersWithRoles);
                res.json(usersWithRoles);
                ldapClient.unbind();
              });
            }
          );
        });
      }
    );
  });
});

// Brute force protection function
async function checkBruteForce(uid, ip) {
  try {
    const redis = await ensureConnected();
    const key = `bruteforce:${uid}:${ip}`;
    const attempts = await redis.get(key);
    
    if (attempts && parseInt(attempts) >= 5) {
      const ttl = await redis.ttl(key);
      return { blocked: true, retryAfter: ttl };
    }
    
    return { blocked: false };
  } catch (e) {
    console.warn('[bruteforce] Redis unavailable, skipping check');
    return { blocked: false };
  }
}

async function recordFailedAttempt(uid, ip) {
  try {
    const redis = await ensureConnected();
    const key = `bruteforce:${uid}:${ip}`;
    const current = await redis.get(key);
    const attempts = current ? parseInt(current) + 1 : 1;
    
    await redis.set(key, attempts, { EX: 15 * 60 }); // 15 minutes
    return attempts;
  } catch (e) {
    console.warn('[bruteforce] Redis unavailable, cannot record attempt');
    return 0;
  }
}

async function clearFailedAttempts(uid, ip) {
  try {
    const redis = await ensureConnected();
    const key = `bruteforce:${uid}:${ip}`;
    await redis.del(key);
  } catch (e) {
    console.warn('[bruteforce] Redis unavailable, cannot clear attempts');
  }
}

// Endpoint : Authentification utilisateur LDAP
app.post('/api/authenticate', authLimiter, async (req, res) => {
  const { uid: rawUid, password: rawPassword } = req.body;
  const uid = (rawUid || '').trim();
  const password = (rawPassword || '').trim();

  if (!uid || !password) {
    return res.status(400).json({ error: 'UID et mot de passe requis' });
  }

  // Check brute force protection
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const bruteForceCheck = await checkBruteForce(uid, clientIP);
  
  if (bruteForceCheck.blocked) {
    console.warn(`[security] Brute force protection: blocking ${uid} from ${clientIP}`);
    return res.status(429).json({ 
      error: 'Trop de tentatives échouées. Réessayez plus tard.',
      retryAfter: bruteForceCheck.retryAfter
    });
  }

  const ldapClient = ldap.createClient({ 
    url: ldapConfig.url,
    timeout: 5000,
    connectTimeout: 5000
  });

  console.log(`Tentative d'authentification pour l'utilisateur: ${uid}`);
  
  // Première connexion pour rechercher le DN utilisateur
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur de connexion LDAP initiale:', err);
      return res.status(500).json({ error: 'Échec de connexion LDAP initiale' });
    }

    // Rechercher l'utilisateur par uid d'abord (recommandé). Retomber sur cn si rien trouvé.
    const escaped = escapeLdapFilterValue(uid);
    const primaryFilter = `(uid=${escaped})`;
    const fallbackFilter = `(cn=${escaped})`;
    const userFilter = `(|${primaryFilter}${fallbackFilter})`;
    const searchFilter = `(&${primaryFilter}${ldapConfig.userFilter})`;
    
    console.log('Recherche utilisateur avec filtre:', searchFilter);

    ldapClient.search(ldapConfig.userSearchBase, {
      filter: searchFilter,
      scope: 'sub',
      attributes: ['dn', 'cn', 'mail', 'uid'],
    }, (err, ldapRes) => {
      if (err) {
        console.error('Erreur de recherche utilisateur LDAP:', err);
        return res.status(500).json({ error: 'Erreur de recherche utilisateur' });
      }

      let userEntry;
      let fallbackTried = false;

      ldapRes.on('searchEntry', (entry) => {
        userEntry = entry;
        console.log('Entrée LDAP trouvée:', entry.pojo.objectName);
      });

      ldapRes.on('error', (err) => {
        console.error('Erreur lors de la recherche LDAP:', err);
      });

      ldapRes.on('end', () => {
        if (!userEntry) {
          // Retenter avec le filtre incluant cn si uid exact introuvable
          if (!fallbackTried) {
            fallbackTried = true;
            const altSearch = `(&${userFilter}${ldapConfig.userFilter})`;
            console.log('Aucun uid exact trouvé. Nouvelle recherche avec filtre:', altSearch);
            return ldapClient.search(ldapConfig.userSearchBase, {
              filter: altSearch,
              scope: 'sub',
              attributes: ['dn', 'cn', 'mail', 'uid'],
            }, (err2, altRes) => {
              if (err2) {
                console.error('Erreur de recherche LDAP (fallback):', err2);
                ldapClient.unbind();
                return res.status(500).json({ error: 'Erreur de recherche utilisateur' });
              }
              altRes.on('searchEntry', (entry) => {
                // Choisir prioritairement l'entrée dont l'uid correspond exactement (insensible à la casse)
                const attrs = {};
                entry.pojo.attributes.forEach(a => attrs[a.type] = a.values[0]);
                if (!userEntry && attrs.uid && String(attrs.uid).toLowerCase() === uid.toLowerCase()) {
                  userEntry = entry;
                } else if (!userEntry) {
                  userEntry = entry; // au moins une entrée
                }
              });
              altRes.on('end', () => {
                if (!userEntry) {
                  console.error(`Utilisateur ${uid} non trouvé dans LDAP (après fallback)`);
                  ldapClient.unbind();
                  return res.status(401).json({ error: 'Utilisateur non trouvé' });
                }
                // Continuer le flux normal avec userEntry défini
                proceedWithUserEntry(userEntry);
              });
            });
          }
          console.error(`Utilisateur ${uid} non trouvé dans LDAP`);
          ldapClient.unbind();
          return res.status(401).json({ error: 'Utilisateur non trouvé' });
        }
        proceedWithUserEntry(userEntry);
      });

      function proceedWithUserEntry(userEntry) {
        const userDN = userEntry.pojo.objectName;
        console.log(`DN utilisateur trouvé: ${userDN}`);

        // Tente de connecter l'utilisateur avec son propre DN et mot de passe
        const userAuthClient = ldap.createClient({ 
          url: ldapConfig.url,
          timeout: 5000,
          connectTimeout: 5000
        });
        
        userAuthClient.bind(userDN, password, async (err) => {
          if (err) {
            console.error('Échec de l\'authentification utilisateur:', err);
            ldapClient.unbind();
            userAuthClient.destroy();
            
            // Record failed attempt for brute force protection
            const attempts = await recordFailedAttempt(uid, clientIP);
            console.warn(`[security] Failed login attempt ${attempts} for ${uid} from ${clientIP}`);
            
            return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
          }

          // Authentification réussie - clear failed attempts
          console.log(`Authentification réussie pour ${uid}`);
          await clearFailedAttempts(uid, clientIP);
          userAuthClient.unbind();
          
          // Rechercher l'appartenance aux groupes
          let role = 'Guest'; // Rôle par défaut
          
          // Vérifier si l'utilisateur est membre du groupe Admin
          ldapClient.search(ldapConfig.adminGroup, {
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: ['member']
          }, (err, groupRes) => {
            if (err) {
              console.error('Erreur lors de la recherche du groupe admin:', err);
              // Continuer avec le rôle par défaut
              completeAuthentication();
              return;
            }
            
            let isAdmin = false;
            
            groupRes.on('searchEntry', (entry) => {
              const members = entry.pojo.attributes.find(attr => attr.type === 'member')?.values || [];
              if (members.includes(userDN)) {
                isAdmin = true;
                role = 'Admin';
                console.log(`L'utilisateur ${uid} est membre du groupe admin`);
              }
            });
            
            groupRes.on('end', () => {
              if (!isAdmin) {
                // Si pas admin, vérifier si membre du groupe User
                ldapClient.search(ldapConfig.userGroup, {
                  scope: 'base',
                  filter: '(objectClass=*)',
                  attributes: ['member']
                }, (err, userGroupRes) => {
                  if (err) {
                    console.error('Erreur lors de la recherche du groupe user:', err);
                    // Continuer avec le rôle par défaut
                    completeAuthentication();
                    return;
                  }
                  
                  userGroupRes.on('searchEntry', (entry) => {
                    const members = entry.pojo.attributes.find(attr => attr.type === 'member')?.values || [];
                    if (members.includes(userDN)) {
                      role = 'User';
                      console.log(`L'utilisateur ${uid} est membre du groupe user`);
                    }
                  });
                  
                  userGroupRes.on('end', () => {
                    completeAuthentication();
                  });
                });
              } else {
                completeAuthentication();
              }
            });
          });
          
          // Fonction pour finaliser l'authentification avec le rôle déterminé
          function completeAuthentication() {
            ldapClient.unbind();
            
            const userAttrs = {};
            userEntry.pojo.attributes.forEach(attr => {
              userAttrs[attr.type] = attr.values[0];
            });
            
            const user = {
              uid: userAttrs.uid || userAttrs.cn || uid,
              name: userAttrs.cn || uid,
              email: userAttrs.mail || `${uid}@${process.env.DEFAULT_EMAIL_DOMAIN || 'localhost'}`,
              role: role
            };
            
            console.log(`Authentification complétée pour ${uid} avec le rôle ${role}`);

            // Générer un token JWT (durée configurable)
            const token = jwt.sign(
              user,
              JWT_SECRET,
              { expiresIn: `${JWT_EXPIRES_MINUTES}m` }
            );

            // Enregistrer le token dans Redis (allowlist) avec TTL configurable
            (async () => {
              try {
                const redis = await ensureConnected();
                const key = `access:token:${token}`;
                // Stocker un minimum d'infos utiles
                await redis.set(key, JSON.stringify({ uid: user.uid, role: user.role }), { EX: JWT_EXPIRES_SECONDS });
              } catch (e) {
                console.warn('[login] Impossible d\'enregistrer le token dans Redis:', e?.message || e);
              } finally {
                res.json({ 
                  message: 'Authentification réussie', 
                  user: user,
                  token: token,
                  expiresIn: JWT_EXPIRES_SECONDS // en secondes
                });
              }
            })();
          }
        }); // fin userAuthClient.bind
      } // fin proceedWithUserEntry
    }); // fin ldapClient.search
  }); // fin ldapClient.bind
}); // fin route /api/authenticate

app.post('/api/add-user', async (req, res) => {
  const { adminUid, adminPassword, newUser } = req.body;

  if (!adminUid || !adminPassword || !newUser || !newUser.role) {
    return res.status(400).json({ error: 'Champs requis manquants (adminUid, adminPassword, newUser, role)' });
  }

  const ldapClient = ldap.createClient({ url: ldapConfig.url });

  // Étape 1 : Connexion initiale en read-only
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur connexion LDAP initiale :', err);
      return res.status(500).json({ error: 'Erreur de connexion LDAP initiale' });
    }

    // Étape 2 : Chercher DN de l’admin
    const adminFilter = `(&(uid=${adminUid})${ldapConfig.userFilter})`;
    ldapClient.search(ldapConfig.userSearchBase, {
      filter: adminFilter,
      scope: 'sub',
      attributes: ['dn'],
    }, (err, ldapRes) => {
      if (err) {
        console.error('Erreur recherche admin LDAP :', err);
        return res.status(500).json({ error: 'Erreur recherche admin LDAP' });
      }

      let adminEntry;
      ldapRes.on('searchEntry', entry => adminEntry = entry);

      ldapRes.on('end', () => {
        if (!adminEntry) {
          ldapClient.unbind();
          return res.status(401).json({ error: 'Admin non trouvé' });
        }

        const adminDN = adminEntry.pojo.objectName;
        const adminAuthClient = ldap.createClient({ url: ldapConfig.url });

        // Étape 3 : Authentifier l’admin
        adminAuthClient.bind(adminDN, adminPassword, (err) => {
          if (err) {
            console.error('Échec authentification admin:', err);
            ldapClient.unbind();
            return res.status(401).json({ error: 'Authentification Admin échouée' });
          }

          // Étape 4 : Vérifier si l’admin est bien dans le groupe admins
          ldapClient.search(ldapConfig.adminGroup, {
            filter: `(member=${adminDN})`,
            scope: 'base',
            attributes: ['cn'],
          }, (err, groupRes) => {
            let isAdmin = false;
            groupRes.on('searchEntry', () => isAdmin = true);

            groupRes.on('end', () => {
              if (!isAdmin) {
                ldapClient.unbind();
                adminAuthClient.unbind();
                return res.status(403).json({ error: 'Droits admin requis' });
              }

              // Étape 5 : Vérifier UID ou email déjà utilisé
              const checkFilter = `(|(uid=${newUser.uid})(mail=${newUser.mail}))`;
              ldapClient.search(ldapConfig.userSearchBase, {
                filter: checkFilter,
                scope: 'sub',
                attributes: ['uid', 'mail'],
              }, (err, checkRes) => {
                if (err) {
                  console.error('Erreur vérification UID/email existants :', err);
                  return res.status(500).json({ error: 'Erreur lors de la vérification de l’utilisateur' });
                }

                let conflict = null;
                checkRes.on('searchEntry', (entry) => {
                  const entryUid = entry.pojo.attributes.find(attr => attr.type === 'uid')?.values[0];
                  const entryMail = entry.pojo.attributes.find(attr => attr.type === 'mail')?.values[0];
                  if (entryUid === newUser.uid) conflict = 'UID';
                  else if (entryMail === newUser.mail) conflict = 'email';
                });

                checkRes.on('end', () => {
                  if (conflict) {
                    ldapClient.unbind();
                    adminAuthClient.unbind();
                    return res.status(409).json({ error: `Un utilisateur avec ce ${conflict} existe déjà.` });
                  }

                  // Étape 6 : Créer l'utilisateur
                  const newUserDN = `uid=${newUser.uid},${ldapConfig.userSearchBase}`;
                  const entry = {
                    cn: newUser.cn,
                    sn: newUser.sn,
                    uid: newUser.uid,
                    mail: newUser.mail,
                    objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
                    userPassword: newUser.password,
                  };

                  adminAuthClient.add(newUserDN, entry, (err) => {
                    if (err) {
                      console.error('Erreur ajout utilisateur LDAP :', err);
                      ldapClient.unbind();
                      adminAuthClient.unbind();
                      return res.status(500).json({ error: 'Erreur ajout utilisateur LDAP' });
                    }

                    // Étape 7 : Ajouter dans le bon groupe
                    const roleGroup = {
                      Admin: ldapConfig.adminGroup,
                      User: ldapConfig.userGroup,
                      Guest: ldapConfig.guestGroup,
                    }[newUser.role];

                    if (!roleGroup) {
                      return res.status(400).json({ error: `Rôle inconnu : ${newUser.role}` });
                    }

                    const groupClient = ldap.createClient({ url: ldapConfig.url });
                    groupClient.bind(adminDN, adminPassword, (err) => {
                      if (err) {
                        console.error('Échec bind admin pour ajout au groupe');
                        return res.status(500).json({ error: 'Impossible d’ajouter au groupe' });
                      }

                      const change = new ldap.Change({
                        operation: 'add',
                        modification: new ldap.Attribute({
                          type: 'member',
                          values: [newUserDN],
                        }),
                      });

                      groupClient.modify(roleGroup, change, (err) => {
                        ldapClient.unbind();
                        adminAuthClient.unbind();
                        groupClient.unbind();

                        if (err && err.name !== 'AttributeOrValueExistsError') {
                          console.error('Erreur ajout au groupe :', err);
                          return res.status(500).json({ error: 'Utilisateur créé, mais échec d’ajout au groupe' });
                        }

                        // Trigger LDAP sync after successful user creation
                        triggerLdapSync()
                          .then(syncResult => {
                            console.log('LDAP sync after user creation:', syncResult);
                          })
                          .catch(e => {
                            console.error('Error during LDAP sync after user creation:', e);
                          })
                          .finally(() => {
                            return res.json({
                              message: `Utilisateur "${newUser.uid}" ajouté avec succès en tant que ${newUser.role}`,
                              user: {
                                cn: newUser.cn,
                                sn: newUser.sn,
                                uid: newUser.uid,
                                mail: newUser.mail,
                                role: newUser.role,
                              }
                            });
                          });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// Endpoint to update an existing user
app.put('/api/update-user', async (req, res) => {
  const { adminUid, adminPassword, targetUid, name, email, role, password } = req.body;

  if (!adminUid || !adminPassword || !targetUid || !name || !email || !role) {
    return res.status(400).json({ error: 'Tous les champs sont requis (adminUid, adminPassword, targetUid, name, email, role)' });
  }

  // Enforce UID immutability: reject any attempt to change UID
  if (typeof req.body.uid !== 'undefined' && req.body.uid !== targetUid) {
    return res.status(400).json({ error: "Changement d'UID interdit" });
  }
  if (typeof req.body.newUid !== 'undefined' && req.body.newUid !== targetUid) {
    return res.status(400).json({ error: "Changement d'UID interdit" });
  }

  const ldapClient = ldap.createClient({ url: ldapConfig.url });
  let adminAuthClient;

  // Step 1: Bind as admin user to verify permissions
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur de connexion LDAP initiale :', err);
      return res.status(500).json({ error: 'Erreur de connexion LDAP initiale' });
    }

    // Step 2: Find admin user
    const adminFilter = `(&(uid=${adminUid})${ldapConfig.userFilter})`;
    ldapClient.search(ldapConfig.userSearchBase, {
      filter: adminFilter,
      scope: 'sub',
      attributes: ['dn'],
    }, (err, ldapRes) => {
      if (err) {
        console.error('Erreur recherche admin :', err);
        return res.status(500).json({ error: 'Erreur recherche admin' });
      }

      let adminEntry;
      ldapRes.on('searchEntry', entry => adminEntry = entry);

      ldapRes.on('end', () => {
        if (!adminEntry) {
          ldapClient.unbind();
          return res.status(401).json({ error: 'Admin non trouvé' });
        }

        const adminDN = adminEntry.pojo.objectName;
        adminAuthClient = ldap.createClient({ url: ldapConfig.url });

        // Step 3: Verify admin credentials and permissions
        adminAuthClient.bind(adminDN, adminPassword, (err) => {
          if (err) {
            console.error('Échec authentification admin :', err);
            ldapClient.unbind();
            return res.status(401).json({ error: 'Mot de passe admin incorrect' });
          }

          // Step 4: Check if admin is in admin group
          ldapClient.search(ldapConfig.adminGroup, {
            filter: `(member=${adminDN})`,
            scope: 'base',
            attributes: ['cn'],
          }, (err, groupRes) => {
            let isAdmin = false;
            groupRes.on('searchEntry', () => isAdmin = true);

            groupRes.on('end', () => {
              if (!isAdmin) {
                ldapClient.unbind();
                adminAuthClient.unbind();
                return res.status(403).json({ error: 'Accès refusé. Droits admin requis.' });
              }

              // Step 5: Find the target user to update
              ldapClient.search(ldapConfig.userSearchBase, {
                filter: `(uid=${targetUid})`,
                scope: 'sub',
                attributes: ['dn', 'uid', 'mail', 'cn', 'sn'],
              }, (err, userRes) => {
                if (err) {
                  console.error('Erreur recherche utilisateur :', err);
                  return res.status(500).json({ error: 'Erreur recherche utilisateur' });
                }

                let userEntry;
                userRes.on('searchEntry', entry => userEntry = entry);

                userRes.on('end', () => {
                  if (!userEntry) {
                    ldapClient.unbind();
                    adminAuthClient.unbind();
                    return res.status(404).json({ error: 'Utilisateur non trouvé' });
                  }

                  let userDN = userEntry.pojo.objectName;
                  const currentMail = userEntry.pojo.attributes.find(attr => attr.type === 'mail')?.values[0];
                  const currentCn = userEntry.pojo.attributes.find(attr => attr.type === 'cn')?.values[0];
                  const currentSn = userEntry.pojo.attributes.find(attr => attr.type === 'sn')?.values[0];

                  // Step 6: Check if new email is already in use by another user
                  if (email !== currentMail) {
                    ldapClient.search(ldapConfig.userSearchBase, {
                      filter: `(&(mail=${email})(!(uid=${targetUid})))`,
                      scope: 'sub',
                      attributes: ['uid'],
                    }, (err, emailCheckRes) => {
                      if (err) {
                        console.error('Erreur vérification email :', err);
                        return res.status(500).json({ error: 'Erreur vérification email' });
                      }

                      let emailInUse = false;
                      emailCheckRes.on('searchEntry', () => emailInUse = true);

                      emailCheckRes.on('end', () => {
                        if (emailInUse) {
                          ldapClient.unbind();
                          adminAuthClient.unbind();
                          return res.status(409).json({ error: 'Un utilisateur avec cet email existe déjà' });
                        }
                        
                        // If email is available, proceed with update
                        updateUser();
                      });
                    });
                  } else {
                    // If email hasn't changed, proceed with update
                    updateUser();
                  }

                  // Function to update user attributes and handle possible RDN rename when DN uses cn=
                  function updateUser() {
                    // Detect RDN attribute and parent DN
                    const firstCommaIdx = userDN.indexOf(',');
                    const rdn = firstCommaIdx > 0 ? userDN.substring(0, firstCommaIdx) : userDN;
                    const parentDN = firstCommaIdx > 0 ? userDN.substring(firstCommaIdx + 1) : '';
                    const eqIdx = rdn.indexOf('=');
                    const rdnAttr = eqIdx > 0 ? rdn.substring(0, eqIdx).toLowerCase() : '';

                    // Helper to escape DN RDN value (basic RFC 2253 escaping for special chars)
                    const escapeRdnValue = (val) => {
                      if (typeof val !== 'string') return val;
                      let v = val.replace(/\\/g, '\\\\')
                                 .replace(/,/g, '\\,')
                                 .replace(/\+/g, '\\+')
                                 .replace(/"/g, '\\"')
                                 .replace(/</g, '\\<')
                                 .replace(/>/g, '\\>')
                                 .replace(/;/g, '\\;')
                                 .replace(/=/g, '\\=');
                      if (v.startsWith(' ')) v = '\\ ' + v.slice(1);
                      if (v.endsWith(' ')) v = v.slice(0, -1) + '\\ ';
                      return v;
                    };

                    // Build attribute changes (we may skip cn replace if we're going to rename)
                    const changes = [];

                    const isCnRdn = rdnAttr === 'cn';
                    const nameChanged = name !== currentCn;

                    if (nameChanged && !isCnRdn) {
                      changes.push(new ldap.Change({
                        operation: 'replace',
                        modification: new ldap.Attribute({ type: 'cn', values: [name] })
                      }));
                    }

                    // Always update sn when name changes (last word heuristic)
                    if (nameChanged) {
                      const lastName = name.split(' ').pop() || name;
                      changes.push(new ldap.Change({
                        operation: 'replace',
                        modification: new ldap.Attribute({ type: 'sn', values: [lastName] })
                      }));
                    }

                    if (email !== currentMail) {
                      changes.push(new ldap.Change({
                        operation: 'replace',
                        modification: new ldap.Attribute({ type: 'mail', values: [email] })
                      }));
                    }

                    if (password) {
                      changes.push(new ldap.Change({
                        operation: 'replace',
                        modification: new ldap.Attribute({ type: 'userPassword', values: [password] })
                      }));
                    }

                    const applyChangesSequentially = () => {
                      const updateNextChange = (index) => {
                        if (index >= changes.length) {
                          // All changes applied, now update group membership
                          updateGroupMembership();
                          return;
                        }
                        adminAuthClient.modify(userDN, changes[index], (err) => {
                          if (err) {
                            console.error('Erreur mise à jour utilisateur :', err);
                            ldapClient.unbind();
                            adminAuthClient.unbind();
                            return res.status(500).json({ error: 'Erreur lors de la mise à jour du profil utilisateur' });
                          }
                          updateNextChange(index + 1);
                        });
                      };
                      updateNextChange(0);
                    };

                    // If DN uses cn= and name changed, perform a modifyDN (rename) first to avoid NamingViolation
                    if (isCnRdn && nameChanged) {
                      const newRdn = `cn=${escapeRdnValue(name)}`;
                      adminAuthClient.modifyDN(userDN, newRdn, (err) => {
                        if (err) {
                          console.error('Erreur renommage DN (modifyDN) :', err);
                          ldapClient.unbind();
                          adminAuthClient.unbind();
                          return res.status(500).json({ error: "Erreur de renommage de l'entrée (RDN) lors de la mise à jour du nom" });
                        }
                        // Update local DN to the new value for subsequent modifications and group updates
                        userDN = `${newRdn}${parentDN ? ',' + parentDN : ''}`;
                        applyChangesSequentially();
                      });
                    } else {
                      // No rename needed; apply changes directly
                      applyChangesSequentially();
                    }
                  }
                  
                  // Function to update group membership based on role
                  function updateGroupMembership() {
                    const roleGroupMap = {
                      'Admin': ldapConfig.adminGroup,
                      'User': ldapConfig.userGroup,
                      'Guest': ldapConfig.guestGroup
                    };
                    
                    const targetGroup = roleGroupMap[role];
                    if (!targetGroup) {
                      ldapClient.unbind();
                      adminAuthClient.unbind();
                      return res.status(400).json({ error: 'Rôle invalide' });
                    }
                    
                    // First, remove from all role groups
                    const removeFromGroup = (groupDn, callback) => {
                      if (!groupDn) return callback();
                      
                      const change = new ldap.Change({
                        operation: 'delete',
                        modification: new ldap.Attribute({
                          type: 'member',
                          values: [userDN]
                        })
                      });
                      
                      adminAuthClient.modify(groupDn, change, (err) => {
                        // Ignore errors if user wasn't in the group
                        callback();
                      });
                    };
                    
                    // Remove from all groups first
                    const groupsToRemove = Object.values(roleGroupMap).filter(group => group !== targetGroup);
                    const removeNextGroup = (index) => {
                      if (index >= groupsToRemove.length) {
                        // Now add to the target group
                        addToGroup(targetGroup);
                        return;
                      }
                      
                      removeFromGroup(groupsToRemove[index], () => {
                        removeNextGroup(index + 1);
                      });
                    };
                    
                    removeNextGroup(0);
                    
                    // Function to add user to target group
                    function addToGroup(groupDn) {
                      const change = new ldap.Change({
                        operation: 'add',
                        modification: new ldap.Attribute({
                          type: 'member',
                          values: [userDN]
                        })
                      });
                      
                      adminAuthClient.modify(groupDn, change, (err) => {
                        ldapClient.unbind();
                        adminAuthClient.unbind();
                        
                        if (err && err.name !== 'AttributeOrValueExistsError') {
                          console.error('Erreur mise à jour groupe :', err);
                          return res.status(500).json({ 
                            error: 'Profil mis à jour, mais erreur de mise à jour du groupe',
                            details: err.message
                          });
                        }
                        
                        // Trigger LDAP sync after successful user update
                        triggerLdapSync()
                          .then(syncResult => {
                            console.log('LDAP sync after user update:', syncResult);
                          })
                          .catch(e => {
                            console.error('Error during LDAP sync after user update:', e);
                          })
                          .finally(() => {
                            res.json({
                              message: `Utilisateur "${targetUid}" mis à jour avec succès`,
                              user: {
                                name: name,
                                email: email,
                                role: role,
                                uid: targetUid
                              }
                            });
                          });
                      });
                    }
                  }
                });
              });
            });
          });
        });
      });
    });
  });
});

// Endpoint for Repcures to synchronize users with LDAP
app.get('/api/admin/users/sync-ldap', async (req, res) => {
  const ldapClient = ldap.createClient({ url: ldapConfig.url });
  let users = [];

  // Step 1: Bind to LDAP with admin credentials
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur de connexion LDAP :', err);
      return res.status(500).json({ error: 'Erreur de connexion LDAP' });
    }

    // Step 2: Search for all users
    ldapClient.search(ldapConfig.userSearchBase, {
      filter: ldapConfig.userFilter,
      scope: 'sub',
      attributes: ['uid', 'cn', 'sn', 'mail', 'memberOf']
    }, (err, searchRes) => {
      if (err) {
        console.error('Erreur de recherche LDAP :', err);
        ldapClient.unbind();
        return res.status(500).json({ error: 'Erreur de recherche LDAP' });
      }

      searchRes.on('searchEntry', (entry) => {
        const user = entry.pojo.attributes.reduce((acc, attr) => {
          // Convert single values to string, arrays remain as arrays
          acc[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
          return acc;
        }, {});
        
        // Add DN to the user object
        user.dn = entry.pojo.objectName;
        
        // Determine user role based on group memberships
        const groupMemberships = user.memberOf || [];
        user.role = getRole(user.dn, groupMemberships);
        
        users.push(user);
      });

      searchRes.on('error', (err) => {
        console.error('Erreur lors de la récupération des utilisateurs :', err);
        ldapClient.unbind();
        return res.status(500).json({ error: 'Erreur lors de la récupération des utilisateurs' });
      });

      searchRes.on('end', () => {
        ldapClient.unbind();
        
        // Return success status code (200) with user count
        console.log(`Synchronisation LDAP réussie. ${users.length} utilisateurs synchronisés.`);
        return res.status(200).send(`${users.length}`);
      });
    });
  });
});

app.post('/api/delete-user', async (req, res) => {
  const { adminUid, adminPassword, uid } = req.body;

  if (!adminUid || !adminPassword || !uid) {
    return res.status(400).json({ error: 'adminUid, adminPassword et uid requis' });
  }

  // Empêcher la suppression de soi-même (même pour un admin)
  if (String(adminUid).trim().toLowerCase() === String(uid).trim().toLowerCase()) {
    return res.status(403).json({ error: "Vous ne pouvez pas supprimer votre propre compte" });
  }

  const ldapClient = ldap.createClient({ url: ldapConfig.url });

  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur bind initial LDAP :', err);
      return res.status(500).json({ error: 'Connexion LDAP échouée' });
    }

    const adminFilter = `(&(uid=${adminUid})${ldapConfig.userFilter})`;

    ldapClient.search(ldapConfig.userSearchBase, {
      filter: adminFilter,
      scope: 'sub',
      attributes: ['dn'],
    }, (err, ldapRes) => {
      if (err) {
        console.error('Erreur recherche admin :', err);
        return res.status(500).json({ error: 'Erreur recherche admin' });
      }

      let adminEntry;
      ldapRes.on('searchEntry', entry => adminEntry = entry);

      ldapRes.on('end', () => {
        if (!adminEntry) {
          ldapClient.unbind();
          return res.status(401).json({ error: 'Admin non trouvé' });
        }

        const adminDN = adminEntry.pojo.objectName;
        const adminAuthClient = ldap.createClient({ url: ldapConfig.url });

        adminAuthClient.bind(adminDN, adminPassword, (err) => {
          if (err) {
            console.error('Échec authentification admin :', err);
            ldapClient.unbind();
            return res.status(401).json({ error: 'Mot de passe admin incorrect' });
          }

          // Vérifie si l'admin est bien dans le groupe "admins"
          ldapClient.search(ldapConfig.adminGroup, {
            filter: `(member=${adminDN})`,
            scope: 'base',
            attributes: ['cn'],
          }, (err, groupRes) => {
            let isAdmin = false;
            groupRes.on('searchEntry', () => isAdmin = true);

            groupRes.on('end', () => {
              if (!isAdmin) {
                ldapClient.unbind();
                adminAuthClient.unbind();
                return res.status(403).json({ error: 'Accès refusé. Droits admin requis.' });
              }

              // Trouver l'utilisateur à supprimer
              ldapClient.search(ldapConfig.userSearchBase, {
                filter: `(uid=${uid})`,
                scope: 'sub',
                attributes: ['dn'],
              }, (err, userRes) => {
                if (err) {
                  console.error('Erreur recherche utilisateur à supprimer :', err);
                  return res.status(500).json({ error: 'Erreur recherche utilisateur' });
                }

                let userEntry;
                userRes.on('searchEntry', entry => userEntry = entry);

                userRes.on('end', () => {
                  if (!userEntry) {
                    ldapClient.unbind();
                    adminAuthClient.unbind();
                    return res.status(404).json({ error: 'Utilisateur non trouvé' });
                  }

                  const userDN = userEntry.pojo.objectName;

                  // Étape 1 : Supprimer des groupes
                  const removeFromGroups = [ldapConfig.adminGroup, ldapConfig.userGroup, ldapConfig.guestGroup];

                  const groupClient = ldap.createClient({ url: ldapConfig.url });
                  groupClient.bind(adminDN, adminPassword, (err) => {
                    if (err) {
                      console.error('Erreur bind pour nettoyage groupes');
                      return res.status(500).json({ error: 'Erreur de nettoyage groupes' });
                    }

                    let tasksDone = 0;
                    removeFromGroups.forEach(groupDN => {
                      const change = new ldap.Change({
                        operation: 'delete',
                        modification: new ldap.Attribute({
                          type: 'member',
                          values: [userDN],
                        }),
                      });

                      groupClient.modify(groupDN, change, (err) => {
                        // Silencieusement ignore si l'utilisateur n'était pas dans le groupe
                        tasksDone++;
                        if (tasksDone === removeFromGroups.length) {
                          // Étape 2 : Supprimer l'utilisateur
                          adminAuthClient.del(userDN, (err) => {
                            ldapClient.unbind();
                            adminAuthClient.unbind();
                            groupClient.unbind();

                            if (err) {
                              console.error('Erreur suppression utilisateur :', err);
                              return res.status(500).json({ error: 'Erreur suppression utilisateur' });
                            }

                            // Trigger LDAP sync after successful user deletion
                            triggerLdapSync()
                              .then(syncResult => {
                                console.log('LDAP sync after user deletion:', syncResult);
                              })
                              .catch(e => {
                                console.error('Error during LDAP sync after user deletion:', e);
                              })
                              .finally(() => {
                                res.json({ message: `Utilisateur "${uid}" supprimé avec succès` });
                              });
                          });
                        }
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// Serveur HTTP pour signaler la détection du serveur
app.get('/status', (req, res) => {
  res.status(200).json({
    message: 'Server is running',
    serverDetected: false,
    ip: getLocalIP(),
  });
});

app.get('/api/server-info', verifyToken, async (req, res) => {
  try {
    const serverInfo = await getServerInfo();
    res.json(serverInfo);
  } catch (error) {
    console.error('Erreur lors de la récupération des informations du serveur :', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération des informations' });
  }
});

app.get('/api/disks', async (req, res) => {
  try {
    // 1) Liste des disques physiques
    const diskLayout = await si.diskLayout();
    // 2) Liste des volumes montés
    const fsSizes    = await si.fsSize();

    // 3) Compose la réponse disque par disque
    const disks = diskLayout.map(d => {
      const totalBytes = d.size;
      const parts      = fsSizes.filter(f =>
        f.fs && f.fs.startsWith(d.device)
      );
      const mounted    = parts.length > 0;

      // Si monté, on calcule used/free ; sinon, on force à 0
      let usedBytes, freeBytes;
      if (mounted) {
        usedBytes = parts.reduce((sum, p) => sum + p.used, 0);
        freeBytes = totalBytes - usedBytes;
      } else {
        usedBytes = 0;
        freeBytes = 0;
      }

      return {
        device:  d.device,                         // ex: '/dev/sda'
        size:    `${(totalBytes / 1e9).toFixed(1)} GB`,
        used:    `${(usedBytes   / 1e9).toFixed(1)} GB`,
        free:    `${(freeBytes   / 1e9).toFixed(1)} GB`,
        mounted: mounted
      };
    });

    // 4) Totaux globaux (uniquement pour les disques montés)
    const mountedDisks = disks.filter(d => d.mounted);
    const totalSize = mountedDisks.reduce((sum, d) => sum + parseFloat(d.size), 0);
    const totalUsed = mountedDisks.reduce((sum, d) => sum + parseFloat(d.used), 0);
    const totalFree = mountedDisks.reduce((sum, d) => sum + parseFloat(d.free), 0);

    res.json({
      disks,
      total: {
        size: `${totalSize.toFixed(1)} GB`,
        used: `${totalUsed.toFixed(1)} GB`,
        free: `${totalFree.toFixed(1)} GB`
      }
    });
  } catch (err) {
    console.error('Erreur récupération info disques :', err);
    res.status(500).json({ error: 'Impossible de récupérer les informations de disques' });
  }
});

// Endpoint : Récupérer la liste des applications et leur statut
app.get('/api/apps', async (req, res) => {
  try {
    const apps = await getAppStatus();
    res.status(200).json(apps);
  } catch (error) {
    console.error('Erreur lors de la récupération des applications :', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération des applications' });
  }
});

// Endpoint : Démarrer une application
app.post('/api/apps/:id/start', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await startApp(id);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Erreur lors du démarrage de l'application ${id} :`, error);
    res.status(500).json({ 
      error: `Erreur serveur lors du démarrage de l'application`,
      message: error.message
    });
  }
});

// Endpoint : Arrêter une application
app.post('/api/apps/:id/stop', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await stopApp(id);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Erreur lors de l'arrêt de l'application ${id} :`, error);
    res.status(500).json({ 
      error: `Erreur serveur lors de l'arrêt de l'application`,
      message: error.message
    });
  }
});

// Endpoint : Redémarrer une application
app.post('/api/apps/:id/restart', verifyToken, hasPermission('manage_apps'), async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await restartApp(id);
    res.status(200).json(result);
  } catch (error) {
    console.error(`Erreur lors du redémarrage de l'application ${id} :`, error);
    res.status(500).json({ 
      error: `Erreur serveur lors du redémarrage de l'application`,
      message: error.message
    });
  }
});

// Endpoint public pour récupérer la liste des utilisateurs (utilisé pour la page de connexion)
app.get('/api/users-public', async (req, res) => {
  const ldapClient = ldap.createClient({ 
    url: ldapConfig.url,
    timeout: 5000,
    connectTimeout: 5000
  });

  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Échec de la connexion LDAP :', err);
      // En cas d'erreur, retourner une liste d'utilisateurs par défaut
      return res.json([
        { uid: 'jules', name: 'Jules', role: 'Admin', email: 'jules.maisonnave@gmail.com' },
        { uid: 'cynthia', name: 'Cynthia', role: 'User', email: 'cynthia@example.com' },
        { uid: 'test', name: 'Test', role: 'User', email: 'test@gmail.com' }
      ]);
    }

    const ldapUsers = [];
    
    // Utiliser le filtre défini dans la configuration
    console.log('Recherche d\'utilisateurs avec filtre:', ldapConfig.userFilter);
    
    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter: ldapConfig.userFilter, scope: 'sub', attributes: ['cn', 'uid', 'mail', 'dn'] },
      (err, ldapRes) => {
        if (err) {
          console.error('Erreur de recherche LDAP :', err);
          // En cas d'erreur, retourner une liste d'utilisateurs par défaut
          return res.json([
            { uid: 'jules', name: 'Jules', role: 'Admin', email: 'jules.maisonnave@gmail.com' },
            { uid: 'cynthia', name: 'Cynthia', role: 'User', email: 'cynthia@example.com' },
            { uid: 'test', name: 'Test', role: 'User', email: 'test@gmail.com' }
          ]);
        }

        ldapRes.on('searchEntry', (entry) => {
          try {
            // Extraire les attributs de l'entrée
            const attrs = {};
            entry.pojo.attributes.forEach(attr => {
              attrs[attr.type] = attr.values[0];
            });
            
            const dn = entry.pojo.objectName;
            const cn = attrs.cn || 'Nom inconnu';
            const uid = attrs.uid || attrs.cn || 'UID inconnu';
            const mail = attrs.mail || `${uid}@${process.env.DEFAULT_EMAIL_DOMAIN || 'localhost'}`;

            // Exclure l'utilisateur `read-only`
            if (uid !== 'read-only') {
              ldapUsers.push({ 
                uid, 
                name: cn, 
                email: mail,
                // Simplification pour la page de connexion
                role: uid === 'jules' ? 'Admin' : 'User'
              });
            }
          } catch (err) {
            console.error('Erreur lors du traitement de l\'entrée LDAP :', err);
          }
        });

        ldapRes.on('end', () => {
          console.log('Recherche utilisateur terminée pour la liste publique');
          console.log('Utilisateurs trouvés:', ldapUsers.length);
          
          // Si aucun utilisateur n'a été trouvé, renvoyer une liste par défaut
          if (ldapUsers.length === 0) {
            console.log('Aucun utilisateur trouvé, utilisation de la liste par défaut');
            return res.json([
              { uid: 'jules', name: 'Jules', role: 'Admin', email: 'jules.maisonnave@gmail.com' },
              { uid: 'cynthia', name: 'Cynthia', role: 'User', email: 'cynthia@example.com' },
              { uid: 'test', name: 'Test', role: 'User', email: 'test@gmail.com' }
            ]);
          }
          
          res.json(ldapUsers);
          ldapClient.unbind();
        });
      }
    );
  });
});

// Endpoint pour renouveler le token JWT
app.post('/api/refresh-token', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Token requis' });
  }
  
  try {
    // Vérifier le token même s'il est expiré (nous utilisons l'allowlist Redis pour la sécurité)
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    
    // Avant d'émettre un nouveau token, vérifier que l'ancien existe encore dans l'allowlist (non révoqué)
    try {
      const redis = await ensureConnected();
      const key = `access:token:${token}`;
      const exists = await redis.exists(key);
      if (!exists) {
        return res.status(401).json({ error: 'Token révoqué ou inconnu', code: 'REVOKED_TOKEN' });
      }
    } catch (e) {
      console.warn('[refresh-token] Redis indisponible lors de la vérification de l\'allowlist:', e?.message || e);
      // En cas d\'indisponibilité Redis, par sécurité, refuser le refresh
      return res.status(503).json({ error: 'Service indisponible. Réessayez plus tard.' });
    }
    
    // Générer un nouveau token (durée configurable)
    const newToken = jwt.sign(
      {
        uid: decoded.uid,
        name: decoded.name,
        email: decoded.email,
        role: decoded.role
      },
      JWT_SECRET,
      { expiresIn: `${JWT_EXPIRES_MINUTES}m` }
    );
    // Mettre à jour l'allowlist Redis: révoquer l'ancien token et enregistrer le nouveau
    try {
      const redis = await ensureConnected();
      if (token) {
        await redis.del(`access:token:${token}`);
      }
      await redis.set(
        `access:token:${newToken}`,
        JSON.stringify({ uid: decoded.uid, role: decoded.role }),
        { EX: JWT_EXPIRES_SECONDS }
      );
    } catch (e) {
      console.warn('[refresh-token] Redis indisponible, impossible de mettre à jour l\'allowlist:', e?.message || e);
    }

    return res.json({
      token: newToken,
      expiresIn: JWT_EXPIRES_SECONDS, // en secondes
      user: {
        uid: decoded.uid,
        name: decoded.name,
        email: decoded.email,
        role: decoded.role
      }
    });
  } catch (error) {
    console.error('Erreur lors du renouvellement du token:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token invalide', code: 'INVALID_TOKEN' });
    }
    return res.status(401).json({ error: 'Token invalide ou expiré', code: 'TOKEN_ERROR' });
  }
});

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