const express = require('express');
const rateLimit = require('express-rate-limit');
const ldap = require('ldapjs');
const jwt = require('jsonwebtoken');
const { ensureConnected } = require('../redisClient');
const ldapConfig = require('../config/ldap');
const { escapeLdapFilterValue, getUserRole } = require('../services/ldapService');
const {
  JWT_EXPIRES_SECONDS,
  checkBruteForce,
  recordFailedAttempt,
  clearFailedAttempts,
  signToken,
  allowlistToken,
} = require('../services/authService');

const router = express.Router();

// Limiteur pour l'authentification
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.', retryAfter: 15 * 60 },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// POST /api/authenticate
router.post('/authenticate', authLimiter, async (req, res) => {
  const { uid: rawUid, password: rawPassword } = req.body;
  const uid = (rawUid || '').trim();
  const password = (rawPassword || '').trim();
  if (!uid || !password) return res.status(400).json({ error: 'UID et mot de passe requis' });

  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const bruteForceCheck = await checkBruteForce(uid, clientIP);
  if (bruteForceCheck.blocked) {
    return res.status(429).json({ error: 'Trop de tentatives échouées. Réessayez plus tard.', retryAfter: bruteForceCheck.retryAfter });
  }

  const ldapClient = ldap.createClient({ url: ldapConfig.url, timeout: 5000, connectTimeout: 5000 });

  // 1) Bind initial
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) return res.status(500).json({ error: 'Échec de connexion LDAP initiale' });

    const escaped = escapeLdapFilterValue(uid);
    const primaryFilter = `(uid=${escaped})`;
    const fallbackFilter = `(cn=${escaped})`;
    const userFilter = `(|${primaryFilter}${fallbackFilter})`;
    const searchFilter = `(&${primaryFilter}${ldapConfig.userFilter})`;

    ldapClient.search(ldapConfig.userSearchBase, { filter: searchFilter, scope: 'sub', attributes: ['dn', 'cn', 'mail', 'uid'] }, (err, ldapRes) => {
      if (err) return res.status(500).json({ error: 'Erreur de recherche utilisateur' });

      let userEntry;
      let fallbackTried = false;

      ldapRes.on('searchEntry', (entry) => { userEntry = entry; });
      ldapRes.on('end', () => {
        if (!userEntry) {
          if (!fallbackTried) {
            fallbackTried = true;
            const altSearch = `(&${userFilter}${ldapConfig.userFilter})`;
            return ldapClient.search(ldapConfig.userSearchBase, { filter: altSearch, scope: 'sub', attributes: ['dn','cn','mail','uid'] }, (err2, altRes) => {
              if (err2) {
                ldapClient.unbind();
                return res.status(500).json({ error: 'Erreur de recherche utilisateur' });
              }
              altRes.on('searchEntry', (entry) => { if (!userEntry) userEntry = entry; });
              altRes.on('end', () => {
                if (!userEntry) {
                  ldapClient.unbind();
                  return res.status(401).json({ error: 'Utilisateur non trouvé' });
                }
                proceed(userEntry);
              });
            });
          }
          ldapClient.unbind();
          return res.status(401).json({ error: 'Utilisateur non trouvé' });
        }
        proceed(userEntry);
      });

      function proceed(userEntry) {
        const userDN = userEntry.pojo.objectName;
        const userAuthClient = ldap.createClient({ url: ldapConfig.url, timeout: 5000, connectTimeout: 5000 });
        userAuthClient.bind(userDN, password, async (err) => {
          if (err) {
            ldapClient.unbind();
            userAuthClient.destroy();
            const attempts = await recordFailedAttempt(uid, clientIP);
            return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect', attempts });
          }

          await clearFailedAttempts(uid, clientIP);
          userAuthClient.unbind();

          // Déterminer le rôle via helper centralisé
          let role = 'Guest';
          (async () => {
            try {
              role = await getUserRole(userDN);
            } catch (e) {
              role = 'Guest';
            } finally {
              complete();
            }
          })();

          function complete() {
            ldapClient.unbind();
            const attrs = {}; userEntry.pojo.attributes.forEach(attr => attrs[attr.type] = attr.values[0]);
            const user = {
              uid: attrs.uid || attrs.cn || uid,
              name: attrs.cn || uid,
              email: attrs.mail || `${uid}@${process.env.DEFAULT_EMAIL_DOMAIN || 'localhost'}`,
              role,
            };
            const token = signToken(user);
            (async () => { await allowlistToken(token, user); return res.json({ message: 'Authentification réussie', user, token, expiresIn: JWT_EXPIRES_SECONDS }); })();
          }
        });
      }
    });
  });
});

// POST /api/refresh-token
router.post('/refresh-token', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token requis' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const redis = await ensureConnected();
    const key = `access:token:${token}`;
    const exists = await redis.get(key);
    if (!exists) return res.status(401).json({ error: 'Token révoqué ou inconnu', code: 'REVOKED_TOKEN' });

    const { uid, role, name, email } = payload;
    const newPayload = { uid, role, name, email };
    const newToken = jwt.sign(newPayload, process.env.JWT_SECRET, { expiresIn: `${process.env.JWT_EXPIRES_MINUTES || 15}m` });

    await redis.del(key);
    await redis.set(`access:token:${newToken}`, JSON.stringify({ uid, role }), { EX: parseInt(process.env.JWT_EXPIRES_MINUTES || '15', 10) * 60 });

    return res.json({ token: newToken, user: newPayload, expiresIn: parseInt(process.env.JWT_EXPIRES_MINUTES || '15', 10) * 60 });
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide' });
  }
});

// (Optionnel) POST /api/add-user – conservé tel quel pour compatibilité
router.post('/add-user', async (req, res) => {
  // Pour rester compatible avec l\'ancien comportement, on pourra déplacer la logique ici plus tard
  return res.status(501).json({ error: 'Non implémenté dans le refactoring actuel' });
});

module.exports = router;
