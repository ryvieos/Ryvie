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
    const balanceCmd = ['sudo', '-n', 'btrfs', 'balance', 'start', '--force', `-dconvert=${raidLevel}`, `-mconvert=${raidLevel}`, `-sconvert=${raidLevel}`, '/data'];
    commands.push({ description: `Convert /data to ${raidLevel.toUpperCase()} (data, metadata, and system)`, command: balanceCmd.join(' ') });
    
    if (!dryRun) {
      log(`Starting balance operation to convert to ${raidLevel}...`, 'info');
      log('Converting data, metadata, and system to RAID...', 'info');
      log('This may take a while depending on the amount of data...', 'warning');
      
      try {
        const result = await executeCommand('sudo', ['-n', 'btrfs', 'balance', 'start', '--force', `-dconvert=${raidLevel}`, `-mconvert=${raidLevel}`, `-sconvert=${raidLevel}`, '/data']);
        log(`Balance completed: ${result.stdout}`, 'success');
      } catch (error) {
        log(`Error during balance: ${error.message}`, 'error');
        throw error;
      }
    }

    // Étape 5: Mise à jour de /etc/fstab pour supporter le mode dégradé
    log('=== Step 5: Updating /etc/fstab for degraded mode support ===', 'step');
    
    if (!dryRun) {
      log('Updating /etc/fstab to add degraded mount option...', 'info');
      try {
        // Lire le fstab actuel
        const catResult = await executeCommand('cat', ['/etc/fstab']);
        const fstabContent = catResult.stdout;
        
        // Chercher la ligne pour /data
        const lines = fstabContent.split('\n');
        let updated = false;
        const newLines = lines.map(line => {
          // Ignorer les commentaires et lignes vides
          if (line.trim().startsWith('#') || line.trim() === '') {
            return line;
          }
          
          // Chercher la ligne qui monte /data
          const parts = line.split(/\s+/);
          if (parts.length >= 4 && parts[1] === '/data' && parts[2] === 'btrfs') {
            // Extraire les options actuelles
            let options = parts[3].split(',');
            
            // Ajouter 'degraded' si pas déjà présent
            if (!options.includes('degraded')) {
              options.push('degraded');
              log('Adding degraded option to mount options', 'info');
            }
            
            // Reconstruire la ligne
            parts[3] = options.join(',');
            updated = true;
            return parts.join('\t');
          }
          return line;
        });
        
        if (updated) {
          // Écrire le nouveau fstab
          const newFstabContent = newLines.join('\n');
          const fs = require('fs');
          const tmpFile = '/tmp/fstab.new';
          
          // Écrire dans un fichier temporaire
          fs.writeFileSync(tmpFile, newFstabContent);
          
          // Copier avec sudo
          await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/fstab']);
          
          // Nettoyer
          fs.unlinkSync(tmpFile);
          
          log('Successfully updated /etc/fstab with degraded option', 'success');
          log('The system will now be able to boot even if one RAID disk is missing', 'info');
        } else {
          log('No /data entry found in /etc/fstab to update', 'warning');
        }
      } catch (error) {
        log(`Warning: Could not update /etc/fstab: ${error.message}`, 'warning');
        log('You may need to manually add "degraded" to mount options in /etc/fstab', 'warning');
      }
    } else {
      commands.push({ 
        description: 'Update /etc/fstab to add degraded mount option for /data', 
        command: 'Edit /etc/fstab and add "degraded" to the mount options for /data' 
      });
    }
    
    // Étape 6: Contrôles finaux
    log('=== Step 6: Final checks ===', 'step');
    
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
 * POST /api/storage/btrfs-fix-raid-profiles
 * Corrige les profils mixtes (single/dup/raid1) en convertissant tout en RAID
 * Utile quand un balance n'a pas complètement converti le filesystem
 */
router.post('/storage/btrfs-fix-raid-profiles', authenticateToken, async (req, res) => {
  try {
    const { raidLevel = 'raid1' } = req.body;
    
    // Valider le niveau RAID
    const validRaidLevels = ['raid1', 'raid1c3', 'raid10'];
    if (!validRaidLevels.includes(raidLevel)) {
      return res.status(400).json({
        success: false,
        error: `Invalid RAID level: ${raidLevel}`
      });
    }

    const logs = [];
    const log = (message, type = 'info') => {
      const logEntry = { timestamp: new Date().toISOString(), type, message };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    log('Fixing mixed RAID profiles...', 'info');
    log(`Target RAID level: ${raidLevel.toUpperCase()}`, 'info');

    // Vérifier l'état actuel
    try {
      const dfResult = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'df', '/data']);
      log(`Current state:\n${dfResult.stdout}`, 'info');
    } catch (error) {
      log(`Warning: Could not check current state: ${error.message}`, 'warning');
    }

    // Lancer le balance complet avec conversion de data, metadata et system
    log('Starting full balance to convert all profiles to RAID...', 'info');
    log('This will convert data, metadata, and system to RAID...', 'info');
    log('This may take several minutes depending on data size...', 'warning');

    try {
      const result = await executeCommand('sudo', [
        '-n', 'btrfs', 'balance', 'start',
        `-dconvert=${raidLevel}`,
        `-mconvert=${raidLevel}`,
        `-sconvert=${raidLevel}`,
        '/data'
      ]);
      log(`Balance completed successfully`, 'success');
      log(`Output: ${result.stdout}`, 'info');
      if (result.stderr) {
        log(`Stderr: ${result.stderr}`, 'warning');
      }
    } catch (error) {
      log(`Error during balance: ${error.message}`, 'error');
      return res.status(500).json({
        success: false,
        error: 'Balance operation failed',
        details: error.message,
        logs
      });
    }

    // Vérifier l'état final
    try {
      const dfResult = await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'df', '/data']);
      log(`Final state:\n${dfResult.stdout}`, 'success');
      
      // Vérifier s'il reste des profils mixtes
      if (dfResult.stdout.includes('single') || dfResult.stdout.includes('DUP')) {
        log('Warning: Some single or DUP profiles may still exist', 'warning');
        log('You may need to run the balance again or check for errors', 'warning');
      } else {
        log('All profiles successfully converted to RAID!', 'success');
      }
    } catch (error) {
      log(`Warning: Could not verify final state: ${error.message}`, 'warning');
    }

    res.json({
      success: true,
      message: 'RAID profile conversion completed',
      logs
    });
  } catch (error) {
    console.error('Error fixing RAID profiles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fix RAID profiles',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/btrfs-enable-degraded
 * Active le mode dégradé dans /etc/fstab pour /data
 * Permet au système de démarrer même si un disque du RAID est manquant
 */
router.post('/storage/btrfs-enable-degraded', authenticateToken, async (req, res) => {
  try {
    const logs = [];
    const log = (message, type = 'info') => {
      const logEntry = { timestamp: new Date().toISOString(), type, message };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    log('Updating /etc/fstab to enable degraded mode for /data', 'info');

    // Lire le fstab actuel
    const catResult = await executeCommand('cat', ['/etc/fstab']);
    const fstabContent = catResult.stdout;
    
    // Chercher la ligne pour /data
    const lines = fstabContent.split('\n');
    let updated = false;
    const newLines = lines.map(line => {
      // Ignorer les commentaires et lignes vides
      if (line.trim().startsWith('#') || line.trim() === '') {
        return line;
      }
      
      // Chercher la ligne qui monte /data
      const parts = line.split(/\s+/);
      if (parts.length >= 4 && parts[1] === '/data' && parts[2] === 'btrfs') {
        // Extraire les options actuelles
        let options = parts[3].split(',');
        
        // Ajouter 'degraded' si pas déjà présent
        if (!options.includes('degraded')) {
          options.push('degraded');
          log('Adding degraded option to mount options', 'info');
          updated = true;
        } else {
          log('Degraded option already present', 'info');
        }
        
        // Reconstruire la ligne
        parts[3] = options.join(',');
        return parts.join('\t');
      }
      return line;
    });
    
    if (updated) {
      // Écrire le nouveau fstab
      const newFstabContent = newLines.join('\n');
      const fs = require('fs');
      const tmpFile = '/tmp/fstab.new';
      
      // Écrire dans un fichier temporaire
      fs.writeFileSync(tmpFile, newFstabContent);
      
      // Copier avec sudo
      await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/fstab']);
      
      // Nettoyer
      fs.unlinkSync(tmpFile);
      
      log('Successfully updated /etc/fstab with degraded option', 'success');
      log('The system will now be able to boot even if one RAID disk is missing', 'info');
      
      res.json({
        success: true,
        message: 'Degraded mode enabled in /etc/fstab',
        logs
      });
    } else {
      log('Degraded option already present in /etc/fstab', 'info');
      res.json({
        success: true,
        message: 'Degraded mode already enabled',
        logs
      });
    }
  } catch (error) {
    console.error('Error enabling degraded mode:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to enable degraded mode',
      details: error.message
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

        // Détecter les profils mixtes (single, DUP, RAID)
        // Ignorer GlobalReserve qui est toujours en single et n'est pas important
        const dfOutput = dfResult.stdout;
        const hasSingle = /^(Data|Metadata|System).*single/im.test(dfOutput);
        const hasDup = /^(Data|Metadata|System).*DUP/im.test(dfOutput);
        const hasRaid = /RAID/i.test(dfOutput);
        
        // Si on a à la fois RAID et (single ou DUP) sur Data/Metadata/System, le RAID est incomplet
        status.hasMixedProfiles = hasRaid && (hasSingle || hasDup);
        status.isRaidIncomplete = status.hasMixedProfiles;
        
        if (status.hasMixedProfiles) {
          status.mixedProfilesWarning = 'RAID conversion incomplete - mixed profiles detected (single/DUP/RAID)';
          status.needsRebalance = true;
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