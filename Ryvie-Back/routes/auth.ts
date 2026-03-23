export {};
const express = require('express');
const rateLimit = require('express-rate-limit');
const ldap = require('ldapjs');
const jwt = require('jsonwebtoken');
const { ensureConnected } = require('../redisClient');
const ldapConfig = require('../config/ldap');
const { createSafeClient, escapeLdapFilterValue, getUserRole } = require('../services/ldapService');
const { verifyToken, isAdmin } = require('../middleware/auth');
const {
  getTokenExpirationSeconds,
  checkBruteForce,
  recordFailedAttempt,
  clearFailedAttempts,
  signToken,
  allowlistToken,
} = require('../services/authService');
const { startApp } = require('../services/dockerService');
const { listInstalledApps } = require('../services/appManagerService');

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
router.post('/authenticate', authLimiter, async (req: any, res: any) => {
  const { uid: rawUid, password: rawPassword } = req.body;
  const uid = (rawUid || '').trim();
  const password = (rawPassword || '').trim();
  if (!uid || !password) return res.status(400).json({ error: 'UID et mot de passe requis' });

  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const bruteForceCheck = await checkBruteForce(uid, clientIP);
  if (bruteForceCheck.blocked) {
    return res.status(429).json({ error: 'Trop de tentatives échouées. Réessayez plus tard.', retryAfter: bruteForceCheck.retryAfter });
  }

  const ldapClient = createSafeClient();

  // 1) Bind initial
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) return res.status(500).json({ error: 'Échec de connexion LDAP initiale' });

    const escaped = escapeLdapFilterValue(uid);
    const primaryFilter = `(uid=${escaped})`;
    const fallbackFilter = `(cn=${escaped})`;
    const emailFilter = `(mail=${escaped})`;
    const userFilter = `(|${primaryFilter}${fallbackFilter}${emailFilter})`;
    const searchFilter = `(&${userFilter}${ldapConfig.userFilter})`;

    ldapClient.search(ldapConfig.userSearchBase, { filter: searchFilter, scope: 'sub', attributes: ['dn', 'cn', 'mail', 'uid', 'preferredLanguage'] }, (err, ldapRes) => {
      if (err) return res.status(500).json({ error: 'Erreur de recherche utilisateur' });

      let userEntry;
      let fallbackTried = false;

      ldapRes.on('searchEntry', (entry) => { userEntry = entry; });
      ldapRes.on('end', () => {
        if (!userEntry) {
          if (!fallbackTried) {
            fallbackTried = true;
            const altSearch = `(&${userFilter}${ldapConfig.userFilter})`;
            return ldapClient.search(ldapConfig.userSearchBase, { filter: altSearch, scope: 'sub', attributes: ['dn','cn','mail','uid','preferredLanguage'] }, (err2, altRes) => {
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
        const userAuthClient = createSafeClient();
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
            } catch (e: any) {
              role = 'Guest';
            } finally {
              complete();
            }
          })();

          function complete() {
            ldapClient.unbind();
            const attrs: any = {}; userEntry.pojo.attributes.forEach((attr: any) => attrs[attr.type] = attr.values[0]);
            const user = {
              uid: attrs.uid || attrs.cn || uid,
              name: attrs.cn || uid,
              email: attrs.mail || `${uid}@${process.env.DEFAULT_EMAIL_DOMAIN || 'localhost'}`,
              role,
              language: attrs.preferredLanguage || 'fr',
            };
            const token = signToken(user);
            console.log(`[authenticate] 🔐 Authentification réussie pour ${user.uid} (rôle: ${role})`);
            (async () => { await allowlistToken(token, user); return res.json({ message: 'Authentification réussie', user, token, expiresIn: getTokenExpirationSeconds() }); })();
          }
        });
      }
    });
  });
});

function triggerLdapSync() {
  return new Promise((resolve) => {
    const http = require('http');
    const options = {
      hostname: 'localhost',
      port: parseInt(process.env.LDAP_SYNC_PORT || '3013', 10),
      path: '/api/ldap/sync',
      method: 'GET',
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Helper function to sync LDAP with installed apps (rpictures and rdrive)
async function syncLdapWithApps() {
  try {
    console.log('[syncLdapWithApps] Vérification des applications installées...');
    
    // Récupérer la liste des applications installées
    const installedApps = await listInstalledApps();
    const appIds = installedApps.map(app => app.id);
    
    console.log('[syncLdapWithApps] Applications installées:', appIds);
    
    // Vérifier si rpictures est installé
    const hasRpictures = appIds.includes('rpictures');
    
    // Vérifier si rdrive est installé
    const hasRdrive = appIds.includes('rdrive');
    
    // Synchroniser rpictures si installé
    if (hasRpictures) {
      console.log('[syncLdapWithApps] Synchronisation LDAP avec rpictures...');
      try {
        await triggerLdapSync();
        console.log('[syncLdapWithApps] ✅ Synchronisation rpictures réussie');
      } catch (error: any) {
        console.error('[syncLdapWithApps] ❌ Erreur synchronisation rpictures:', error.message);
      }
    } else {
      console.log('[syncLdapWithApps] rpictures non installé, synchronisation ignorée');
    }
    
    // Redémarrer le conteneur rdrive si installé
    if (hasRdrive) {
      console.log('[syncLdapWithApps] Redémarrage du conteneur rdrive...');
      try {
        await startApp('app-rdrive-node-create-user');
        console.log('[syncLdapWithApps] ✅ Redémarrage rdrive réussi');
      } catch (error: any) {
        console.error('[syncLdapWithApps] ❌ Erreur redémarrage rdrive:', error.message);
      }
    } else {
      console.log('[syncLdapWithApps] rdrive non installé, redémarrage ignoré');
    }
    
    return { success: true, hasRpictures, hasRdrive };
  } catch (error: any) {
    console.error('[syncLdapWithApps] Erreur lors de la synchronisation:', error.message);
    return { success: false, error: error.message };
  }
}

// GET /api/ldap/check-first-time - Vérifier si c'est la première connexion
router.get('/ldap/check-first-time', async (req: any, res: any) => {
  const ldapClient = createSafeClient();

  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      ldapClient.destroy();
      return res.status(500).json({ error: 'Échec de connexion LDAP', isFirstTime: false });
    }

    const filter = ldapConfig.userFilter;
    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter, scope: 'sub', attributes: ['uid'] },
      (err, ldapRes) => {
        if (err) {
          ldapClient.unbind();
          return res.status(500).json({ error: 'Erreur de recherche LDAP', isFirstTime: false });
        }

        let userCount = 0;
        ldapRes.on('searchEntry', (entry) => {
          try {
            const attrs: any = {};
            entry.pojo.attributes.forEach((attr: any) => { attrs[attr.type] = attr.values[0]; });
            const uid = attrs.uid;
            // Ne compter que les utilisateurs réels (pas read-only)
            if (uid && uid !== 'read-only') {
              userCount++;
            }
          } catch (e: any) {
            console.error('[check-first-time] Erreur lors du parsing:', e);
          }
        });

        ldapRes.on('end', () => {
          ldapClient.unbind();
          // Si seulement l'utilisateur read-only existe (userCount === 0), c'est la première fois
          const isFirstTime = userCount === 0;
          console.log(`[check-first-time] Nombre d'utilisateurs: ${userCount}, isFirstTime: ${isFirstTime}`);
          res.json({ isFirstTime, userCount });
        });

        ldapRes.on('error', (err) => {
          ldapClient.unbind();
          console.error('[check-first-time] Erreur LDAP:', err);
          res.status(500).json({ error: 'Erreur LDAP', isFirstTime: false });
        });
      }
    );
  });
});

// POST /api/ldap/create-first-user - Créer le premier utilisateur admin
router.post('/ldap/create-first-user', async (req: any, res: any) => {
  const { uid, name, email, password, language } = req.body;

  if (!uid || !name || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont requis (uid, name, email, password)' });
  }

  const ldapClient = createSafeClient();

  // Utiliser les credentials admin pour la création d'utilisateur
  ldapClient.bind(ldapConfig.adminBindDN, ldapConfig.adminBindPassword, (err) => {
    if (err) {
      ldapClient.destroy();
      console.error('[create-first-user] Échec de connexion LDAP admin:', err);
      return res.status(500).json({ error: 'Échec de connexion LDAP avec les credentials admin' });
    }

    // Vérifier d'abord qu'il n'y a bien qu'un seul utilisateur (read-only)
    const checkFilter = ldapConfig.userFilter;
    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter: checkFilter, scope: 'sub', attributes: ['uid'] },
      (err, checkRes) => {
        if (err) {
          ldapClient.unbind();
          return res.status(500).json({ error: 'Erreur de vérification LDAP' });
        }

        let userCount = 0;
        checkRes.on('searchEntry', (entry) => {
          try {
            const attrs: any = {};
            entry.pojo.attributes.forEach((attr: any) => { attrs[attr.type] = attr.values[0]; });
            const existingUid = attrs.uid;
            if (existingUid && existingUid !== 'read-only') {
              userCount++;
            }
          } catch (e: any) {}
        });

        checkRes.on('end', () => {
          if (userCount > 0) {
            ldapClient.unbind();
            return res.status(403).json({ error: 'Des utilisateurs existent déjà. Cette route est réservée à la première configuration.' });
          }

          // Créer l'utilisateur avec employeeType pour définir le rôle
          const userDN = `cn=${name},${ldapConfig.userSearchBase}`;
          const userEntry: any = {
            objectClass: ['inetOrgPerson', 'posixAccount', 'shadowAccount'],
            uid,
            cn: name,
            sn: name.split(' ').pop() || name,
            mail: email,
            userPassword: password,
            uidNumber: '10000',
            gidNumber: '10000',
            homeDirectory: `/home/${uid}`,
            loginShell: '/bin/bash',
            employeeType: 'admins',  // Définit le rôle de l'utilisateur
          };

          // Ajouter la langue si fournie
          if (language) {
            userEntry.preferredLanguage = language;
          }

          ldapClient.add(userDN, userEntry, (err) => {
            if (err) {
              ldapClient.unbind();
              console.error('[create-first-user] Erreur création utilisateur:', err);
              return res.status(500).json({ error: 'Erreur lors de la création de l\'utilisateur', details: err.message });
            }

            console.log(`[create-first-user] Utilisateur créé: ${uid}`);

            // Vérifier si le groupe admins existe, sinon le créer
            const adminGroupDN = ldapConfig.adminGroup;
            ldapClient.search(adminGroupDN, { scope: 'base', attributes: ['cn'] }, (err, searchRes) => {
              let groupExists = false;

              searchRes.on('searchEntry', () => {
                groupExists = true;
              });

              searchRes.on('error', (err) => {
                // Le groupe n'existe pas (erreur 32 = No such object)
                if (err.code === 32) {
                  console.log('[create-first-user] Le groupe admins n\'existe pas, création...');
                  
                  // Créer le groupe admins
                  const groupEntry = {
                    objectClass: 'groupOfNames',
                    cn: 'admins',
                    member: userDN
                  };

                  ldapClient.add(adminGroupDN, groupEntry, (err) => {
                    ldapClient.unbind();
                    if (err) {
                      console.error('[create-first-user] Erreur création groupe admin:', err);
                      return res.status(500).json({ error: 'Utilisateur créé mais erreur lors de la création du groupe admin', details: err.message });
                    }

                    console.log(`[create-first-user] Groupe admins créé et utilisateur ajouté: ${uid}`);
                    syncLdapWithApps()
                      .catch(() => {})
                      .finally(() => {
                        return res.json({ message: 'Premier utilisateur admin créé avec succès', uid, role: 'Admin' });
                      });
                  });
                } else {
                  ldapClient.unbind();
                  console.error('[create-first-user] Erreur recherche groupe admin:', err);
                  return res.status(500).json({ error: 'Erreur lors de la vérification du groupe admin', details: err.message });
                }
              });

              searchRes.on('end', () => {
                if (groupExists) {
                  // Le groupe existe, ajouter l'utilisateur
                  console.log('[create-first-user] Le groupe admins existe, ajout de l\'utilisateur...');
                  const modification = new ldap.Attribute({
                    type: 'member',
                    values: [userDN]
                  });

                  ldapClient.modify(
                    adminGroupDN,
                    [new ldap.Change({ operation: 'add', modification })],
                    (err) => {
                      ldapClient.unbind();
                      if (err) {
                        console.error('[create-first-user] Erreur ajout au groupe admin:', err);
                        return res.status(500).json({ error: 'Utilisateur créé mais erreur lors de l\'ajout au groupe admin', details: err.message });
                      }

                      console.log(`[create-first-user] Premier utilisateur admin créé: ${uid}`);
                      syncLdapWithApps()
                        .catch(() => {})
                        .finally(() => {
                          return res.json({ message: 'Premier utilisateur admin créé avec succès', uid, role: 'Admin' });
                        });
                    }
                  );
                }
              });
            });
          });
        });

        checkRes.on('error', (err) => {
          ldapClient.unbind();
          console.error('[create-first-user] Erreur vérification:', err);
          res.status(500).json({ error: 'Erreur de vérification LDAP' });
        });
      }
    );
  });
});

// GET /api/ldap/sync - Synchroniser les utilisateurs LDAP avec les applications
router.get('/ldap/sync', async (req: any, res: any) => {
  const ldapClient = createSafeClient();
  let users = [];

  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      ldapClient.destroy();
      return res.status(500).json({ error: 'Échec de la connexion LDAP' });
    }

    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter: ldapConfig.userFilter, scope: 'sub', attributes: ['cn', 'uid', 'mail', 'dn'] },
      (err, ldapRes) => {
        if (err) {
          ldapClient.unbind();
          return res.status(500).json({ error: 'Erreur de recherche LDAP' });
        }

        ldapRes.on('searchEntry', (entry) => {
          try {
            const attrs: any = {};
            entry.pojo.attributes.forEach((attr: any) => { attrs[attr.type] = attr.values[0]; });
            const uid = attrs.uid || attrs.cn;
            if (uid && uid !== 'read-only') {
              users.push({
                dn: entry.pojo.objectName,
                name: attrs.cn || uid,
                uid,
                email: attrs.mail || `${uid}@${process.env.DEFAULT_EMAIL_DOMAIN || 'localhost'}`,
              });
            }
          } catch (e: any) {
            console.error('[ldap-sync] Erreur parsing entry:', e);
          }
        });

        ldapRes.on('end', () => {
          // Récupérer les rôles
          const roles = {};
          ldapClient.search(
            ldapConfig.groupSearchBase,
            { filter: ldapConfig.groupFilter, scope: 'sub', attributes: ['cn', 'member'] },
            (err, groupRes) => {
              if (err) {
                ldapClient.unbind();
                return res.status(500).json({ error: 'Erreur lors de la recherche des groupes LDAP' });
              }

              groupRes.on('searchEntry', (groupEntry) => {
                const members = groupEntry.pojo.attributes.find(attr => attr.type === 'member')?.values || [];
                members.forEach((member) => {
                  if (!roles[member]) roles[member] = [];
                  roles[member].push(groupEntry.pojo.objectName);
                });
              });

              groupRes.on('end', () => {
                ldapClient.unbind();
                const usersWithRoles = users.map(user => ({
                  ...user,
                  role: getRole(user.dn, roles[user.dn] || []),
                }));

                console.log(`[ldap-sync] ${usersWithRoles.length} utilisateurs synchronisés`);
                res.json({ message: 'Synchronisation LDAP réussie', users: usersWithRoles, count: usersWithRoles.length });
              });

              groupRes.on('error', (err) => {
                ldapClient.unbind();
                console.error('[ldap-sync] Erreur groupes:', err);
                res.status(500).json({ error: 'Erreur lors de la récupération des groupes' });
              });
            }
          );
        });

        ldapRes.on('error', (err) => {
          ldapClient.unbind();
          console.error('[ldap-sync] Erreur recherche:', err);
          res.status(500).json({ error: 'Erreur lors de la recherche LDAP' });
        });
      }
    );
  });
});

function getRole(dn, groupMemberships) {
  if (groupMemberships.includes(ldapConfig.adminGroup)) return 'Admin';
  if (groupMemberships.includes(ldapConfig.userGroup)) return 'User';
  if (groupMemberships.includes(ldapConfig.guestGroup)) return 'Guest';
  return 'Unknown';
}

// POST /api/refresh-token
router.post('/refresh-token', async (req: any, res: any) => {
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
    const expirationSeconds = getTokenExpirationSeconds();
    const expirationMinutes = Math.floor(expirationSeconds / 60);
    const newToken = jwt.sign(newPayload, process.env.JWT_SECRET, { expiresIn: `${expirationMinutes}m` });

    await redis.del(key);
    await redis.set(`access:token:${newToken}`, JSON.stringify({ uid, role }), { EX: expirationSeconds });

    console.log(`[refresh-token] 🔄 Token actualisé pour ${uid} (expire dans ${expirationMinutes} minutes)`);
    return res.json({ token: newToken, user: newPayload, expiresIn: expirationSeconds });
  } catch (e: any) {
    return res.status(401).json({ error: 'Token invalide' });
  }
});

export = router;
