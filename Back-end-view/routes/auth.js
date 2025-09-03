const express = require('express');
const rateLimit = require('express-rate-limit');
const ldap = require('ldapjs');
const jwt = require('jsonwebtoken');
const { ensureConnected } = require('../redisClient');
const ldapConfig = require('../config/ldap');
const { escapeLdapFilterValue, getUserRole } = require('../services/ldapService');
const { verifyToken, isAdmin } = require('../middleware/auth');
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

// Helper to trigger LDAP sync after changes
async function triggerLdapSync() {
  return new Promise((resolve) => {
    const client = require('http');
    const options = {
      hostname: 'localhost',
      port: process.env.PORT || 3002,
      path: '/api/admin/users/sync-ldap',
      method: 'GET',
      timeout: 10000,
    };
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', (e) => resolve({ statusCode: 500, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 504, error: 'Request timeout' }); });
    req.end();
  });
}

// POST /api/add-user — create a new LDAP user and assign role group
router.post('/add-user', verifyToken, isAdmin, async (req, res) => {
  const { adminUid, adminPassword, newUser } = req.body || {};

  if (!adminUid || !adminPassword || !newUser) {
    return res.status(400).json({ error: 'Champs requis manquants (adminUid, adminPassword, newUser)' });
  }
  const { uid, cn, sn, mail, password, role } = newUser;
  if (!uid || !cn || !sn || !mail || !password || !role) {
    return res.status(400).json({ error: 'Champs requis manquants pour newUser (uid, cn, sn, mail, password, role)' });
  }

  const ldapClient = ldap.createClient({ url: ldapConfig.url });

  // 1) Bind initial as service account
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur connexion LDAP initiale :', err);
      return res.status(500).json({ error: 'Erreur de connexion LDAP initiale' });
    }

    // 2) Find admin DN
    const adminFilter = `(&(uid=${adminUid})${ldapConfig.userFilter})`;
    ldapClient.search(ldapConfig.userSearchBase, { filter: adminFilter, scope: 'sub', attributes: ['dn'] }, (err, ldapRes) => {
      if (err) {
        console.error('Erreur recherche admin :', err);
        return res.status(500).json({ error: 'Erreur recherche admin' });
      }

      let adminEntry;
      ldapRes.on('searchEntry', (entry) => (adminEntry = entry));
      ldapRes.on('end', () => {
        if (!adminEntry) {
          ldapClient.unbind();
          return res.status(401).json({ error: 'Admin non trouvé' });
        }

        const adminDN = adminEntry.pojo.objectName;
        const adminAuthClient = ldap.createClient({ url: ldapConfig.url });

        // 3) Verify admin credentials
        adminAuthClient.bind(adminDN, adminPassword, (err) => {
          if (err) {
            console.error('Échec authentification admin :', err);
            ldapClient.unbind();
            return res.status(401).json({ error: 'Authentification Admin échouée' });
          }

          // 4) Ensure admin is in admin group
          ldapClient.search(ldapConfig.adminGroup, { filter: `(member=${adminDN})`, scope: 'base', attributes: ['cn'] }, (err, groupRes) => {
            let isAdminMember = false;
            groupRes.on('searchEntry', () => (isAdminMember = true));
            groupRes.on('end', () => {
              if (!isAdminMember) {
                ldapClient.unbind();
                adminAuthClient.unbind();
                return res.status(403).json({ error: 'Droits admin requis' });
              }

              // 5) Check for UID or email conflicts
              const checkFilter = `(|(uid=${uid})(mail=${mail}))`;
              ldapClient.search(ldapConfig.userSearchBase, { filter: checkFilter, scope: 'sub', attributes: ['uid', 'mail'] }, (err, checkRes) => {
                if (err) {
                  console.error('Erreur vérification uid/mail :', err);
                  return res.status(500).json({ error: 'Erreur lors de la vérification de l\'utilisateur' });
                }
                let conflict = null;
                checkRes.on('searchEntry', (entry) => {
                  const entryUid = entry.pojo.attributes.find((a) => a.type === 'uid')?.values[0];
                  const entryMail = entry.pojo.attributes.find((a) => a.type === 'mail')?.values[0];
                  if (entryUid === uid) conflict = 'UID';
                  else if (entryMail === mail) conflict = 'email';
                });
                checkRes.on('end', () => {
                  if (conflict) {
                    ldapClient.unbind();
                    adminAuthClient.unbind();
                    return res.status(409).json({ error: `Un utilisateur avec ce ${conflict} existe déjà.` });
                  }

                  // 6) Create user entry
                  const newUserDN = `uid=${uid},${ldapConfig.userSearchBase}`;
                  const entry = {
                    cn,
                    sn,
                    uid,
                    mail,
                    objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
                    userPassword: password,
                  };

                  adminAuthClient.add(newUserDN, entry, (err) => {
                    if (err) {
                      console.error('Erreur ajout utilisateur LDAP :', err);
                      ldapClient.unbind();
                      adminAuthClient.unbind();
                      return res.status(500).json({ error: 'Erreur ajout utilisateur LDAP' });
                    }

                    // 7) Add to role group
                    const roleGroup = { Admin: ldapConfig.adminGroup, User: ldapConfig.userGroup, Guest: ldapConfig.guestGroup }[role];
                    if (!roleGroup) {
                      ldapClient.unbind();
                      adminAuthClient.unbind();
                      return res.status(400).json({ error: `Rôle inconnu : ${role}` });
                    }

                    const groupClient = ldap.createClient({ url: ldapConfig.url });
                    groupClient.bind(adminDN, adminPassword, (err) => {
                      if (err) {
                        console.error('Échec bind admin pour ajout au groupe');
                        ldapClient.unbind();
                        adminAuthClient.unbind();
                        return res.status(500).json({ error: 'Impossible d\'ajouter au groupe' });
                      }

                      const change = new ldap.Change({ operation: 'add', modification: new ldap.Attribute({ type: 'member', values: [newUserDN] }) });
                      groupClient.modify(roleGroup, change, (err) => {
                        ldapClient.unbind();
                        adminAuthClient.unbind();
                        groupClient.unbind();

                        if (err && err.name !== 'AttributeOrValueExistsError') {
                          console.error('Erreur ajout au groupe :', err);
                          return res.status(500).json({ error: 'Utilisateur créé, mais échec d\'ajout au groupe' });
                        }

                        triggerLdapSync().finally(() => {
                          return res.json({
                            message: `Utilisateur "${uid}" ajouté avec succès en tant que ${role}`,
                            user: { cn, sn, uid, mail, role },
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

module.exports = router;
