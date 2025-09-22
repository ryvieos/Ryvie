const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');

function notImplemented(res, info = {}) {
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    ...info,
  });
}

// Storage API - Step 0 skeleton: all endpoints return 501 Not Implemented
// Base: /api/storage

// GET /api/storage/disks
router.get('/storage/disks', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'GET /storage/disks' });
});

// POST /api/storage/proposal
router.post('/storage/proposal', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/proposal' });
});

// POST /api/storage/preflight
router.post('/storage/preflight', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/preflight' });
});

// POST /api/storage/raid/partition
router.post('/storage/raid/partition', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/raid/partition' });
});

// POST /api/storage/raid/mdadm
router.post('/storage/raid/mdadm', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/raid/mdadm' });
});

// POST /api/storage/raid/persist
router.post('/storage/raid/persist', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/raid/persist' });
});

// POST /api/storage/raid/lvm
router.post('/storage/raid/lvm', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/raid/lvm' });
});

// POST /api/storage/fs/format
router.post('/storage/fs/format', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/fs/format' });
});

// POST /api/storage/fs/mount
router.post('/storage/fs/mount', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/fs/mount' });
});

// POST /api/storage/btrfs/subvolumes
router.post('/storage/btrfs/subvolumes', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'POST /storage/btrfs/subvolumes' });
});

// GET /api/storage/raid/status
router.get('/storage/raid/status', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'GET /storage/raid/status' });
});

// (Optional) GET /api/wizard/state
router.get('/wizard/state', verifyToken, (req, res) => {
  return notImplemented(res, { endpoint: 'GET /wizard/state' });
});

module.exports = router;
