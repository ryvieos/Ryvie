const express = require('express');
const ldap = require('ldapjs');
const router = express.Router();
const { verifyToken, isAdmin } = require('../middleware/auth');
const ldapConfig = require('../config/ldap');
const { getRole, parseDnParts, escapeRdnValue } = require('../services/ldapService');
const { startApp } = require('../services/dockerService');

// GET /api/admin/users/sync-ldap
router.get('/admin/users/sync-ldap', verifyToken, isAdmin, async (req, res) => {
  const ldapClient = ldap.createClient({ url: ldapConfig.url });
  let users = [];

  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur de connexion LDAP :', err);
      return res.status(500).json({ error: 'Erreur de connexion LDAP' });
    }

    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter: ldapConfig.userFilter, scope: 'sub', attributes: ['uid', 'cn', 'sn', 'mail', 'memberOf'] },
      (err, searchRes) => {
        if (err) {
          console.error('Erreur de recherche LDAP :', err);
          ldapClient.unbind();
          return res.status(500).json({ error: 'Erreur de recherche LDAP' });
        }

        searchRes.on('searchEntry', (entry) => {
          const user = entry.pojo.attributes.reduce((acc, attr) => {
            acc[attr.type] = attr.values.length === 1 ? attr.values[0] : attr.values;
            return acc;
          }, {});

          user.dn = entry.pojo.objectName;
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
          console.log(`Synchronisation LDAP réussie. ${users.length} utilisateurs synchronisés.`);
          return res.status(200).send(`${users.length}`);
        });
      }
    );
  });
});

// POST /api/add-user — create a new LDAP user and assign role group (moved from auth.js)
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

                        triggerLdapSync()
                          .catch(() => {})
                          .finally(() => {
                            try { startApp('app-rdrive-node-create-user').catch(() => {}); } catch (_) {}
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

// POST /api/delete-user (kept for backward compatibility)
router.post('/delete-user', verifyToken, isAdmin, async (req, res) => {
  const { adminUid, adminPassword, uid } = req.body;

  if (!adminUid || !adminPassword || !uid) {
    return res.status(400).json({ error: 'adminUid, adminPassword et uid requis' });
  }

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

    ldapClient.search(
      ldapConfig.userSearchBase,
      { filter: adminFilter, scope: 'sub', attributes: ['dn'] },
      (err, ldapRes) => {
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

          adminAuthClient.bind(adminDN, adminPassword, (err) => {
            if (err) {
              console.error('Échec authentification admin :', err);
              ldapClient.unbind();
              return res.status(401).json({ error: 'Mot de passe admin incorrect' });
            }

            ldapClient.search(
              ldapConfig.adminGroup,
              { filter: `(member=${adminDN})`, scope: 'base', attributes: ['cn'] },
              (err, groupRes) => {
                let isAdmin = false;
                groupRes.on('searchEntry', () => (isAdmin = true));

                groupRes.on('end', () => {
                  if (!isAdmin) {
                    ldapClient.unbind();
                    adminAuthClient.unbind();
                    return res.status(403).json({ error: 'Accès refusé. Droits admin requis.' });
                  }

                  ldapClient.search(
                    ldapConfig.userSearchBase,
                    { filter: `(uid=${uid})`, scope: 'sub', attributes: ['dn'] },
                    (err, userRes) => {
                      if (err) {
                        console.error('Erreur recherche utilisateur à supprimer :', err);
                        return res.status(500).json({ error: 'Erreur recherche utilisateur' });
                      }

                      let userEntry;
                      userRes.on('searchEntry', (entry) => (userEntry = entry));

                      userRes.on('end', () => {
                        if (!userEntry) {
                          ldapClient.unbind();
                          adminAuthClient.unbind();
                          return res.status(404).json({ error: 'Utilisateur non trouvé' });
                        }

                        const userDN = userEntry.pojo.objectName;
                        const removeFromGroups = [
                          ldapConfig.adminGroup,
                          ldapConfig.userGroup,
                          ldapConfig.guestGroup,
                        ];

                        const groupClient = ldap.createClient({ url: ldapConfig.url });
                        groupClient.bind(adminDN, adminPassword, (err) => {
                          if (err) {
                            console.error('Erreur bind pour nettoyage groupes');
                            return res.status(500).json({ error: 'Erreur de nettoyage groupes' });
                          }

                          let tasksDone = 0;
                          removeFromGroups.forEach((groupDN) => {
                            const change = new ldap.Change({
                              operation: 'delete',
                              modification: new ldap.Attribute({ type: 'member', values: [userDN] }),
                            });

                            groupClient.modify(groupDN, change, () => {
                              tasksDone++;
                              if (tasksDone === removeFromGroups.length) {
                                adminAuthClient.del(userDN, (err) => {
                                  ldapClient.unbind();
                                  adminAuthClient.unbind();
                                  groupClient.unbind();

                                  if (err) {
                                    console.error('Erreur suppression utilisateur :', err);
                                    return res.status(500).json({ error: 'Erreur suppression utilisateur' });
                                  }

                                  // Trigger sync and start container, then respond
                                  triggerLdapSync()
                                    .catch(() => {})
                                    .finally(() => {
                                      try { startApp('app-rdrive-node-create-user').catch(() => {}); } catch (_) {}
                                      return res.json({ message: `Utilisateur "${uid}" supprimé avec succès` });
                                    });
                                });
                              }
                            });
                          });
                        });
                      });
                    }
                  );
                });
              }
            );
          });
        });
      }
    );
  });
});

// Helper function to trigger LDAP sync via existing endpoint (curl target default 2283)
async function triggerLdapSync() {
  return new Promise((resolve) => {
    const client = require('http');
    const options = {
      hostname: 'localhost',
      port: parseInt(process.env.LDAP_SYNC_PORT || '2283', 10),
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

// PUT /api/update-user — update attributes, password, and role membership
router.put('/update-user', verifyToken, isAdmin, async (req, res) => {
  const { adminUid, adminPassword, targetUid, name, email, role, password } = req.body;

  if (!adminUid || !adminPassword || !targetUid || !name || !email || !role) {
    return res.status(400).json({ error: 'Tous les champs sont requis (adminUid, adminPassword, targetUid, name, email, role)' });
  }

  // Enforce UID immutability
  if (typeof req.body.uid !== 'undefined' && req.body.uid !== targetUid) {
    return res.status(400).json({ error: "Changement d'UID interdit" });
  }
  if (typeof req.body.newUid !== 'undefined' && req.body.newUid !== targetUid) {
    return res.status(400).json({ error: "Changement d'UID interdit" });
  }

  const ldapClient = ldap.createClient({ url: ldapConfig.url });
  let adminAuthClient;

  // Step 1: Bind as service account
  ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
    if (err) {
      console.error('Erreur de connexion LDAP initiale :', err);
      return res.status(500).json({ error: 'Erreur de connexion LDAP initiale' });
    }

    // Step 2: Find admin user DN
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
        adminAuthClient = ldap.createClient({ url: ldapConfig.url });

        // Step 3: Verify admin credentials
        adminAuthClient.bind(adminDN, adminPassword, (err) => {
          if (err) {
            console.error('Échec authentification admin :', err);
            ldapClient.unbind();
            return res.status(401).json({ error: 'Mot de passe admin incorrect' });
          }

          // Step 4: Check admin rights (membership)
          ldapClient.search(ldapConfig.adminGroup, { filter: `(member=${adminDN})`, scope: 'base', attributes: ['cn'] }, (err, groupRes) => {
            let isAdminMember = false;
            groupRes.on('searchEntry', () => (isAdminMember = true));
            groupRes.on('end', () => {
              if (!isAdminMember) {
                ldapClient.unbind();
                adminAuthClient.unbind();
                return res.status(403).json({ error: 'Accès refusé. Droits admin requis.' });
              }

              // Step 5: Find target user
              ldapClient.search(ldapConfig.userSearchBase, { filter: `(uid=${targetUid})`, scope: 'sub', attributes: ['dn', 'uid', 'mail', 'cn', 'sn'] }, (err, userRes) => {
                if (err) {
                  console.error('Erreur recherche utilisateur :', err);
                  return res.status(500).json({ error: 'Erreur recherche utilisateur' });
                }

                let userEntry;
                userRes.on('searchEntry', (entry) => (userEntry = entry));
                userRes.on('end', () => {
                  if (!userEntry) {
                    ldapClient.unbind();
                    adminAuthClient.unbind();
                    return res.status(404).json({ error: 'Utilisateur non trouvé' });
                  }

                  let userDN = userEntry.pojo.objectName;
                  const currentMail = userEntry.pojo.attributes.find((a) => a.type === 'mail')?.values[0];
                  const currentCn = userEntry.pojo.attributes.find((a) => a.type === 'cn')?.values[0];
                  const currentSn = userEntry.pojo.attributes.find((a) => a.type === 'sn')?.values[0];

                  // Check email uniqueness
                  const proceedUpdate = () => updateUser();
                  if (email !== currentMail) {
                    ldapClient.search(ldapConfig.userSearchBase, { filter: `(&(mail=${email})(!(uid=${targetUid})))`, scope: 'sub', attributes: ['uid'] }, (err, emailCheckRes) => {
                      if (err) {
                        console.error('Erreur vérification email :', err);
                        return res.status(500).json({ error: 'Erreur vérification email' });
                      }
                      let emailInUse = false;
                      emailCheckRes.on('searchEntry', () => (emailInUse = true));
                      emailCheckRes.on('end', () => {
                        if (emailInUse) {
                          ldapClient.unbind();
                          adminAuthClient.unbind();
                          return res.status(409).json({ error: 'Un utilisateur avec cet email existe déjà' });
                        }
                        proceedUpdate();
                      });
                    });
                  } else {
                    proceedUpdate();
                  }

                  function updateUser() {
                    // Detect RDN attribute and parent DN using centralized helper
                    const { rdnAttr, parentDN } = parseDnParts(userDN);

                    const changes = [];
                    const isCnRdn = rdnAttr === 'cn';
                    const nameChanged = name !== currentCn;

                    if (nameChanged && !isCnRdn) {
                      changes.push(new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'cn', values: [name] }) }));
                    }
                    if (nameChanged) {
                      const lastName = name.split(' ').pop() || name;
                      changes.push(new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'sn', values: [lastName] }) }));
                    }
                    if (email !== currentMail) {
                      changes.push(new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'mail', values: [email] }) }));
                    }
                    if (password) {
                      changes.push(new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'userPassword', values: [password] }) }));
                    }

                    const applyChangesSequentially = () => {
                      const updateNext = (i) => {
                        if (i >= changes.length) return updateGroupMembership();
                        adminAuthClient.modify(userDN, changes[i], (err) => {
                          if (err) {
                            console.error('Erreur mise à jour utilisateur :', err);
                            ldapClient.unbind();
                            adminAuthClient.unbind();
                            return res.status(500).json({ error: 'Erreur lors de la mise à jour du profil utilisateur' });
                          }
                          updateNext(i + 1);
                        });
                      };
                      updateNext(0);
                    };

                    if (isCnRdn && nameChanged) {
                      const newRdn = `cn=${escapeRdnValue(name)}`;
                      adminAuthClient.modifyDN(userDN, newRdn, (err) => {
                        if (err) {
                          console.error('Erreur renommage DN (modifyDN) :', err);
                          ldapClient.unbind();
                          adminAuthClient.unbind();
                          return res.status(500).json({ error: "Erreur de renommage de l'entrée (RDN) lors de la mise à jour du nom" });
                        }
                        userDN = `${newRdn}${parentDN ? ',' + parentDN : ''}`;
                        applyChangesSequentially();
                      });
                    } else {
                      applyChangesSequentially();
                    }

                    function updateGroupMembership() {
                      const roleGroupMap = { 'Admin': ldapConfig.adminGroup, 'User': ldapConfig.userGroup, 'Guest': ldapConfig.guestGroup };
                      const targetGroup = roleGroupMap[role];
                      if (!targetGroup) {
                        ldapClient.unbind();
                        adminAuthClient.unbind();
                        return res.status(400).json({ error: 'Rôle invalide' });
                      }

                      const removeFromGroup = (groupDn, cb) => {
                        if (!groupDn) return cb();
                        const change = new ldap.Change({ operation: 'delete', modification: new ldap.Attribute({ type: 'member', values: [userDN] }) });
                        adminAuthClient.modify(groupDn, change, () => cb());
                      };

                      const groupsToRemove = Object.values(roleGroupMap).filter((g) => g !== targetGroup);
                      const removeNext = (i) => { if (i >= groupsToRemove.length) return addToGroup(targetGroup); removeFromGroup(groupsToRemove[i], () => removeNext(i + 1)); };
                      removeNext(0);

                      function addToGroup(groupDn) {
                        const change = new ldap.Change({ operation: 'add', modification: new ldap.Attribute({ type: 'member', values: [userDN] }) });
                        adminAuthClient.modify(groupDn, change, (err) => {
                          ldapClient.unbind();
                          adminAuthClient.unbind();
                          if (err && err.name !== 'AttributeOrValueExistsError') {
                            console.error('Erreur mise à jour groupe :', err);
                            return res.status(500).json({ error: 'Profil mis à jour, mais erreur de mise à jour du groupe', details: err.message });
                          }
                          triggerLdapSync()
                            .catch(() => {})
                            .finally(() => {
                              try { startApp('app-rdrive-node-create-user').catch(() => {}); } catch (_) {}
                              res.json({ message: `Utilisateur "${targetUid}" mis à jour avec succès`, user: { name, email, role, uid: targetUid } });
                            });
                        });
                      }
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

module.exports = router;
