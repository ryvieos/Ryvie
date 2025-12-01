const jwt = require('jsonwebtoken');
const { ensureConnected } = require('../redisClient');
const fs = require('fs');
const path = require('path');
const { SETTINGS_FILE } = require('../config/paths');

const JWT_SECRET = process.env.JWT_SECRET;

// Fonction pour obtenir la durée d'expiration actuelle
function getTokenExpirationMinutes() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (settings.tokenExpirationMinutes) {
        return Math.max(1, parseInt(settings.tokenExpirationMinutes, 10));
      }
    }
  } catch (error) {
    console.warn('[authService] Erreur lecture settings, utilisation valeur par défaut');
  }
  // Fallback sur la variable d'environnement ou 15 minutes par défaut
  return Math.max(1, parseInt(process.env.JWT_EXPIRES_MINUTES || '15', 10) || 15);
}

function getTokenExpirationSeconds() {
  return getTokenExpirationMinutes() * 60;
}

async function checkBruteForce(uid, ip) {
  try {
    const redis = await ensureConnected();
    const key = `bruteforce:${uid}:${ip}`;
    const attempts = parseInt(await redis.get(key) || '0', 10);

    if (attempts >= (parseInt(process.env.BRUTE_FORCE_MAX_ATTEMPTS || '5', 10))) {
      const ttl = await redis.ttl(key);
      return { blocked: true, retryAfter: ttl > 0 ? ttl : (parseInt(process.env.BRUTE_FORCE_BLOCK_DURATION_MS || '900000', 10) / 1000) };
    }
    return { blocked: false };
  } catch (e) {
    console.warn('[bruteforce] Redis indisponible, fallback permissif');
    return { blocked: false };
  }
}

async function recordFailedAttempt(uid, ip) {
  try {
    const redis = await ensureConnected();
    const key = `bruteforce:${uid}:${ip}`;
    const attempts = (parseInt(await redis.get(key) || '0', 10) + 1);
    await redis.set(key, attempts, { EX: 15 * 60 });
    return attempts;
  } catch (e) {
    console.warn('[bruteforce] Redis indisponible, impossible d\'enregistrer');
    return 0;
  }
}

async function clearFailedAttempts(uid, ip) {
  try {
    const redis = await ensureConnected();
    await redis.del(`bruteforce:${uid}:${ip}`);
  } catch (e) {
    console.warn('[bruteforce] Redis indisponible, impossible de nettoyer');
  }
}

function signToken(user) {
  const expirationMinutes = getTokenExpirationMinutes();
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: `${expirationMinutes}m` });
  console.log(`[authService] ✅ Nouveau token généré pour ${user.uid} (expire dans ${expirationMinutes} minutes)`);
  return token;
}

async function allowlistToken(token, user) {
  try {
    const redis = await ensureConnected();
    const key = `access:token:${token}`;
    const expirationSeconds = getTokenExpirationSeconds();
    await redis.set(key, JSON.stringify({ uid: user.uid, role: user.role }), { EX: expirationSeconds });
    console.log(`[authService] ✅ Token enregistré dans Redis pour ${user.uid} (TTL: ${expirationSeconds}s)`);
  } catch (e) {
    console.warn('[login] Impossible d\'enregistrer le token dans Redis:', e?.message || e);
  }
}

module.exports = {
  getTokenExpirationSeconds,
  checkBruteForce,
  recordFailedAttempt,
  clearFailedAttempts,
  signToken,
  allowlistToken,
};
