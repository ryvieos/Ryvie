const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { listUsersWithRoles, listUsersPublic } = require('../services/ldapService');

// GET /api/users (secured)
router.get('/users', verifyToken, async (req, res) => {
  try {
    const users = await listUsersWithRoles();
    return res.json(users);
  } catch (e) {
    const msg = e?.message || 'Erreur lors de la récupération des utilisateurs';
    const status = msg.includes('LDAP') ? 500 : 500;
    return res.status(status).json({ error: msg });
  }
});

// GET /api/users-public (public for login page)
router.get('/users-public', async (req, res) => {
  try {
    const users = await listUsersPublic();
    if (!users || users.length === 0) {
      return res.status(404).json({ error: 'Aucun utilisateur trouvé' });
    }
    return res.json(users);
  } catch (e) {
    const msg = e?.message || 'Erreur de recherche LDAP';
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
