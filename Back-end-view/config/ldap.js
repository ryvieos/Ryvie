module.exports = {
  // LDAP server URL
  url: process.env.LDAP_URL || 'ldap://localhost:389',

  // Read-only bind credentials
  bindDN: process.env.LDAP_BIND_DN || 'cn=read-only,ou=users,dc=example,dc=org',
  bindPassword: process.env.LDAP_BIND_PASSWORD || 'readpassword',

  // Search bases
  userSearchBase: process.env.LDAP_USER_SEARCH_BASE || 'ou=users,dc=example,dc=org',
  groupSearchBase: process.env.LDAP_GROUP_SEARCH_BASE || 'ou=users,dc=example,dc=org',

  // Filters
  userFilter: process.env.LDAP_USER_FILTER || '(objectClass=inetOrgPerson)',
  groupFilter: process.env.LDAP_GROUP_FILTER || '(objectClass=groupOfNames)',

  // Groups DNs
  adminGroup: process.env.LDAP_ADMIN_GROUP || 'cn=admins,ou=users,dc=example,dc=org',
  userGroup: process.env.LDAP_USER_GROUP || 'cn=users,ou=users,dc=example,dc=org',
  guestGroup: process.env.LDAP_GUEST_GROUP || 'cn=guests,ou=users,dc=example,dc=org',
};
