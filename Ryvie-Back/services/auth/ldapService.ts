const ldap = require('ldapjs');
const crypto = require('crypto');
const ldapConfig = require('../../config/ldap');
const DEFAULT_EMAIL_DOMAIN = process.env.DEFAULT_EMAIL_DOMAIN || 'localhost';

// Génère un identifiant (uid) stable, opaque et neutre, sans lien avec le nom.
// L'uid sert de clé d'identité immuable (RDN LDAP, SSO, home dir, apps) : il ne
// change jamais, alors que le nom (cn) reste librement modifiable.
function generateOpaqueUid() {
  return 'u' + crypto.randomBytes(5).toString('hex'); // ex: u7f3a9c21b3
}

function createSafeClient(opts: any = {}) {
  const client = ldap.createClient({
    url: ldapConfig.url,
    timeout: 5000,
    connectTimeout: 5000,
    reconnect: false,
    ...opts,
  });
  client.on('error', (err: any) => {
    console.error('[ldap] Client error (handled):', err.code || err.message);
  });
  return client;
}

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
  // Les DN LDAP sont insensibles à la casse : on normalise avant comparaison, sinon une
  // simple différence de casse entre la valeur 'member' du groupe et le DN de l'entrée
  // (ex: cn=Test vs cn=test) fait échouer la correspondance -> rôle 'Unknown'.
  const memberships = (groupMemberships || []).map((m) => String(m).toLowerCase());
  if (memberships.includes(String(ldapConfig.adminGroup).toLowerCase())) return 'Admin';
  if (memberships.includes(String(ldapConfig.userGroup).toLowerCase())) return 'User';
  if (memberships.includes(String(ldapConfig.guestGroup).toLowerCase())) return 'Guest';
  return 'Unknown';
}

// Resolve a user's role by searching for groups that include the user's DN as member
async function getUserRole(userDN) {
  const ldapClient = createSafeClient();
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
  const ldapClient = createSafeClient();
  
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
                    // Indexer par DN normalisé (minuscules) : les DN LDAP sont insensibles
                    // à la casse, alors qu'une clé d'objet JS est sensible à la casse.
                    const key = String(member).toLowerCase();
                    if (!roles[key]) roles[key] = [];
                    roles[key].push(groupEntry.pojo.objectName);
                  });
                });
                groupRes.on('end', () => {
                  const usersWithRoles = ldapUsers.map(user => ({
                    ...user,
                    role: getRole(user.dn, roles[String(user.dn).toLowerCase()] || []),
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
  const ldapClient = createSafeClient();

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
              const attrs: any = {};
              entry.pojo.attributes.forEach((attr: any) => { attrs[attr.type] = attr.values[0]; });
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

const LDAP_COMPOSE_DIR = '/data/config/ldap';

function isLdapRunning(): boolean {
  const { execSync } = require('child_process');
  try {
    const output = execSync(
      'docker ps --filter "name=^openldap$" --filter "status=running" -q',
      { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function startLdap(): void {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const { composeUpWithRecovery } = require('../system/dockerService');
  const composePath = `${LDAP_COMPOSE_DIR}/docker-compose.yml`;
  if (!fs.existsSync(composePath)) {
    console.log('[ldap] ⚠️ docker-compose.yml introuvable, impossible de démarrer LDAP');
    return;
  }
  console.log('[ldap] 🚀 Démarrage d\'OpenLDAP...');
  const cmd = `docker compose -f "${composePath}" up -d`;
  try {
    composeUpWithRecovery(cmd, { cwd: LDAP_COMPOSE_DIR, timeout: 120000, label: 'ldap' });
    console.log('[ldap] ✅ OpenLDAP démarré');
  } catch (err: any) {
    console.error('[ldap] ❌ Erreur lors du démarrage d\'OpenLDAP:', err.message);
  }
}

async function ensureLdapRunning(): Promise<{ success: boolean; alreadyRunning?: boolean; started?: boolean; error?: string }> {
  try {
    console.log('[ldap] 🔍 Vérification d\'OpenLDAP...');

    let wasStarted = false;
    if (!isLdapRunning()) {
      startLdap();
      wasStarted = true;
    } else {
      console.log('[ldap] ✅ OpenLDAP déjà en cours d\'exécution');
    }

    return { success: true, alreadyRunning: !wasStarted, started: wasStarted };
  } catch (err: any) {
    console.error('[ldap] ❌ Erreur lors du setup LDAP:', err.message);
    return { success: false, error: err.message };
  }
}

export = {
  createSafeClient,
  escapeLdapFilterValue,
  escapeRdnValue,
  generateOpaqueUid,
  parseDnParts,
  getRole,
  getUserRole,
  listUsersWithRoles,
  listUsersPublic,
  ensureLdapRunning,
};
