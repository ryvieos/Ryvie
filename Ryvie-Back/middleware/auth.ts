export {};
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { createClient } = require('redis');

// Charger les variables d'environnement
dotenv.config();

// Secret pour signer les tokens JWT
const JWT_SECRET = process.env.JWT_SECRET || 'dQMsVQS39XkJRCHsAhJn3Hn2';

// Redis client for token allowlist/denylist
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err: any) => {
  console.warn('[auth middleware] Redis client error:', err?.message || err);
});

// Best-effort connect (non-blocking during startup); we also lazy-connect in middleware
(async () => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
      console.log('[auth middleware] Connected to Redis');
    }
  } catch (e: any) {
    console.warn('[auth middleware] Unable to connect to Redis at startup. Will retry on demand.');
  }
})();

// Vérifie si le token est valide
const verifyToken = async (req: any, res: any, next: any) => {
  // Récupérer le token de l'en-tête Authorization
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ 
      error: 'Accès refusé. Authentification requise.' 
    });
  }

  try {
    // Vérifier le token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Ajouter l'utilisateur décodé à l'objet request pour une utilisation ultérieure
    req.user = decoded;
    // Enforce Redis allowlist if available
    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      const key = `access:token:${token}`;
      const exists = await redisClient.exists(key);
      if (!exists) {
        return res.status(401).json({ error: 'Token révoqué ou inconnu' });
      }
    } catch (e: any) {
      // If Redis is down, fail open to avoid outage, but warn
      console.warn('[auth middleware] Redis unavailable, skipping allowlist check');
    }

    next(); // Passer au middleware suivant
  } catch (error: any) {
    console.error('Erreur de vérification du token:', error);
    
    // Handle specific JWT errors
    if (error.name === 'JsonWebTokenError') {
      if (error.message === 'invalid signature') {
        console.warn('[auth] JWT signature invalid - likely due to JWT_SECRET rotation');
        // Clear the invalid token from Redis if it exists
        try {
          if (redisClient.isOpen) {
            const key = `access:token:${token}`;
            await redisClient.del(key);
          }
        } catch (e: any) {
          console.warn('[auth] Could not clear invalid token from Redis');
        }
      }
      return res.status(401).json({ 
        error: 'Token invalide - veuillez vous reconnecter',
        code: 'INVALID_TOKEN'
      });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expiré - veuillez vous reconnecter',
        code: 'EXPIRED_TOKEN'
      });
    } else {
      return res.status(401).json({ 
        error: 'Token invalide ou expiré',
        code: 'TOKEN_ERROR'
      });
    }
  }
};

// Vérifie si l'utilisateur est admin
const isAdmin = (req: any, res: any, next: any) => {
  if (req.user && req.user.role === 'Admin') {
    next();
  } else {
    return res.status(403).json({ 
      error: 'Accès refusé. Droits d\'administrateur requis.' 
    });
  }
};

// Vérifie si l'utilisateur a une permission spécifique
const hasPermission = (permission: string) => {
  return (req: any, res: any, next: any) => {
    console.log(`[auth] Vérification permission '${permission}' pour utilisateur:`, req.user);
    
    // Définir les permissions par rôle
    const permissions: any = {
      Admin: ['manage_users', 'manage_apps', 'view_server_info', 'access_settings'],
      User: ['view_server_info'],
      Guest: []
    };

    console.log(`[auth] Permissions disponibles pour le rôle ${req.user?.role}:`, permissions[req.user?.role]);
    
    // Vérifier si l'utilisateur a la permission requise
    if (req.user && permissions[req.user.role] && permissions[req.user.role].includes(permission)) {
      console.log(`[auth] ✅ Permission '${permission}' accordée`);
      next();
    } else {
      console.log(`[auth] ❌ Permission '${permission}' refusée - rôle: ${req.user?.role}`);
      return res.status(403).json({ 
        error: `Accès refusé. Permission '${permission}' requise.` 
      });
    }
  };
};

module.exports = {
  verifyToken,
  authenticateToken: verifyToken, // Alias pour compatibilité
  isAdmin,
  hasPermission,
  JWT_SECRET
};
