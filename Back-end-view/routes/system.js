const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getServerInfo } = require('../services/systemService');
const si = require('systeminformation');
const { getLocalIP } = require('../utils/network');

// GET /status (non-authenticated health endpoint)
router.get('/status', (req, res) => {
  res.status(200).json({
    message: 'Server is running',
    serverDetected: false,
    ip: getLocalIP(),
  });
});

// GET /api/server-info
router.get('/server-info', verifyToken, async (req, res) => {
  try {
    const serverInfo = await getServerInfo();
    res.json(serverInfo);
  } catch (error) {
    console.error('Erreur lors de la récupération des informations du serveur :', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération des informations' });
  }
});

// GET /api/disks
router.get('/disks', async (req, res) => {
  try {
    const diskLayout = await si.diskLayout();
    const fsSizes = await si.fsSize();

    const disks = diskLayout.map(d => {
      const totalBytes = d.size;
      const parts = fsSizes.filter(f => f.fs && f.fs.startsWith(d.device));
      const mounted = parts.length > 0;
      let usedBytes, freeBytes;
      if (mounted) {
        usedBytes = parts.reduce((sum, p) => sum + p.used, 0);
        freeBytes = totalBytes - usedBytes;
      } else {
        usedBytes = 0;
        freeBytes = 0;
      }
      return {
        device: d.device,
        size: `${(totalBytes / 1e9).toFixed(1)} GB`,
        used: `${(usedBytes / 1e9).toFixed(1)} GB`,
        free: `${(freeBytes / 1e9).toFixed(1)} GB`,
        mounted,
      };
    });

    const mountedDisks = disks.filter(d => d.mounted);
    const totalSize = mountedDisks.reduce((sum, d) => sum + parseFloat(d.size), 0);
    const totalUsed = mountedDisks.reduce((sum, d) => sum + parseFloat(d.used), 0);
    const totalFree = mountedDisks.reduce((sum, d) => sum + parseFloat(d.free), 0);

    res.json({
      disks,
      total: {
        size: `${totalSize.toFixed(1)} GB`,
        used: `${totalUsed.toFixed(1)} GB`,
        free: `${totalFree.toFixed(1)} GB`,
      },
    });
  } catch (err) {
    console.error('Erreur récupération info disques :', err);
    res.status(500).json({ error: 'Impossible de récupérer les informations de disques' });
  }
});

module.exports = router;
