const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { authenticateToken } = require('../middleware/auth');

// Instance Socket.IO pour les logs en temps réel
let io = null;

// Fonction pour initialiser Socket.IO
function setSocketIO(socketIO) {
  io = socketIO;
}

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
 * Vérifie si un device ou ses partitions sont montés
 * @param {string} devicePath - Le chemin du device
 * @returns {Promise<{mounted: boolean, mountpoint: string|null}>}
 */
async function isDeviceMounted(devicePath) {
  try {
    const result = await executeCommand('lsblk', ['-no', 'MOUNTPOINT', devicePath]);
    const mountpoints = result.stdout.trim().split('\n').filter(m => m);
    
    // Vérifier aussi les partitions
    const allResult = await executeCommand('lsblk', ['-no', 'MOUNTPOINT', `${devicePath}*`]);
    const allMountpoints = allResult.stdout.trim().split('\n').filter(m => m);
    
    const mounted = allMountpoints.length > 0;
    const mountpoint = allMountpoints[0] || null;
    
    return { mounted, mountpoint };
  } catch (error) {
    return { mounted: false, mountpoint: null };
  }
}

/**
 * Détermine la prochaine lettre pour le PARTLABEL (md0_b, md0_c, etc.)
 * @param {string} arrayDevice - Le device RAID (ex: /dev/md0)
 * @returns {Promise<string>}
 */
async function getNextPartLabel(arrayDevice) {
  try {
    // Récupérer le nombre de membres actifs
    const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', arrayDevice]);
    const detailOutput = detailResult.stdout;
    
    // Chercher "Active Devices : N"
    const activeMatch = detailOutput.match(/Active Devices\s*:\s*(\d+)/i);
    const activeDevices = activeMatch ? parseInt(activeMatch[1]) : 0;
    
    // La prochaine lettre = chr(96 + activeDevices + 1)
    // 0 membres -> 'a', 1 membre -> 'b', 2 membres -> 'c', etc.
    const nextLetter = String.fromCharCode(97 + activeDevices);
    
    return `md0_${nextLetter}`;
  } catch (error) {
    // Par défaut, commencer à 'b' (le premier membre est supposé être 'a')
    return 'md0_b';
  }
}

/**
 * Obtient la taille requise par membre du RAID (en bytes)
 * @param {string} arrayDevice - Le device RAID (ex: /dev/md0)
 * @returns {Promise<number>} - Taille en bytes
 */
async function getUsedDevSize(arrayDevice) {
  try {
    // Méthode prioritaire: Obtenir la taille du membre actif directement
    const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', arrayDevice]);
    const detailOutput = detailResult.stdout;
    
    const memberMatch = detailOutput.match(/active sync\s+(\/dev\/\S+)/);
    if (memberMatch) {
      const memberDevice = memberMatch[1];
      const lsblkResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', memberDevice]);
      const memberSize = parseInt(lsblkResult.stdout.trim());
      if (memberSize > 0) {
        // Ajouter 256 MiB de marge pour être sûr
        return memberSize + (256 * 1024 * 1024);
      }
    }
    
    // Méthode alternative: Utiliser Array Size
    const arraySizeMatch = detailOutput.match(/Array Size\s*:\s*(\d+)\s*\(/i);
    if (arraySizeMatch) {
      const arraySizeKiB = parseInt(arraySizeMatch[1]);
      // Ajouter 256 MiB de marge
      return (arraySizeKiB * 1024) + (256 * 1024 * 1024);
    }
    
    // Par défaut, retourner une taille minimale
    return 10 * 1024 * 1024 * 1024; // 10 GiB
  } catch (error) {
    console.error('Error getting used dev size:', error);
    return 10 * 1024 * 1024 * 1024; // 10 GiB par défaut
  }
}

/**
 * Détermine le chemin de la partition (gère NVMe vs SATA/SAS)
 * @param {string} diskPath - Le chemin du disque (ex: /dev/sdb ou /dev/nvme0n1)
 * @param {number} partNum - Le numéro de partition
 * @returns {string}
 */
function getPartitionPath(diskPath, partNum) {
  if (diskPath.includes('nvme')) {
    return `${diskPath}p${partNum}`;
  }
  return `${diskPath}${partNum}`;
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
 * POST /api/storage/mdraid-prechecks
 * Effectue les pré-vérifications avant d'ajouter un disque au RAID mdadm
 * Body: { array: string, disk: string }
 */
router.post('/storage/mdraid-prechecks', authenticateToken, async (req, res) => {
  try {
    const { array, disk } = req.body;

    // Validation des entrées
    if (!array || !isValidDevicePath(array.replace('/dev/md', '/dev/sda'))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid array device path'
      });
    }

    if (!disk || !isValidDevicePath(disk)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid disk device path'
      });
    }

    const reasons = [];
    const plan = [];
    let canProceed = true;

    // 1. Vérifier que /data est monté sur /dev/md0 (btrfs)
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'FSTYPE,SOURCE', '/data']);
      const findmntOutput = findmntResult.stdout.trim().split(/\s+/);
      
      if (findmntOutput.length < 2) {
        reasons.push('❌ /data is not mounted');
        canProceed = false;
      } else {
        const [fstype, source] = findmntOutput;
        
        if (fstype !== 'btrfs' || source !== array) {
          reasons.push(`❌ /data must be mounted as btrfs on ${array} (current: ${fstype} on ${source})`);
          canProceed = false;
        } else {
          reasons.push(`✓ /data is mounted on ${array} (btrfs)`);
        }
      }
    } catch (error) {
      reasons.push(`❌ Error checking /data mount: ${error.message}`);
      canProceed = false;
    }

    // 2. Obtenir la taille requise par membre
    let requiredSizeBytes = 0;
    try {
      requiredSizeBytes = await getUsedDevSize(array);
      reasons.push(`✓ Required size per member: ${Math.floor(requiredSizeBytes / 1024 / 1024)} MiB`);
    } catch (error) {
      reasons.push(`⚠ Could not determine required size: ${error.message}`);
    }

    // 3. Vérifier que le disque cible n'est pas monté
    const mountCheck = await isDeviceMounted(disk);
    if (mountCheck.mounted) {
      reasons.push(`❌ Disk ${disk} or its partitions are mounted on ${mountCheck.mountpoint}`);
      canProceed = false;
    } else {
      reasons.push(`✓ Disk ${disk} is not mounted`);
    }

    // 4. Vérifier la taille du disque cible
    let deviceSizeBytes = 0;
    try {
      const lsblkResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', disk]);
      deviceSizeBytes = parseInt(lsblkResult.stdout.trim());
      
      const minRequired = requiredSizeBytes + (4 * 1024 * 1024); // +4 MiB de marge
      if (deviceSizeBytes < minRequired) {
        reasons.push(`❌ Disk ${disk} is too small (${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB < ${Math.floor(minRequired / 1024 / 1024)} MiB required)`);
        canProceed = false;
      } else {
        reasons.push(`✓ Disk ${disk} size: ${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB (sufficient)`);
      }
    } catch (error) {
      reasons.push(`❌ Could not determine disk size: ${error.message}`);
      canProceed = false;
    }

    // 5. Vérifier les superblocs existants
    try {
      const examineResult = await executeCommand('sudo', ['-n', 'mdadm', '--examine', disk]);
      if (examineResult.stdout.includes('Magic')) {
        reasons.push(`⚠ WARNING: Disk ${disk} contains existing mdadm superblock (will be wiped)`);
      }
    } catch (error) {
      // Pas de superbloc trouvé, c'est OK
      reasons.push(`✓ No existing mdadm superblock on ${disk}`);
    }

    // 6. Calculer la taille de partition
    // Utiliser la taille requise directement, avec une petite marge pour l'alignement
    const endBytes = Math.min(requiredSizeBytes, deviceSizeBytes - (2 * 1024 * 1024));
    const endMiB = Math.ceil(endBytes / 1024 / 1024); // Arrondir vers le HAUT

    // 7. Déterminer le prochain PARTLABEL
    const nextPartLabel = await getNextPartLabel(array);
    const newPartitionPath = getPartitionPath(disk, 1);

    // 8. Construire le plan de commandes
    plan.push(`wipefs -a ${disk}`);
    plan.push(`parted -s ${disk} mklabel gpt`);
    plan.push(`parted -s ${disk} mkpart primary 1MiB ${endMiB}MiB`);
    plan.push(`parted -s ${disk} name 1 ${nextPartLabel}`);
    plan.push(`parted -s ${disk} set 1 raid on`);
    plan.push(`partprobe ${disk} && udevadm settle`);
    plan.push(`wipefs -a ${newPartitionPath}`);
    plan.push(`udevadm settle --timeout=10 && sleep 2`);
    plan.push(`mdadm --zero-superblock ${newPartitionPath}`);
    plan.push(`mdadm --add ${array} ${newPartitionPath}`);
    plan.push(`mdadm --detail --scan > /etc/mdadm/mdadm.conf`);
    plan.push(`update-initramfs -u`);

    res.json({
      success: true,
      canProceed,
      reasons,
      plan,
      requiredSizeBytes,
      deviceSizeBytes,
      nextPartLabel,
      newPartitionPath
    });
  } catch (error) {
    console.error('Error during mdraid pre-checks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform pre-checks',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/mdraid-add-disk
 * Ajoute un disque au RAID mdadm /dev/md0
 * Body: { array: string, disk: string, dryRun: boolean }
 */
router.post('/storage/mdraid-add-disk', authenticateToken, async (req, res) => {
  const { array, disk, dryRun = false } = req.body;

  // Initialiser logs en dehors du try pour qu'il soit accessible dans le catch
  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message
    };
    logs.push(logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Envoyer le log en temps réel via Socket.IO
    if (io) {
      io.emit('mdraid-log', logEntry);
    }
  };

  try {
    // Validation des entrées
    if (!array || !isValidDevicePath(array.replace('/dev/md', '/dev/sda'))) {
      return res.status(400).json({
        success: false,
        error: 'Invalid array device path'
      });
    }

    if (!disk || !isValidDevicePath(disk)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid disk device path'
      });
    }

    log('🚀 Starting mdadm RAID disk addition process', 'info');
    log(`Array: ${array}`, 'info');
    log(`Disk: ${disk}`, 'info');
    log(`Dry Run: ${dryRun}`, 'info');

    // Répéter les sanity checks critiques
    log('=== Step 1: Sanity checks ===', 'step');
    
    // Vérifier que /data est monté sur l'array
    const findmntResult = await executeCommand('findmnt', ['-no', 'FSTYPE,SOURCE', '/data']);
    const [fstype, source] = findmntResult.stdout.trim().split(/\s+/);
    
    if (fstype !== 'btrfs' || source !== array) {
      log(`❌ /data must be mounted as btrfs on ${array} (current: ${fstype} on ${source})`, 'error');
      return res.status(400).json({
        success: false,
        error: `/data is not mounted correctly (expected btrfs on ${array}, got ${fstype} on ${source})`,
        logs
      });
    }
    log(`✓ /data is mounted on ${array} (btrfs)`, 'success');

    // Vérifier que le disque n'est pas monté
    const mountCheck = await isDeviceMounted(disk);
    if (mountCheck.mounted) {
      log(`❌ Disk ${disk} is mounted on ${mountCheck.mountpoint}`, 'error');
      return res.status(400).json({
        success: false,
        error: `Disk ${disk} is mounted and cannot be used`,
        logs
      });
    }
    log(`✓ Disk ${disk} is not mounted`, 'success');

    // Obtenir les paramètres
    const requiredSizeBytes = await getUsedDevSize(array);
    const lsblkResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', disk]);
    const deviceSizeBytes = parseInt(lsblkResult.stdout.trim());
    
    // Calculer la taille de partition avec marge minimale
    const endBytes = Math.min(requiredSizeBytes, deviceSizeBytes - (2 * 1024 * 1024));
    const endMiB = Math.ceil(endBytes / 1024 / 1024); // Arrondir vers le HAUT
    const nextPartLabel = await getNextPartLabel(array);
    const newPartitionPath = getPartitionPath(disk, 1);

    log(`Required size: ${Math.floor(requiredSizeBytes / 1024 / 1024)} MiB`, 'info');
    log(`Device size: ${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB`, 'info');
    log(`Partition will be: ${newPartitionPath} (${nextPartLabel})`, 'info');

    if (dryRun) {
      log('🔍 DRY RUN MODE - No changes will be made', 'warning');
      log('=== Commands that would be executed ===', 'step');
      log(`wipefs -a ${disk}`, 'info');
      log(`parted -s ${disk} mklabel gpt`, 'info');
      log(`parted -s ${disk} mkpart primary 1MiB ${endMiB}MiB`, 'info');
      log(`parted -s ${disk} name 1 ${nextPartLabel}`, 'info');
      log(`parted -s ${disk} set 1 raid on`, 'info');
      log(`partprobe ${disk} && udevadm settle`, 'info');
      log(`wipefs -a ${newPartitionPath}`, 'info');
      log(`udevadm settle --timeout=10 && sleep 2`, 'info');
      log(`mdadm --zero-superblock ${newPartitionPath}`, 'info');
      log(`mdadm --add ${array} ${newPartitionPath}`, 'info');
      log(`mdadm --detail --scan > /etc/mdadm/mdadm.conf`, 'info');
      log(`update-initramfs -u`, 'info');
      log('✓ Dry run completed', 'success');
      
      return res.json({
        success: true,
        dryRun: true,
        logs,
        message: 'Dry run completed - no changes made'
      });
    }

    // Étape 2: Wipe signatures & table
    log('=== Step 2: Wiping disk and creating GPT table ===', 'step');
    
    try {
      log(`Wiping signatures on ${disk}...`, 'info');
      const wipeResult = await executeCommand('sudo', ['-n', 'wipefs', '-a', disk]);
      log(`✓ Wiped ${disk}`, 'success');
      if (wipeResult.stdout) log(wipeResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Error wiping ${disk}: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Creating GPT partition table on ${disk}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mklabel', 'gpt']);
      log(`✓ Created GPT table on ${disk}`, 'success');
    } catch (error) {
      log(`Error creating GPT table: ${error.message}`, 'error');
      throw error;
    }

    // Étape 3: Créer la partition nommée
    log('=== Step 3: Creating RAID partition ===', 'step');
    
    try {
      log(`Creating partition from 1MiB to ${endMiB}MiB...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mkpart', 'primary', '1MiB', `${endMiB}MiB`]);
      log(`✓ Created partition`, 'success');
    } catch (error) {
      log(`Error creating partition: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Setting partition label to ${nextPartLabel}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'name', '1', nextPartLabel]);
      log(`✓ Set partition label`, 'success');
    } catch (error) {
      log(`Error setting partition label: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Setting RAID flag on partition...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'set', '1', 'raid', 'on']);
      log(`✓ Set RAID flag`, 'success');
    } catch (error) {
      log(`Error setting RAID flag: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Running partprobe and udevadm settle...`, 'info');
      await executeCommand('sudo', ['-n', 'partprobe', disk]);
      await executeCommand('sudo', ['-n', 'udevadm', 'settle']);
      log(`✓ Partition table updated`, 'success');
    } catch (error) {
      log(`Warning: partprobe/udevadm: ${error.message}`, 'warning');
    }

    // Étape 4: Assainir & ajouter au RAID
    log('=== Step 4: Adding partition to RAID array ===', 'step');
    
    // Vérifier si la partition appartient déjà à un autre array RAID
    try {
      log(`Checking if ${newPartitionPath} belongs to an existing RAID array...`, 'info');
      const examineResult = await executeCommand('sudo', ['-n', 'mdadm', '--examine', newPartitionPath]);
      
      if (examineResult.stdout.includes('Magic')) {
        // Extraire le nom de l'array existant
        const arrayMatch = examineResult.stdout.match(/Array\s+:\s+(\/dev\/md\d+)/);
        const existingArray = arrayMatch ? arrayMatch[1] : null;
        
        log(`⚠️  Found existing RAID membership on ${newPartitionPath}`, 'warning');
        if (existingArray) {
          log(`Partition is member of ${existingArray}`, 'info');
        }
        
        // Vérifier si l'array existe encore
        try {
          // Utiliser /proc/mdstat pour une détection fiable
          const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
          const mdArrays = [];
          const mdstatLines = mdstatResult.stdout.split('\n');
          
          for (const line of mdstatLines) {
            // Les lignes des arrays commencent par "md" suivi d'un nombre
            const match = line.match(/^(md\d+)\s*:/);
            if (match) {
              mdArrays.push('/dev/' + match[1]);
            }
          }
          
          log(`Detected active RAID arrays: ${mdArrays.join(', ')}`, 'info');
          
          for (const mdArray of mdArrays) {
            if (mdArray === array) continue; // Skip l'array cible
            
            try {
              const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdArray]);
              if (detailResult.stdout.includes(newPartitionPath)) {
                log(`Found ${newPartitionPath} in ${mdArray}, removing it...`, 'info');
                
                // Essayer de fail puis remove
                try {
                  await executeCommand('sudo', ['-n', 'mdadm', '--fail', mdArray, newPartitionPath]);
                  log(`✓ Marked ${newPartitionPath} as failed in ${mdArray}`, 'success');
                } catch (e) {
                  log(`Note: Could not mark as failed (may already be): ${e.message}`, 'info');
                }
                
                await executeCommand('sudo', ['-n', 'mdadm', '--remove', mdArray, newPartitionPath]);
                log(`✓ Removed ${newPartitionPath} from ${mdArray}`, 'success');
                
                // Arrêter l'array s'il est vide/dégradé
                try {
                  const checkDetail = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdArray]);
                  if (checkDetail.stdout.includes('Total Devices : 0') || 
                      checkDetail.stdout.includes('Total Devices : 1')) {
                    log(`Stopping empty/degraded array ${mdArray}...`, 'info');
                    await executeCommand('sudo', ['-n', 'mdadm', '--stop', mdArray]);
                    log(`✓ Stopped ${mdArray}`, 'success');
                    
                    // Attendre que le kernel libère complètement le device
                    await executeCommand('sleep', ['2']);
                    await executeCommand('sudo', ['-n', 'udevadm', 'settle', '--timeout=5']);
                  }
                } catch (e) {
                  log(`Note: Could not stop ${mdArray}: ${e.message}`, 'info');
                }
              }
            } catch (e) {
              // Array n'existe pas ou erreur, continuer
            }
          }
        } catch (e) {
          log(`Warning checking existing arrays: ${e.message}`, 'warning');
        }
        
        // Nettoyer tous les arrays vides/dégradés restants
        try {
          const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
          const mdstatLines = mdstatResult.stdout.split('\n');
          
          for (const line of mdstatLines) {
            const match = line.match(/^(md\d+)\s*:\s*active.*\[(\d+)\/(\d+)\]/);
            if (match) {
              const mdArray = '/dev/' + match[1];
              const activeDevs = parseInt(match[3]);
              
              if (mdArray !== array && activeDevs <= 1) {
                try {
                  log(`Stopping orphaned/degraded array ${mdArray}...`, 'info');
                  await executeCommand('sudo', ['-n', 'mdadm', '--stop', mdArray]);
                  log(`✓ Stopped ${mdArray}`, 'success');
                  await executeCommand('sleep', ['1']);
                } catch (e) {
                  log(`Note: Could not stop ${mdArray}: ${e.message}`, 'info');
                }
              }
            }
          }
        } catch (e) {
          log(`Warning cleaning orphaned arrays: ${e.message}`, 'warning');
        }
        
        // Maintenant zéroter le superbloc
        log(`Zeroing superblock on ${newPartitionPath}...`, 'info');
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', newPartitionPath]);
        log(`✓ Zeroed superblock`, 'success');
      } else {
        log(`✓ No existing RAID membership found`, 'success');
      }
    } catch (error) {
      // Pas de superbloc existant, c'est OK
      log(`✓ No existing superblock found (clean partition)`, 'success');
    }
    
    // Wiper toutes les signatures de la partition (filesystem, etc.)
    try {
      log(`Wiping all signatures from ${newPartitionPath}...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', newPartitionPath]);
      log(`✓ Wiped partition signatures`, 'success');
    } catch (error) {
      log(`Warning: wipefs on partition: ${error.message}`, 'warning');
    }
    
    // Attendre que udev se stabilise après le wipe
    try {
      log(`Waiting for udev to settle after cleanup...`, 'info');
      await executeCommand('sudo', ['-n', 'udevadm', 'settle', '--timeout=10']);
      await executeCommand('sleep', ['2']);
      log(`✓ Device settled`, 'success');
    } catch (error) {
      log(`Warning: udev settle: ${error.message}`, 'warning');
    }

    try {
      log(`Adding ${newPartitionPath} to ${array}...`, 'info');
      const addResult = await executeCommand('sudo', ['-n', 'mdadm', '--add', array, newPartitionPath]);
      log(`✓ Command executed: mdadm --add`, 'success');
      if (addResult.stdout) log(addResult.stdout.trim(), 'info');
      if (addResult.stderr) log(addResult.stderr.trim(), 'warning');
      
      // Attendre que le device soit reconnu
      log(`Waiting for device to be recognized...`, 'info');
      await executeCommand('sleep', ['3']);
      
      // Vérifier que le disque a bien été ajouté
      const verifyResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      if (!verifyResult.stdout.includes(newPartitionPath)) {
        log(`❌ ERROR: ${newPartitionPath} was NOT added to the array!`, 'error');
        log(`This may indicate a problem with the partition or mdadm configuration`, 'error');
        log(`Try manually: sudo mdadm --add ${array} ${newPartitionPath}`, 'warning');
        throw new Error(`Failed to add ${newPartitionPath} to ${array}`);
      } else {
        log(`✓ Verified: ${newPartitionPath} is now part of the array`, 'success');
      }
    } catch (error) {
      log(`Error adding partition to RAID: ${error.message}`, 'error');
      throw error;
    }

    // Étape 5: Persister la configuration
    log('=== Step 5: Persisting mdadm configuration ===', 'step');
    
    try {
      log(`Updating /etc/mdadm/mdadm.conf...`, 'info');
      const scanResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '--scan']);
      const fs = require('fs');
      const tmpFile = '/tmp/mdadm.conf.new';
      fs.writeFileSync(tmpFile, scanResult.stdout);
      await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/mdadm/mdadm.conf']);
      fs.unlinkSync(tmpFile);
      log(`✓ Updated /etc/mdadm/mdadm.conf`, 'success');
    } catch (error) {
      log(`Error updating mdadm.conf: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Updating initramfs...`, 'info');
      const initramfsResult = await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log(`✓ Updated initramfs`, 'success');
      if (initramfsResult.stdout) log(initramfsResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Error updating initramfs: ${error.message}`, 'error');
      throw error;
    }

    // Étape 6: Surveiller la resynchronisation
    log('=== Step 6: Monitoring resync progress ===', 'step');
    
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      log('📊 Initial /proc/mdstat:', 'info');
      log(mdstatResult.stdout.trim(), 'info');
      
      // Vérifier si le resync a démarré
      if (mdstatResult.stdout.includes('recovery') || mdstatResult.stdout.includes('resync')) {
        log('🔄 Resynchronization started, monitoring progress...', 'info');
        
        let lastProgress = -1;
        let resyncComplete = false;
        const maxWaitMinutes = 120; // Timeout de 2 heures
        const startTime = Date.now();
        
        while (!resyncComplete) {
          // Attendre 2 secondes entre chaque vérification (plus réactif)
          await executeCommand('sleep', ['2']);
          
          // Vérifier le timeout
          const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
          if (elapsedMinutes > maxWaitMinutes) {
            log(`⚠ Resync monitoring timeout after ${maxWaitMinutes} minutes`, 'warning');
            log('The resync is still running but we will stop monitoring', 'warning');
            break;
          }
          
          // Lire /proc/mdstat
          const currentMdstat = await executeCommand('cat', ['/proc/mdstat']);
          const mdstatOutput = currentMdstat.stdout;
          
          // Parser la progression
          const progressMatch = mdstatOutput.match(/recovery\s*=\s*(\d+\.\d+)%/);
          if (progressMatch) {
            const progress = parseFloat(progressMatch[1]);
            
            // Afficher plus fréquemment pour une meilleure UX (tous les 0.5%)
            if (Math.abs(progress - lastProgress) >= 0.5 || lastProgress === -1) {
              const finishMatch = mdstatOutput.match(/finish\s*=\s*([\d.]+min)/);
              const speedMatch = mdstatOutput.match(/speed\s*=\s*([\d.]+[KMG]\/sec)/);
              
              let progressMsg = `🔄 Resync progress: ${progress.toFixed(1)}%`;
              if (finishMatch) progressMsg += ` | ETA: ${finishMatch[1]}`;
              if (speedMatch) progressMsg += ` | Speed: ${speedMatch[1]}`;
              
              log(progressMsg, 'info');
              
              // Envoyer aussi un événement dédié pour la progression
              if (io) {
                io.emit('mdraid-resync-progress', {
                  percent: progress,
                  eta: finishMatch ? finishMatch[1] : null,
                  speed: speedMatch ? speedMatch[1] : null
                });
              }
              
              lastProgress = progress;
            }
          } else if (mdstatOutput.includes('[UU]')) {
            // Resync terminé !
            log('✅ Resynchronization completed! Array is now fully synchronized.', 'success');
            if (io) {
              io.emit('mdraid-resync-progress', { percent: 100, eta: null, speed: null, completed: true });
            }
            resyncComplete = true;
          } else if (!mdstatOutput.includes('recovery') && !mdstatOutput.includes('resync')) {
            // Plus de resync en cours
            log('✅ Resynchronization completed!', 'success');
            if (io) {
              io.emit('mdraid-resync-progress', { percent: 100, eta: null, speed: null, completed: true });
            }
            resyncComplete = true;
          }
        }
      } else {
        log('ℹ️ No resync detected (array may already be synchronized)', 'info');
      }
    } catch (error) {
      log(`Could not monitor resync: ${error.message}`, 'warning');
    }

    // Étape 7: Afficher l'état final
    log('=== Step 7: Final status ===', 'step');
    
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      log('📊 Final /proc/mdstat:', 'info');
      log(mdstatResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Could not read /proc/mdstat: ${error.message}`, 'warning');
    }

    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      log(`📊 mdadm --detail ${array}:`, 'info');
      log(detailResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Could not get mdadm details: ${error.message}`, 'warning');
    }

    try {
      const lsblkResult = await executeCommand('lsblk', ['-o', 'NAME,SIZE,TYPE,FSTYPE,PARTLABEL,PARTTYPE', disk]);
      log(`📊 lsblk ${disk}:`, 'info');
      log(lsblkResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Could not run lsblk: ${error.message}`, 'warning');
    }

    log('✅ RAID disk addition completed successfully!', 'success');

    res.json({
      success: true,
      dryRun: false,
      logs,
      message: 'Disk added to RAID successfully',
      newPartition: newPartitionPath,
      partLabel: nextPartLabel
    });
  } catch (error) {
    console.error('Error adding disk to mdraid:', error);
    
    // Ajouter l'erreur aux logs
    log(`Fatal error: ${error.message}`, 'error');
    
    res.status(500).json({
      success: false,
      error: 'Failed to add disk to RAID',
      details: error.message,
      logs: logs
    });
  }
});

/**
 * GET /api/storage/mdraid-status
 * Récupère l'état du RAID mdadm
 */
router.get('/storage/mdraid-status', authenticateToken, async (req, res) => {
  try {
    const status = {
      array: '/dev/md0',
      exists: false,
      mounted: false,
      members: [],
      syncProgress: null
    };

    // Vérifier si /data est monté
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'FSTYPE,SOURCE', '/data']);
      const [fstype, source] = findmntResult.stdout.trim().split(/\s+/);
      
      status.mounted = (source === '/dev/md0' && fstype === 'btrfs');
      status.fstype = fstype;
      status.source = source;
    } catch (error) {
      // /data n'est pas monté
    }

    // Vérifier l'état du RAID
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '/dev/md0']);
      status.exists = true;
      status.detail = detailResult.stdout;
      
      // Parser les informations
      const activeMatch = detailResult.stdout.match(/Active Devices\s*:\s*(\d+)/i);
      const totalMatch = detailResult.stdout.match(/Total Devices\s*:\s*(\d+)/i);
      const stateMatch = detailResult.stdout.match(/State\s*:\s*(.+)/i);
      
      if (activeMatch) status.activeDevices = parseInt(activeMatch[1]);
      if (totalMatch) status.totalDevices = parseInt(totalMatch[1]);
      if (stateMatch) status.state = stateMatch[1].trim();
      
      // Extraire les membres
      const memberMatches = detailResult.stdout.matchAll(/\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\w+)\s+(\/dev\/\S+)/g);
      for (const match of memberMatches) {
        status.members.push({
          number: match[1],
          major: match[2],
          minor: match[3],
          raidDevice: match[4],
          state: match[5],
          device: match[7]
        });
      }
    } catch (error) {
      // Le RAID n'existe pas ou erreur
      status.error = error.message;
    }

    // Lire /proc/mdstat pour la progression
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      status.mdstat = mdstatResult.stdout;
      
      // Parser la progression de resync
      const progressMatch = mdstatResult.stdout.match(/\[(=+>?\.+)\]\s+(\d+\.\d+)%/);
      if (progressMatch) {
        status.syncProgress = parseFloat(progressMatch[2]);
      }
    } catch (error) {
      // Erreur lecture mdstat
    }

    res.json({
      success: true,
      status
    });
  } catch (error) {
    console.error('Error fetching mdraid status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch mdraid status',
      details: error.message
    });
  }
});


module.exports = router;
module.exports.setSocketIO = setSocketIO;