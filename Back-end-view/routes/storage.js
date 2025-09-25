const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { execFile } = require('child_process');
const path = require('path');

function notImplemented(res, info = {}) {
  return res.status(501).json({
    ok: false,
    error: 'not_implemented',
    ...info,
  });
}

// Storage API - Step 0 skeleton: all endpoints return 501 Not Implemented
// Base: /api/storage

// Helper to locate Go binary reliably when running under different environments (snap, apt, etc.)
function resolveGoCmd() {
  const fs = require('fs');
  const candidates = [
    '/snap/bin/go',
    '/usr/local/go/bin/go',
    '/usr/bin/go',
    'go'
  ];
  for (const c of candidates) {
    try {
      if (c === 'go') return c; // let PATH resolve it
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return 'go';
}

function resolveCliInvocation(cliCwd) {
  const fs = require('fs');
  const binPath = path.join(cliCwd, process.platform === 'win32' ? 'ryvie-storage.exe' : 'ryvie-storage');
  if (fs.existsSync(binPath)) {
    return { cmd: binPath, args: [] };
  }
  // Fallback to go run
  const cmd = resolveGoCmd();
  const args = ['run', 'main.go'];
  return { cmd, args };
}

// GET /api/storage/disks — Step 1: proxy CLI scan (read-only)
router.get('/storage/disks', verifyToken, (req, res) => {
  // From Back-end-view/routes -> up to repo root then into ryvie-storage
  const cliCwd = path.resolve(__dirname, '..', '..', 'ryvie-storage');
  const { cmd, args: baseArgs } = resolveCliInvocation(cliCwd);
  const args = [...baseArgs, 'scan'];

  const env = { ...process.env };
  env.PATH = `${env.PATH || ''}:/snap/bin:/usr/local/go/bin:/usr/bin:/bin`;

  execFile(cmd, args, { cwd: cliCwd, timeout: 20000, env }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'scan_failed',
        detail: error.message,
        stderr: String(stderr || ''),
        cwd: cliCwd,
        cmd: `${cmd} ${args.join(' ')}`,
        envPath: env.PATH,
      });
    }
    try {
      const data = JSON.parse(stdout || '{}');
      // Expecting { ok: true, disks: [...] }
      if (!data || typeof data !== 'object') {
        throw new Error('invalid_response');
      }
      return res.json(data);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'invalid_cli_json',
        detail: e.message,
        raw: String(stdout || ''),
      });
    }
  });
});

// POST /api/storage/proposal
router.post('/storage/proposal', verifyToken, (req, res) => {
  const cliCwd = path.resolve(__dirname, '..', '..', 'ryvie-storage');
  const { cmd, args: baseArgs } = resolveCliInvocation(cliCwd);
  const body = JSON.stringify(req.body || {});
  const args = [...baseArgs, 'proposal', '--json', body];

  execFile(cmd, args, { cwd: cliCwd, timeout: 20000 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'proposal_failed',
        detail: error.message,
        stderr: String(stderr || ''),
        cwd: cliCwd,
        cmd: `${cmd} ${args.join(' ')}`,
      });
    }
    try {
      const data = JSON.parse(stdout || '{}');
      return res.json(data);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: 'invalid_cli_json',
        detail: e.message,
        raw: String(stdout || ''),
      });
    }
  });
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
