const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { authenticateToken } = require('../middleware/auth');

/**
 * Utilitaire pour exécuter une commande shell et retourner le résultat
 * @param {string} command - La commande à exécuter
 * @param {Array} args - Les arguments de la commande
 * @param {boolean} streamLogs - Si true, envoie les logs en temps réel
 * @param {Function} onLog - Callback pour les logs en temps réel
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function executeCommand(command, args = [], streamLogs = false, onLog = null) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (streamLogs && onLog) {
        onLog({ type: 'stdout', text });
      }
    });

    process.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (streamLogs && onLog) {
        onLog({ type: 'stderr', text });
      }
    });

    process.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    process.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Valide qu'un chemin de device est sécurisé
 * @param {string} devicePath - Le chemin du device à valider
 * @returns {boolean}
 */
function isValidDevicePath(devicePath) {
  // Accepter uniquement les devices standards: /dev/sdX, /dev/nvmeXnY, /dev/vdX
  const validPattern = /^\/dev\/(sd[a-z]+\d*|nvme\d+n\d+p?\d*|vd[a-z]+\d*)$/;
  return validPattern.test(devicePath);
}

/**
 * GET /api/storage/inventory
 * Récupère l'inventaire complet des devices et points de montage
 */
router.get('/storage/inventory', authenticateToken, async (req, res) => {
  try {
    // Exécuter les commandes d'inventaire en parallèle
    const [lsblkResult, findmntResult, blkidResult] = await Promise.all([
      executeCommand('lsblk', ['-J', '-O']),
      executeCommand('findmnt', ['-J']),
      executeCommand('sudo', ['-n', 'blkid'])
    ]);

    // Parser les résultats JSON
    let lsblkData = {};
    let findmntData = {};
    
    try {
      lsblkData = JSON.parse(lsblkResult.stdout);
    } catch (e) {
      console.error('Error parsing lsblk output:', e);
    }

    try {
      findmntData = JSON.parse(findmntResult.stdout);
    } catch (e) {
      console.error('Error parsing findmnt output:', e);
    }

    res.json({
      success: true,
      data: {
        devices: lsblkData,
        mountpoints: findmntData,
        blkid: blkidResult.stdout,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error fetching storage inventory:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch storage inventory',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/btrfs-prechecks
 * Effectue les pré-vérifications avant la création du RAID
 * Body: { source: string, targets: string[] }
 */
router.post('/storage/btrfs-prechecks', authenticateToken, async (req, res) => {
  try {
    const { source, targets } = req.body;

    // Validation des entrées
    if (!source || !isValidDevicePath(source)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid source device path'
      });
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one target device is required'
      });
    }

    for (const target of targets) {
      if (!isValidDevicePath(target)) {
        return res.status(400).json({
          success: false,
          error: `Invalid target device path: ${target}`
        });
      }
    }

    const checks = {
      source: {},
      targets: [],
      warnings: [],
      errors: []
    };

    // Vérifier que /data est monté et est Btrfs
    const findmntDataResult = await executeCommand('findmnt', ['-no', 'FSTYPE,SOURCE', '/data']);
    const findmntOutput = findmntDataResult.stdout.trim().split(/\s+/);
    
    if (findmntOutput.length < 2) {
      checks.errors.push('/data is not mounted');
    } else {
      const [fstype, mountedSource] = findmntOutput;
      checks.source.fstype = fstype;
      checks.source.mountedSource = mountedSource;
      
      if (fstype !== 'btrfs') {
        checks.errors.push(`/data is not Btrfs (current: ${fstype})`);
      }
      
      if (mountedSource !== source) {
        checks.warnings.push(`Source device mismatch: expected ${source}, mounted ${mountedSource}`);
      }
    }

    // Vérifier l'état actuel du filesystem Btrfs
    try {
      await executeCommand('sudo', ['-n', 'btrfs', 'device', 'scan']);
      const btrfsShowResult = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'show', '/data']);
      checks.source.btrfsShow = btrfsShowResult.stdout;

      const btrfsDfResult = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'df', '/data']);
      checks.source.btrfsDf = btrfsDfResult.stdout;
    } catch (error) {
      checks.warnings.push('Could not retrieve Btrfs filesystem info');
    }

    // Vérifier chaque cible
    for (const target of targets) {
      const targetCheck = {
        device: target,
        mounted: false,
        mountpoint: null,
        size: null,
        errors: []
      };

      // Vérifier si la cible est montée
      const lsblkMountResult = await executeCommand('lsblk', ['-no', 'MOUNTPOINT', target]);
      const mountpoint = lsblkMountResult.stdout.trim();
      
      if (mountpoint) {
        targetCheck.mounted = true;
        targetCheck.mountpoint = mountpoint;
        targetCheck.errors.push(`Device ${target} is mounted on ${mountpoint}. Must be unmounted first.`);
      }

      // Récupérer la taille de la cible
      const lsblkSizeResult = await executeCommand('lsblk', ['-no', 'SIZE', '-b', target]);
      targetCheck.size = parseInt(lsblkSizeResult.stdout.trim()) || 0;

      checks.targets.push(targetCheck);
    }

    // Vérifier que les cibles ont assez d'espace
    try {
      const dfResult = await executeCommand('df', ['-B1', '/data']);
      const dfLines = dfResult.stdout.trim().split('\n');
      if (dfLines.length > 1) {
        const dfParts = dfLines[1].split(/\s+/);
        const usedBytes = parseInt(dfParts[2]) || 0;
        
        for (const targetCheck of checks.targets) {
          if (targetCheck.size > 0 && targetCheck.size < usedBytes) {
            targetCheck.errors.push(`Device ${targetCheck.device} is too small (${targetCheck.size} bytes) for current data usage (${usedBytes} bytes)`);
          }
        }
      }
    } catch (error) {
      checks.warnings.push('Could not verify target sizes');
    }

    // Collecter toutes les erreurs
    checks.targets.forEach(t => {
      if (t.errors.length > 0) {
        checks.errors.push(...t.errors);
      }
    });

    res.json({
      success: checks.errors.length === 0,
      checks,
      canProceed: checks.errors.length === 0
    });
  } catch (error) {
    console.error('Error during Btrfs pre-checks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform pre-checks',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/btrfs-raid-create
 * Crée le RAID Btrfs en exécutant la séquence de commandes
 * Body: { source: string, targets: Array<{device: string, label: string}>, dryRun: boolean, raidLevel: string }
 */
router.post('/storage/btrfs-raid-create', authenticateToken, async (req, res) => {
  try {
    const { source, targets, dryRun = false, raidLevel = 'raid1' } = req.body;

    // Validation des entrées
    if (!source || !isValidDevicePath(source)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid source device path'
      });
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one target device is required'
      });
    }

    for (const target of targets) {
      if (!target.device || !isValidDevicePath(target.device)) {
        return res.status(400).json({
          success: false,
          error: `Invalid target device: ${target.device}`
        });
      }
      if (!target.label || !/^[A-Za-z0-9_-]+$/.test(target.label)) {
        return res.status(400).json({
          success: false,
          error: `Invalid label for ${target.device}: ${target.label}`
        });
      }
    }

    // Valider le niveau RAID
    const validRaidLevels = ['raid1', 'raid1c3', 'raid10'];
    if (!validRaidLevels.includes(raidLevel)) {
      return res.status(400).json({
        success: false,
        error: `Invalid RAID level: ${raidLevel}`
      });
    }

    const logs = [];
    const commands = [];

    // Fonction pour logger
    const log = (message, type = 'info') => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        type,
        message
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    log('Starting Btrfs RAID creation process', 'info');
    log(`Source: ${source}`, 'info');
    log(`Targets: ${targets.map(t => `${t.device} (${t.label})`).join(', ')}`, 'info');
    log(`RAID Level: ${raidLevel}`, 'info');
    log(`Dry Run: ${dryRun}`, 'info');

    // Étape 1: Préparation et formatage des cibles
    log('=== Step 1: Preparing and formatting target devices ===', 'step');
    
    for (const target of targets) {
      const { device, label } = target;
      
      // Commande wipefs
      const wipefsCmd = ['sudo', '-n', 'wipefs', '-a', device];
      commands.push({ description: `Wipe filesystem signatures on ${device}`, command: wipefsCmd.join(' ') });
      
      if (!dryRun) {
        log(`Wiping ${device}...`, 'info');
        try {
          const result = await executeCommand('sudo', ['-n', 'wipefs', '-a', device]);
          log(`Wiped ${device}: ${result.stdout}`, 'success');
        } catch (error) {
          log(`Error wiping ${device}: ${error.message}`, 'error');
          throw error;
        }
      }

      // Commande mkfs.btrfs
      const mkfsCmd = ['sudo', '-n', 'mkfs.btrfs', '-L', label, device];
      commands.push({ description: `Format ${device} as Btrfs with label ${label}`, command: mkfsCmd.join(' ') });
      
      if (!dryRun) {
        log(`Formatting ${device} as Btrfs with label ${label}...`, 'info');
        try {
          const result = await executeCommand('sudo', ['-n', 'mkfs.btrfs', '-L', label, device]);
          log(`Formatted ${device}: ${result.stdout}`, 'success');
        } catch (error) {
          log(`Error formatting ${device}: ${error.message}`, 'error');
          throw error;
        }
      }
    }

    // Étape 2: Scanner les devices Btrfs
    log('=== Step 2: Scanning Btrfs devices ===', 'step');
    const scanCmd = ['sudo', '-n', 'btrfs', 'device', 'scan'];
    commands.push({ description: 'Scan Btrfs devices', command: scanCmd.join(' ') });
    
    if (!dryRun) {
      try {
        const result = await executeCommand('sudo', ['-n', 'btrfs', 'device', 'scan']);
        log(`Scanned devices: ${result.stdout}`, 'success');
      } catch (error) {
        log(`Error scanning devices: ${error.message}`, 'error');
        throw error;
      }
    }

    // Étape 3: Ajouter les cibles au filesystem
    log('=== Step 3: Adding target devices to /data filesystem ===', 'step');
    
    for (const target of targets) {
      const { device } = target;
      const addCmd = ['sudo', '-n', 'btrfs', 'device', 'add', '-f', device, '/data'];
      commands.push({ description: `Add ${device} to /data filesystem`, command: addCmd.join(' ') });
      
      if (!dryRun) {
        log(`Adding ${device} to /data...`, 'info');
        try {
          const result = await executeCommand('sudo', ['-n', 'btrfs', 'device', 'add', '-f', device, '/data']);
          log(`Added ${device}: ${result.stdout}`, 'success');
        } catch (error) {
          log(`Error adding ${device}: ${error.message}`, 'error');
          throw error;
        }
      }
    }

    // Vérification intermédiaire
    if (!dryRun) {
      log('Verifying filesystem after adding devices...', 'info');
      try {
        const result = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'show', '/data']);
        log(`Filesystem status:\n${result.stdout}`, 'info');
      } catch (error) {
        log(`Warning: Could not verify filesystem: ${error.message}`, 'warning');
      }
    }

    // Étape 4: Conversion en RAID
    log(`=== Step 4: Converting to ${raidLevel.toUpperCase()} ===`, 'step');
    const balanceCmd = ['sudo', '-n', 'btrfs', 'balance', 'start', `-dconvert=${raidLevel}`, `-mconvert=${raidLevel}`, '/data'];
    commands.push({ description: `Convert /data to ${raidLevel.toUpperCase()}`, command: balanceCmd.join(' ') });
    
    if (!dryRun) {
      log(`Starting balance operation to convert to ${raidLevel}...`, 'info');
      log('This may take a while depending on the amount of data...', 'warning');
      
      try {
        const result = await executeCommand('sudo', ['-n', 'btrfs', 'balance', 'start', `-dconvert=${raidLevel}`, `-mconvert=${raidLevel}`, '/data']);
        log(`Balance completed: ${result.stdout}`, 'success');
      } catch (error) {
        log(`Error during balance: ${error.message}`, 'error');
        throw error;
      }
    }

    // Étape 5: Contrôles finaux
    log('=== Step 5: Final checks ===', 'step');
    
    const finalChecks = [
      { cmd: ['sudo', '-n', 'btrfs', 'filesystem', 'df', '/data'], desc: 'Filesystem space usage' },
      { cmd: ['sudo', '-n', 'btrfs', 'filesystem', 'show', '/data'], desc: 'Filesystem devices' },
      { cmd: ['sudo', '-n', 'btrfs', 'device', 'usage', '/data'], desc: 'Device usage breakdown' }
    ];

    for (const check of finalChecks) {
      commands.push({ description: check.desc, command: check.cmd.join(' ') });
      
      if (!dryRun) {
        try {
          const result = await executeCommand('sudo', check.cmd.slice(1));
          log(`${check.desc}:\n${result.stdout}`, 'info');
        } catch (error) {
          log(`Warning: Could not run ${check.desc}: ${error.message}`, 'warning');
        }
      }
    }

    log('=== Btrfs RAID creation process completed successfully ===', 'success');

    res.json({
      success: true,
      dryRun,
      commands,
      logs,
      message: dryRun ? 'Dry run completed - no changes made' : 'RAID creation completed successfully'
    });
  } catch (error) {
    console.error('Error creating Btrfs RAID:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create Btrfs RAID',
      details: error.message,
      logs: req.body.logs || []
    });
  }
});

/**
 * GET /api/storage/btrfs-status
 * Récupère l'état actuel du RAID Btrfs sur /data
 */
router.get('/storage/btrfs-status', authenticateToken, async (req, res) => {
  try {
    const status = {};

    // Vérifier si /data est monté
    const findmntResult = await executeCommand('findmnt', ['-no', 'FSTYPE,SOURCE', '/data']);
    const findmntOutput = findmntResult.stdout.trim().split(/\s+/);
    
    if (findmntOutput.length >= 2) {
      status.mounted = true;
      status.fstype = findmntOutput[0];
      status.source = findmntOutput[1];
    } else {
      status.mounted = false;
      return res.json({ success: true, status });
    }

    if (status.fstype === 'btrfs') {
      // Récupérer les informations Btrfs
      try {
        const showResult = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'show', '/data']);
        status.filesystemShow = showResult.stdout;

        const dfResult = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'df', '/data']);
        status.filesystemDf = dfResult.stdout;

        const usageResult = await executeCommand('sudo', ['-n', 'btrfs', 'device', 'usage', '/data']);
        status.deviceUsage = usageResult.stdout;

        // Parser pour détecter le niveau RAID
        const raidMatch = dfResult.stdout.match(/Data,\s*(\w+)/i);
        if (raidMatch) {
          status.raidLevel = raidMatch[1].toLowerCase();
        }
      } catch (error) {
        status.error = `Could not retrieve Btrfs info: ${error.message}`;
      }
    }

    res.json({
      success: true,
      status
    });
  } catch (error) {
    console.error('Error fetching Btrfs status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch Btrfs status',
      details: error.message
    });
  }
});

module.exports = router;