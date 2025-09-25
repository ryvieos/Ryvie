const jwt = require('jsonwebtoken');
const { ensureConnected } = require('../redisClient');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_MINUTES = Math.max(1, parseInt(process.env.JWT_EXPIRES_MINUTES || '15', 10) || 15);
const JWT_EXPIRES_SECONDS = JWT_EXPIRES_MINUTES * 60;

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
  return jwt.sign(user, JWT_SECRET, { expiresIn: `${JWT_EXPIRES_MINUTES}m` });
}

async function allowlistToken(token, user) {
  try {
    const redis = await ensureConnected();
    const key = `access:token:${token}`;
    await redis.set(key, JSON.stringify({ uid: user.uid, role: user.role }), { EX: JWT_EXPIRES_SECONDS });
  } catch (e) {
    console.warn('[login] Impossible d\'enregistrer le token dans Redis:', e?.message || e);
  }
}

module.exports = {
  JWT_EXPIRES_SECONDS,
  checkBruteForce,
  recordFailedAttempt,
  clearFailedAttempts,
  signToken,
  allowlistToken,
};
