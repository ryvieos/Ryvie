const express = require('express');
const ldap = require('ldapjs');
const router = express.Router();
const { verifyToken, isAdmin } = require('../middleware/auth');
const ldapConfig = require('../config/ldap');
const { getRole } = require('../services/ldapService');

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

                                  return res.json({ message: `Utilisateur "${uid}" supprimé avec succès` });
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

module.exports = router;
