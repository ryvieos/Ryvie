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
  const { execFileSync } = require('child_process');
  const forceGoRun = process.env.RYVIE_STORAGE_USE_GORUN !== '0'; // default: use go run
  const binPath = path.join(cliCwd, process.platform === 'win32' ? 'ryvie-storage.exe' : 'ryvie-storage');

  // Detect if 'go' is actually available
  let goAvailable = false;
  try {
    const goCmd = resolveGoCmd();
    execFileSync(goCmd, ['version'], { stdio: 'ignore' });
    goAvailable = true;
  } catch (_) {
    goAvailable = false;
  }

  // Prefer go run only if go is available and not explicitly disabled
  if (forceGoRun && goAvailable) {
    const cmd = resolveGoCmd();
    const args = ['run', 'main.go'];
    return { cmd, args };
  }

  // Otherwise, use compiled binary if present
  if (fs.existsSync(binPath)) {
    return { cmd: binPath, args: [] };
  }

  // Last resort: try go run even if go may not be available (will error clearly)
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
      if (!data || typeof data !== 'object') {
        throw new Error('invalid_response');
      }
      const disks = Array.isArray(data.disks) ? data.disks : [];

      // Resolve /data device using findmnt, normalize UUID/PARTUUID with blkid
      const { execFileSync } = require('child_process');
      let dataDev = '';
      try {
        const src = String(execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/data'], { timeout: 3000 })).trim();
        if (src.startsWith('UUID=')) {
          const uuid = src.slice('UUID='.length);
          try {
            dataDev = String(execFileSync('blkid', ['-U', uuid], { timeout: 3000 })).trim();
          } catch {}
        } else if (src.startsWith('PARTUUID=')) {
          const pu = src.slice('PARTUUID='.length);
          try {
            dataDev = String(execFileSync('blkid', ['-t', `PARTUUID=${pu}`, '-o', 'device'], { timeout: 3000 })).trim();
          } catch {}
        } else {
          dataDev = src;
        }
      } catch {}

      // Recompute system disk: findmnt / -> resolve device and base disk name (e.g., /dev/sda1 -> /dev/sda)
      let rootBase = '';
      let rootDev = '';
      try {
        const src = String(execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/'], { timeout: 3000 })).trim();
        let dev = src;
        if (src.startsWith('UUID=')) {
          const uuid = src.slice('UUID='.length);
          try { dev = String(execFileSync('blkid', ['-U', uuid], { timeout: 3000 })).trim(); } catch {}
        } else if (src.startsWith('PARTUUID=')) {
          const pu = src.slice('PARTUUID='.length);
          try { dev = String(execFileSync('blkid', ['-t', `PARTUUID=${pu}`, '-o', 'device'], { timeout: 3000 })).trim(); } catch {}
        }
        rootDev = dev;
        // Map /dev/sda6 -> /dev/sda, /dev/nvme0n1p2 -> /dev/nvme0n1
        const base = dev.replace(/^.*\//, '');
        if (base.startsWith('nvme')) {
          const i = base.lastIndexOf('p');
          rootBase = `/dev/${i > 0 ? base.slice(0, i) : base}`;
        } else {
          rootBase = `/dev/${base.replace(/[0-9]+$/, '')}`;
        }
      } catch {}

      // Helper to humanize bytes
      const humanize = (b) => {
        const unit = 1024;
        if (!b || b < unit) return `${b|0} B`;
        const exp = Math.floor(Math.log(b) / Math.log(unit));
        const pre = 'KMGTPE'.charAt(exp - 1);
        const val = (b / Math.pow(unit, exp)).toFixed(1);
        return `${val} ${pre}B`;
      };

      const lifted = [];
      const out = disks.map(d => {
        const parts = Array.isArray(d.partitions) ? d.partitions : [];
        const keep = [];
        for (const p of parts) {
          const isDataPart = !!dataDev && (p?.path === dataDev || p?.path === `/dev/${dataDev}`);
          const isMountData = p?.mountpoint === '/data';
          if (p && (isDataPart || isMountData)) {
            const devObj = {
              id: p.path,
              device: p.path,
              sizeBytes: Number(p.sizeBytes || 0),
              sizeHuman: undefined,
              type: 'partition',
              isSystem: false,
              isMounted: true,
              mountpoint: '/data',
              health: 'unknown',
              partitions: [],
            };
            devObj.sizeHuman = humanize(devObj.sizeBytes);
            lifted.push(devObj);
          } else {
            keep.push(p);
          }
        }
        // Fix isSystem based on rootBase, exact rootDev match, or mountpoint '/'
        let isSystem = d.isSystem;
        if (rootBase) {
          if (d.id === rootBase || `/dev/${d.device}` === rootBase) {
            isSystem = true;
          }
        }
        if (!isSystem && rootDev) {
          // If any remaining partition exactly equals rootDev, mark as system
          if (keep.some(p => p?.path === rootDev)) {
            isSystem = true;
          }
        }
        // If disk itself shows mountpoint '/', also mark as system
        if (!isSystem && (d.mountpoint === '/')) {
          isSystem = true;
        }
        // Recompute disk size as sum of remaining partitions
        const sum = keep.reduce((acc, p) => acc + Number(p.sizeBytes || 0), 0);
        const sizeBytes = sum > 0 ? sum : Number(d.sizeBytes || 0);
        const sizeHuman = humanize(sizeBytes);
        return { ...d, isSystem, partitions: keep, sizeBytes, sizeHuman };
      });
      const response = { ...data, disks: [...lifted, ...out] };
      return res.json(response);
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
  const body = req.body || {};
  const sourcePart = body.sourcePartitionId;
  const targetPart = body.targetPartitionId;

  // New draft contract: { sourcePartitionId, targetPartitionId }
  if (typeof sourcePart === 'string' && typeof targetPart === 'string') {
    // Compute proposal in read-only mode from a fresh scan
    const cliCwd = path.resolve(__dirname, '..', '..', 'ryvie-storage');
    const { cmd, args: baseArgs } = resolveCliInvocation(cliCwd);
    const args = [...baseArgs, 'scan'];

    const env = { ...process.env, PATH: `${process.env.PATH || ''}:/snap/bin:/usr/local/go/bin:/usr/bin:/bin` };
    execFile(cmd, args, { cwd: cliCwd, timeout: 20000, env }, (error, stdout) => {
      if (error) {
        return res.status(500).json({ ok: false, error: 'scan_failed', detail: error.message });
      }
      try {
        const data = JSON.parse(stdout || '{}');
        const disks = Array.isArray(data?.disks) ? data.disks : [];

        // Resolve a device identifier to either a partition or a disk
        const normalize = (x) => (x || '').replace(/^\/dev\//, '');
        const eq = (a,b) => normalize(a) === normalize(b);
        const findPart = (needleRaw) => {
          const needle = needleRaw || '';
          for (const d of disks) {
            // Match disk itself
            if (eq(d.id, needle) || eq(d.device, needle)) {
              return { d, p: null, path: `/dev/${normalize(d.device)}`, sizeBytes: Number(d.sizeBytes||0) };
            }
            // Match partitions
            for (const p of (d.partitions || [])) {
              if (eq(p.path, needle)) {
                return { d, p, path: p.path, sizeBytes: Number(p.sizeBytes||0) };
              }
            }
          }
          return null;
        };

        const s = findPart(sourcePart);
        const t = findPart(targetPart);
        if (!s || !t) {
          return res.status(400).json({ ok: false, error: 'partition_not_found' });
        }

        // Validations per Step 2 (dry-run)
        const short = (devPath) => (devPath || '').replace(/^.*\//, '');
        if (short(s.path) === short(t.path)) {
          return res.status(400).json({ ok: false, error: 'same_source_and_target' });
        }
        // Source must be /data: use scan mountpoint if available, otherwise resolve /data device with findmnt/blkid
        let sMountedData = (s.p?.mountpoint === '/data') || (s.d?.mountpoint === '/data');
        if (!sMountedData) {
          try {
            const { execFileSync } = require('child_process');
            let dataDev = String(execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/data'], { timeout: 3000 })).trim();
            if (dataDev.startsWith('UUID=')) {
              const uuid = dataDev.slice('UUID='.length);
              try { dataDev = String(execFileSync('blkid', ['-U', uuid], { timeout: 3000 })).trim(); } catch {}
            } else if (dataDev.startsWith('PARTUUID=')) {
              const pu = dataDev.slice('PARTUUID='.length);
              try { dataDev = String(execFileSync('blkid', ['-t', `PARTUUID=${pu}`, '-o', 'device'], { timeout: 3000 })).trim(); } catch {}
            }
            if (dataDev) {
              sMountedData = (s.p?.path === dataDev) || (s.p?.path === `/dev/${dataDev}`) || (short(s.p?.path) === short(dataDev));
            }
          } catch {}
        }
        if (!sMountedData) {
          return res.status(400).json({ ok: false, error: 'source_not_/data_mounted' });
        }
        // Target must be non-mounted and non-system
        // Consider disk mounted if any child partition is mounted
        let tMounted = t.d?.isMounted || !!t.p?.mountpoint;
        if (!tMounted && t.d && Array.isArray(t.d.partitions)) {
          tMounted = t.d.partitions.some(pp => !!pp?.mountpoint);
        }
        if (!tMounted) {
          // Fallback: check with findmnt if target is mounted anywhere
          try {
            const { execFileSync } = require('child_process');
            const targetDev = t.p?.path || targetPart;
            const m = String(execFileSync('findmnt', ['-n', '-S', targetDev], { timeout: 3000 })).trim();
            if (m) tMounted = true;
          } catch {}
        }
        if (tMounted) {
          return res.status(400).json({ ok: false, error: 'target_is_mounted' });
        }
        if (t.d?.isSystem) {
          return res.status(400).json({ ok: false, error: 'target_is_system_disk' });
        }

        const sizeS = Number(s.p?.sizeBytes || s.sizeBytes || 0);
        const sizeT = Number(t.p?.sizeBytes || t.sizeBytes || 0);
        const capacityBytes = Math.min(sizeS, sizeT);

        const planPreview = [
          `Formater ${short(t.path)} en Btrfs (profil RAID1 dégradé, 1/2)`,
          `Monter le nouveau volume sur /mnt/newdata`,
          `Migrer les données de ${short(s.path)} → /mnt/newdata`,
          `Basculer /data → nouveau volume Btrfs`,
          `Ajouter ${short(s.path)} au pool et lancer une balance (-dconvert=raid1 -mconvert=raid1)`
        ];

        const selection = {
          source: {
            id: s.path,
            short: short(s.path),
            mountpoint: (s.p?.mountpoint || s.d?.mountpoint || ''),
            sizeBytes: sizeS
          },
          target: {
            id: t.path,
            short: short(t.path),
            mountpoint: (t.p?.mountpoint || t.d?.mountpoint || ''),
            sizeBytes: sizeT
          }
        };

        return res.json({
          level: 'raid1',
          fs: 'btrfs',
          capacityBytes,
          faultTolerance: 1,
          selection,
          planPreview
        });
      } catch (e) {
        return res.status(502).json({ ok: false, error: 'invalid_cli_json', detail: e.message });
      }
    });
    return;
  }

  // Backward compatibility: existing UI sends { diskIds: [...] } -> delegate to CLI
  const cliCwd = path.resolve(__dirname, '..', '..', 'ryvie-storage');
  const { cmd, args: baseArgs } = resolveCliInvocation(cliCwd);
  const bodyStr = JSON.stringify(body);
  const args = [...baseArgs, 'proposal', '--json', bodyStr];

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
  // Read-only validations per Step 3
  const body = req.body || {};
  const sourcePart = body.sourcePartitionId;
  const targetPart = body.targetPartitionId;

  if (typeof sourcePart !== 'string' || typeof targetPart !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_params', detail: 'Expected { sourcePartitionId, targetPartitionId }' });
  }

  const cliCwd = path.resolve(__dirname, '..', '..', 'ryvie-storage');
  const { cmd, args: baseArgs } = resolveCliInvocation(cliCwd);
  const scanArgs = [...baseArgs, 'scan'];

  const env = { ...process.env, PATH: `${process.env.PATH || ''}:/snap/bin:/usr/local/go/bin:/usr/bin:/bin` };
  execFile(cmd, scanArgs, { cwd: cliCwd, timeout: 20000, env }, (error, stdout) => {
    if (error) {
      return res.status(500).json({ ok: false, error: 'scan_failed', detail: error.message });
    }
    try {
      const data = JSON.parse(stdout || '{}');
      const disks = Array.isArray(data?.disks) ? data.disks : [];

      // Resolve disk or partition
      const normalize = (x) => (String(x||'')).replace(/^\/dev\//, '');
      const eq = (a,b) => normalize(a) === normalize(b);
      const findDev = (needleRaw) => {
        const needle = needleRaw || '';
        for (const d of disks) {
          if (eq(d.id, needle) || eq(d.device, needle)) {
            return { d, p: null, path: `/dev/${normalize(d.device)}`, sizeBytes: Number(d.sizeBytes||0) };
          }
          for (const p of (d.partitions || [])) {
            if (eq(p.path, needle)) {
              return { d, p, path: p.path, sizeBytes: Number(p.sizeBytes||0) };
            }
          }
        }
        return null;
      };

      const s = findDev(sourcePart);
      const t = findDev(targetPart);
      if (!s || !t) {
        return res.status(400).json({ ok: false, error: 'partition_not_found' });
      }

      const blockers = [];
      const warnings = [];

      // Exclusion disque/partition système (target must not be system)
      if (t.d?.isSystem) blockers.push('target_is_system_disk');

      // Source mounted on /data? Intended → warning (informational). Use fallback via findmnt/blkid like proposal
      let sourceMounted = (s.p?.mountpoint === '/data') || (s.d?.mountpoint === '/data');
      if (!sourceMounted) {
        try {
          const { execFileSync } = require('child_process');
          let dataDev = String(execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/data'], { timeout: 3000 })).trim();
          if (dataDev.startsWith('UUID=')) {
            const uuid = dataDev.slice('UUID='.length);
            try { dataDev = String(execFileSync('blkid', ['-U', uuid], { timeout: 3000 })).trim(); } catch {}
          } else if (dataDev.startsWith('PARTUUID=')) {
            const pu = dataDev.slice('PARTUUID='.length);
            try { dataDev = String(execFileSync('blkid', ['-t', `PARTUUID=${pu}`, '-o', 'device'], { timeout: 3000 })).trim(); } catch {}
          }
          const short = (devPath) => (String(devPath||'')).replace(/^.*\//, '');
          if (dataDev) {
            sourceMounted = (s.path === dataDev) || (s.path === `/dev/${dataDev}`) || (short(s.path) === short(dataDev));
          }
        } catch {}
      }
      warnings.push(sourceMounted ? 'source_is_mounted_on_/data' : 'source_not_mounted_on_/data');

      // Verify source FS is btrfs (warn if not)
      const srcFs = (s.p?.fs || s.d?.fs || '').toLowerCase();
      if (srcFs && srcFs !== 'btrfs') warnings.push('source_fs_not_btrfs');

      // Target mounted? For simplified Btrfs flow, do not block — warn only
      let targetMounted = t.d?.isMounted || !!t.p?.mountpoint;
      if (!targetMounted && t.d && Array.isArray(t.d.partitions)) {
        targetMounted = t.d.partitions.some(pp => !!pp?.mountpoint);
      }
      if (targetMounted) warnings.push('target_is_mounted');

      // Explicit warning: target will be formatted & erased
      warnings.push('target_will_be_formatted_and_erased');

      // wipefs -n to detect signatures (read-only)
      const targetDev = t.path || targetPart;
      const { execFile: execF } = require('child_process');
      execF('wipefs', ['-n', targetDev], { timeout: 10000 }, (werr, wstdout, wstderr) => {
        if (!werr) {
          const hasSig = String(wstdout || wstderr || '').trim().length > 0;
          if (hasSig) warnings.push('signatures_detected_on_target');
        } else if (werr && werr.code === 'ENOENT') {
          warnings.push('wipefs_not_available');
        }

        // Space check with slack threshold: if slightly smaller (< 64MiB), warn; if significantly smaller, block
        const sizeS = Number(s.p?.sizeBytes || s.sizeBytes || 0);
        const sizeT = Number(t.p?.sizeBytes || t.sizeBytes || 0);
        const slack = 64 * 1024 * 1024; // 64 MiB
        if (sizeT + slack < sizeS) {
          blockers.push('target_smaller_than_source');
        } else if (sizeT < sizeS) {
          warnings.push('target_slightly_smaller_capacity_will_match_smallest');
        }

        // Permissions: read-only step — warn if not root (no hard block at this stage)
        try {
          if (process.getuid && process.getuid() !== 0) warnings.push('not_running_as_root');
        } catch (_) {}

        // EFI /boot/efi: warn if target equals EFI partition
        try {
          const efiSrc = String(require('child_process').execFileSync('findmnt', ['-n', '-o', 'SOURCE', '/boot/efi'], { timeout: 3000 })).trim();
          const same = (x) => x && (x === targetDev || x === `/dev/${targetDev}`);
          if (same(efiSrc)) warnings.push('target_is_efi_partition');
        } catch (_) { /* ignore */ }

        // Migration estimates (very rough): bytes to copy ~ sizeS; time with 120 MiB/s baseline
        const throughput = 120 * 1024 * 1024; // 120 MiB/s
        const estimateSeconds = sizeS > 0 ? Math.ceil(sizeS / throughput) : 0;
        const estimates = { bytes: sizeS, seconds: estimateSeconds };

        return res.json({ ok: blockers.length === 0, warnings, blockers, estimates });
      });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'invalid_cli_json', detail: e.message });
    }
  });
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
