const ldap = require('ldapjs');
const ldapConfig = require('../config/ldap');
const DEFAULT_EMAIL_DOMAIN = process.env.DEFAULT_EMAIL_DOMAIN || 'localhost';

function escapeLdapFilterValue(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

// Escape a value intended for use in an RDN (e.g., in modifyDN operations)
function escapeRdnValue(val) {
  if (typeof val !== 'string') return val;
  let v = val
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/\+/g, '\\+')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/;/g, '\\;')
    .replace(/=/g, '\\=');
  if (v.startsWith(' ')) v = '\\ ' + v.slice(1);
  if (v.endsWith(' ')) v = v.slice(0, -1) + ' \\';
  return v;
}

// Parse DN into parts: rdn attribute name and parent DN
function parseDnParts(dn) {
  const firstCommaIdx = dn.indexOf(',');
  const rdn = firstCommaIdx > 0 ? dn.substring(0, firstCommaIdx) : dn;
  const parentDN = firstCommaIdx > 0 ? dn.substring(firstCommaIdx + 1) : '';
  const eqIdx = rdn.indexOf('=');
  const rdnAttr = eqIdx > 0 ? rdn.substring(0, eqIdx).toLowerCase() : '';
  return { rdnAttr, parentDN };
}

function getRole(dn, groupMemberships) {
  if (groupMemberships.includes(ldapConfig.adminGroup)) return 'Admin';
  if (groupMemberships.includes(ldapConfig.userGroup)) return 'User';
  if (groupMemberships.includes(ldapConfig.guestGroup)) return 'Guest';
  return 'Unknown';
}

// Resolve a user's role by searching for groups that include the user's DN as member
async function getUserRole(userDN) {
  const ldapClient = ldap.createClient({ url: ldapConfig.url });
  return new Promise((resolve) => {
    ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
      if (err) {
        ldapClient.destroy();
        return resolve('Guest');
      }
      const memberships = [];
      const filter = `(&(objectClass=groupOfNames)(member=${userDN}))`;
      ldapClient.search(
        ldapConfig.groupSearchBase,
        { filter, scope: 'sub', attributes: ['dn'] },
        (err2, res) => {
          if (err2) {
            ldapClient.unbind();
            return resolve('Guest');
          }
          res.on('searchEntry', (entry) => {
            memberships.push(entry.pojo.objectName);
          });
          res.on('end', () => {
            ldapClient.unbind();
            resolve(getRole(userDN, memberships));
          });
        }
      );
    });
  });
}

async function listUsersWithRoles() {
  const ldapClient = ldap.createClient({ url: ldapConfig.url });
  
  return new Promise((resolve, reject) => {
    ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
      if (err) return reject(new Error('Échec de la connexion LDAP'));

      const ldapUsers = [];
      ldapClient.search(
        ldapConfig.userSearchBase,
        { filter: ldapConfig.userFilter, scope: 'sub', attributes: ['cn', 'uid', 'mail', 'dn'] },
        (err, ldapRes) => {
          if (err) return reject(new Error('Erreur de recherche LDAP'));

          ldapRes.on('searchEntry', (entry) => {
            try {
              const cn = entry.pojo.attributes.find(attr => attr.type === 'cn')?.values[0] || 'Nom inconnu';
              const uid = entry.pojo.attributes.find(attr => attr.type === 'uid')?.values[0] || 'UID inconnu';
              const mail = entry.pojo.attributes.find(attr => attr.type === 'mail')?.values[0] || 'Email inconnu';
              const dn = entry.pojo.objectName;
              if (uid !== 'read-only') {
                ldapUsers.push({ dn, name: cn, uid, email: mail });
              }
            } catch (e: any) {
              // ignore malformed entries
            }
          });

          ldapRes.on('end', () => {
            const roles = {};
            ldapClient.search(
              ldapConfig.groupSearchBase,
              { filter: ldapConfig.groupFilter, scope: 'sub', attributes: ['cn', 'member'] },
              (err, groupRes) => {
                if (err) return reject(new Error('Erreur lors de la recherche des groupes LDAP'));
                groupRes.on('searchEntry', (groupEntry) => {
                  const members = groupEntry.pojo.attributes.find(attr => attr.type === 'member')?.values || [];
                  members.forEach((member) => {
                    if (!roles[member]) roles[member] = [];
                    roles[member].push(groupEntry.pojo.objectName);
                  });
                });
                groupRes.on('end', () => {
                  const usersWithRoles = ldapUsers.map(user => ({
                    ...user,
                    role: getRole(user.dn, roles[user.dn] || []),
                  }));
                  ldapClient.unbind();
                  resolve(usersWithRoles);
                });
              }
            );
          });
        }
      );
    });
  });
}

async function listUsersPublic() {
  const ldapClient = ldap.createClient({ url: ldapConfig.url, timeout: 5000, connectTimeout: 5000 });

  return new Promise((resolve, reject) => {
    ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err) => {
      if (err) return reject(new Error('Échec de la connexion LDAP'));

      const ldapUsers = [];
      ldapClient.search(
        ldapConfig.userSearchBase,
        { filter: ldapConfig.userFilter, scope: 'sub', attributes: ['cn', 'uid', 'mail', 'dn'] },
        (err, ldapRes) => {
          if (err) return reject(new Error('Erreur de recherche LDAP'));

          ldapRes.on('searchEntry', (entry) => {
            try {
              const attrs = {};
              entry.pojo.attributes.forEach(attr => { attrs[attr.type] = attr.values[0]; });
              const uid = attrs.uid || attrs.cn;
              if (uid && uid !== 'read-only') {
                ldapUsers.push({
                  uid,
                  name: attrs.cn || uid,
                  email: attrs.mail || `${uid}@${DEFAULT_EMAIL_DOMAIN}`,
                  role: uid === 'jules' ? 'Admin' : 'User',
                });
              }
            } catch (e: any) {}
          });

          ldapRes.on('end', () => {
            ldapClient.unbind();
            resolve(ldapUsers);
          });
        }
      );
    });
  });
}

export = {
  escapeLdapFilterValue,
  escapeRdnValue,
  parseDnParts,
  getRole,
  getUserRole,
  listUsersWithRoles,
  listUsersPublic,
};
