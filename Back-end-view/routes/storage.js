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
    let smartOptimization = null;

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

    // 2. Obtenir la taille requise par membre et analyser les membres actuels
    let requiredSizeBytes = 0;
    let currentMembers = [];
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      
      // Extraire les membres actuels avec leurs tailles
      const memberMatches = detailResult.stdout.matchAll(/\s+\d+\s+\d+\s+\d+\s+\d+\s+\w+\s+\w+\s+(\/dev\/\S+)/g);
      for (const match of memberMatches) {
        const memberDevice = match[1];
        try {
          const lsblkResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', memberDevice]);
          const memberSize = parseInt(lsblkResult.stdout.trim());
          currentMembers.push({
            device: memberDevice,
            size: memberSize
          });
        } catch (e) {
          // Ignorer si on ne peut pas obtenir la taille
        }
      }
      
      requiredSizeBytes = await getUsedDevSize(array);
      reasons.push(`✓ Current RAID size per member: ${Math.floor(requiredSizeBytes / 1024 / 1024)} MiB`);
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
      
      reasons.push(`✓ New disk ${disk} size: ${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB`);
    } catch (error) {
      reasons.push(`❌ Could not determine disk size: ${error.message}`);
      canProceed = false;
    }

    // 5. ANALYSE INTELLIGENTE : Détecter si on peut optimiser la capacité du RAID
    if (currentMembers.length >= 2 && deviceSizeBytes > 0) {
      // Trouver le plus petit membre actuel
      const sortedMembers = [...currentMembers].sort((a, b) => a.size - b.size);
      const smallestMember = sortedMembers[0];
      const secondSmallestMember = sortedMembers[1];
      
      // Si le nouveau disque est significativement plus grand que le plus petit membre
      if (deviceSizeBytes > smallestMember.size * 1.5) {
        // Extraire le disque parent du deuxième membre
        const secondMemberDiskMatch = secondSmallestMember.device.match(/^(\/dev\/(?:sd[a-z]+|nvme\d+n\d+|vd[a-z]+))/);
        if (secondMemberDiskMatch) {
          const secondMemberDisk = secondMemberDiskMatch[1];
          
          // Vérifier la taille totale du disque parent
          try {
            const diskSizeResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', secondMemberDisk]);
            const secondDiskTotalSize = parseInt(diskSizeResult.stdout.trim());
            
            // Calculer la taille cible avec une marge de sécurité de 512 MiB
            const safetyMargin = 512 * 1024 * 1024; // 512 MiB
            const targetSize = Math.min(
              deviceSizeBytes - safetyMargin,
              secondDiskTotalSize - (2 * 1024 * 1024 * 1024)
            );
            
            if (targetSize > secondSmallestMember.size * 1.2 && targetSize <= secondDiskTotalSize) {
              // OPTIMISATION POSSIBLE !
              smartOptimization = {
                type: 'remove_smallest_and_expand',
                smallestMember: smallestMember.device,
                smallestSize: smallestMember.size,
                memberToExpand: secondSmallestMember.device,
                expandDisk: secondMemberDisk,
                currentExpandSize: secondSmallestMember.size,
                targetExpandSize: targetSize,
                newDisk: disk,
                newDiskSize: deviceSizeBytes,
                finalRaidCapacity: targetSize,
                message: `Optimisation détectée : En retirant ${smallestMember.device} (${Math.floor(smallestMember.size / 1024 / 1024 / 1024)}G) et en agrandissant ${secondSmallestMember.device} à ${Math.floor(targetSize / 1024 / 1024 / 1024)}G, vous pourrez avoir un RAID de ${Math.floor(targetSize / 1024 / 1024 / 1024)}G au lieu de ${Math.floor(smallestMember.size / 1024 / 1024 / 1024)}G !`
              };
              
              reasons.push(`Smart optimization available: Remove ${smallestMember.device} and expand ${secondSmallestMember.device} for ${Math.floor(targetSize / 1024 / 1024)}G RAID capacity`);
            }
          } catch (e) {
            // Pas grave si on ne peut pas détecter l'optimisation
          }
        }
      }
    }

    // 6. Vérifier les superblocs existants
    try {
      const examineResult = await executeCommand('sudo', ['-n', 'mdadm', '--examine', disk]);
      if (examineResult.stdout.includes('Magic')) {
        reasons.push(`⚠ WARNING: Disk ${disk} contains existing mdadm superblock (will be wiped)`);
      }
    } catch (error) {
      // Pas de superbloc trouvé, c'est OK
      reasons.push(`✓ No existing mdadm superblock on ${disk}`);
    }

    // 7. Calculer la taille de partition (simple ou optimisée)
    let endBytes, endMiB;
    
    if (smartOptimization) {
      // Utiliser la taille optimale pour maximiser la capacité avec marge de 512 MiB
      const safetyMargin = 512 * 1024 * 1024; // 512 MiB
      endBytes = Math.min(smartOptimization.targetExpandSize, deviceSizeBytes - safetyMargin);
      endMiB = Math.ceil(endBytes / 1024 / 1024);
    } else {
      // Mode standard : utiliser la taille requise actuelle avec marge de 512 MiB
      const safetyMargin = 512 * 1024 * 1024; // 512 MiB
      const minRequired = requiredSizeBytes + safetyMargin;
      
      if (deviceSizeBytes < minRequired) {
        reasons.push(`❌ Disk ${disk} is too small (${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB < ${Math.floor(minRequired / 1024 / 1024)} MiB required)`);
        canProceed = false;
      }
      
      endBytes = Math.min(requiredSizeBytes, deviceSizeBytes - safetyMargin);
      endMiB = Math.ceil(endBytes / 1024 / 1024);
    }

    // 8. Déterminer le prochain PARTLABEL
    const nextPartLabel = await getNextPartLabel(array);
    const newPartitionPath = getPartitionPath(disk, 1);

    // 9. Construire le plan de commandes (simple ou optimisé)
    if (smartOptimization) {
      // Plan optimisé : ne pas construire ici, sera géré par l'endpoint dédié
      plan.push(`[Optimization Plan - Will be executed by optimized workflow]`);
      plan.push(`1. Fail and remove ${smartOptimization.smallestMember} from RAID`);
      plan.push(`2. Resize ${smartOptimization.memberToExpand} to ${Math.floor(smartOptimization.targetExpandSize / 1024 / 1024)}MiB`);
      plan.push(`3. Add ${disk} with ${endMiB}MiB partition`);
      plan.push(`4. Grow RAID array to new size`);
    } else {
      // Plan standard
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
    }

    res.json({
      success: true,
      canProceed,
      reasons,
      plan,
      requiredSizeBytes,
      deviceSizeBytes,
      nextPartLabel,
      newPartitionPath,
      smartOptimization // Nouvelle info pour le frontend
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
 * POST /api/storage/mdraid-optimize-and-add
 * Optimise le RAID en retirant le plus petit membre, agrandissant un autre, et ajoutant un nouveau disque
 * Body: { array: string, smartOptimization: object }
 */
router.post('/storage/mdraid-optimize-and-add', authenticateToken, async (req, res) => {
  const { array, smartOptimization } = req.body;

  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message
    };
    logs.push(logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    if (io) {
      io.emit('mdraid-log', logEntry);
    }
  };

  try {
    if (!smartOptimization || !smartOptimization.smallestMember || !smartOptimization.memberToExpand || !smartOptimization.newDisk) {
      return res.status(400).json({
        success: false,
        error: 'Invalid optimization data'
      });
    }

    log('🚀 Starting SMART RAID optimization process', 'info');
    log(`Strategy: Remove smallest, expand existing, add new disk`, 'info');
    log(`Final RAID capacity: ${Math.floor(smartOptimization.finalRaidCapacity / 1024 / 1024 / 1024)}G`, 'info');

    // ÉTAPE 1: Retirer le plus petit membre
    log('=== Step 1: Removing smallest member from RAID ===', 'step');
    
    try {
      log(`Marking ${smartOptimization.smallestMember} as failed...`, 'info');
      await executeCommand('sudo', ['-n', 'mdadm', '--fail', array, smartOptimization.smallestMember]);
      log(`✓ Marked as failed`, 'success');
    } catch (e) {
      log(`Note: Could not mark as failed: ${e.message}`, 'warning');
    }

    try {
      log(`Removing ${smartOptimization.smallestMember} from ${array}...`, 'info');
      await executeCommand('sudo', ['-n', 'mdadm', '--remove', array, smartOptimization.smallestMember]);
      log(`✓ Removed ${smartOptimization.smallestMember}`, 'success');
      await executeCommand('sleep', ['2']);
      
      // IMPORTANT: Effacer le superblock mdadm pour éviter le réassemblage au boot
      log(`Wiping mdadm superblock from ${smartOptimization.smallestMember}...`, 'info');
      try {
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', smartOptimization.smallestMember]);
        log(`✓ Superblock wiped from ${smartOptimization.smallestMember}`, 'success');
      } catch (e) {
        log(`Warning: Could not wipe superblock: ${e.message}`, 'warning');
      }
      
      // Optionnel: Supprimer la partition pour nettoyer complètement
      log(`Deleting partition ${smartOptimization.smallestMember}...`, 'info');
      try {
        const partMatch = smartOptimization.smallestMember.match(/^(\/dev\/[a-z]+)(\d+)$/);
        if (partMatch) {
          const disk = partMatch[1];
          const partNum = partMatch[2];
          await executeCommand('sudo', ['-n', 'parted', disk, 'rm', partNum]);
          await executeCommand('sudo', ['-n', 'partprobe', disk]);
          log(`✓ Partition ${smartOptimization.smallestMember} deleted`, 'success');
        }
      } catch (e) {
        log(`Note: Could not delete partition: ${e.message}`, 'warning');
      }
    } catch (error) {
      log(`Error removing smallest member: ${error.message}`, 'error');
      throw error;
    }

    // ÉTAPE 2: Agrandir le membre existant
    log('=== Step 2: Expanding existing RAID member partition ===', 'step');
    
    const expandDisk = smartOptimization.expandDisk;
    const expandPartition = smartOptimization.memberToExpand;
    const targetSizeMiB = Math.floor(smartOptimization.targetExpandSize / 1024 / 1024);
    
    try {
      log(`Current partition size: ${Math.floor(smartOptimization.currentExpandSize / 1024 / 1024)}MiB`, 'info');
      log(`Target partition size: ${targetSizeMiB}MiB`, 'info');
      
      // Démonter /data temporairement
      log(`Unmounting /data...`, 'info');
      await executeCommand('sudo', ['-n', 'umount', '/data']);
      log(`✓ Unmounted /data`, 'success');
      
      // Utiliser parted pour redimensionner la partition
      log(`Resizing partition ${expandPartition}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', expandDisk, 'resizepart', '1', `${targetSizeMiB}MiB`]);
      log(`✓ Partition resized`, 'success');
      
      // Informer le kernel du changement
      await executeCommand('sudo', ['-n', 'partprobe', expandDisk]);
      await executeCommand('sudo', ['-n', 'udevadm', 'settle']);
      await executeCommand('sleep', ['2']);
      
      // Faire croître le RAID
      log(`Growing RAID array to use new partition size...`, 'info');
      await executeCommand('sudo', ['-n', 'mdadm', '--grow', array, '--size', 'max']);
      log(`✓ RAID array grown`, 'success');
      
      // Remonter /data
      log(`Remounting /data...`, 'info');
      await executeCommand('sudo', ['-n', 'mount', '/data']);
      log(`✓ Remounted /data`, 'success');
      
      // Faire croître le filesystem btrfs
      log(`Resizing btrfs filesystem...`, 'info');
      await executeCommand('sudo', ['-n', 'btrfs', 'filesystem', 'resize', 'max', '/data']);
      log(`✓ Filesystem resized`, 'success');
      
    } catch (error) {
      log(`Error during expansion: ${error.message}`, 'error');
      // Tenter de remonter /data en cas d'erreur
      try {
        await executeCommand('sudo', ['-n', 'mount', '/data']);
        log(`✓ Remounted /data after error`, 'info');
      } catch (e) {}
      throw error;
    }

    // ÉTAPE 3: Ajouter le nouveau disque
    log('=== Step 3: Adding new disk to RAID ===', 'step');
    
    const newDisk = smartOptimization.newDisk;
    const newPartitionPath = getPartitionPath(newDisk, 1);
    const nextPartLabel = await getNextPartLabel(array);
    
    try {
      log(`Wiping ${newDisk}...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', newDisk]);
      log(`✓ Wiped disk`, 'success');
      
      log(`Creating GPT partition table...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', newDisk, 'mklabel', 'gpt']);
      log(`✓ Created GPT table`, 'success');
      
      log(`Creating partition (1MiB to ${targetSizeMiB}MiB)...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', newDisk, 'mkpart', 'primary', '1MiB', `${targetSizeMiB}MiB`]);
      log(`✓ Created partition`, 'success');
      
      log(`Setting partition label to ${nextPartLabel}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', newDisk, 'name', '1', nextPartLabel]);
      await executeCommand('sudo', ['-n', 'parted', '-s', newDisk, 'set', '1', 'raid', 'on']);
      log(`✓ Set partition metadata`, 'success');
      
      await executeCommand('sudo', ['-n', 'partprobe', newDisk]);
      await executeCommand('sudo', ['-n', 'udevadm', 'settle']);
      await executeCommand('sleep', ['2']);
      
      log(`Wiping partition signatures...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', newPartitionPath]);
      await executeCommand('sudo', ['-n', 'udevadm', 'settle', '--timeout=10']);
      await executeCommand('sleep', ['2']);
      log(`✓ Cleaned partition`, 'success');
      
      log(`Adding ${newPartitionPath} to ${array}...`, 'info');
      await executeCommand('sudo', ['-n', 'mdadm', '--add', array, newPartitionPath]);
      log(`✓ Added to RAID array`, 'success');
      
      await executeCommand('sleep', ['3']);
      
    } catch (error) {
      log(`Error adding new disk: ${error.message}`, 'error');
      throw error;
    }

    // ÉTAPE 4: Mise à jour configuration
    log('=== Step 4: Updating configuration ===', 'step');
    
    try {
      const scanResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '--scan']);
      const fs = require('fs');
      const tmpFile = '/tmp/mdadm.conf.new';
      fs.writeFileSync(tmpFile, scanResult.stdout);
      await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/mdadm/mdadm.conf']);
      fs.unlinkSync(tmpFile);
      log(`✓ Updated /etc/mdadm/mdadm.conf`, 'success');
      
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log(`✓ Updated initramfs`, 'success');
    } catch (error) {
      log(`Warning: Config update: ${error.message}`, 'warning');
    }

    // ÉTAPE 5: Surveillance resync
    log('=== Step 5: Monitoring resync ===', 'step');
    
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      log('📊 Initial mdstat:', 'info');
      log(mdstatResult.stdout.trim(), 'info');
      
      if (mdstatResult.stdout.includes('recovery') || mdstatResult.stdout.includes('resync')) {
        log('🔄 Resynchronization started...', 'info');
        
        let lastProgress = -1;
        let resyncComplete = false;
        const maxWaitMinutes = 120;
        const startTime = Date.now();
        
        while (!resyncComplete) {
          await executeCommand('sleep', ['2']);
          
          const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
          if (elapsedMinutes > maxWaitMinutes) {
            log(`⚠ Resync monitoring timeout`, 'warning');
            break;
          }
          
          const currentMdstat = await executeCommand('cat', ['/proc/mdstat']);
          const mdstatOutput = currentMdstat.stdout;
          
          const progressMatch = mdstatOutput.match(/recovery\s*=\s*(\d+\.\d+)%/);
          if (progressMatch) {
            const progress = parseFloat(progressMatch[1]);
            
            if (Math.abs(progress - lastProgress) >= 0.5 || lastProgress === -1) {
              const finishMatch = mdstatOutput.match(/finish\s*=\s*([\d.]+min)/);
              const speedMatch = mdstatOutput.match(/speed\s*=\s*([\d.]+[KMG]\/sec)/);
              
              let progressMsg = `🔄 Resync: ${progress.toFixed(1)}%`;
              if (finishMatch) progressMsg += ` | ETA: ${finishMatch[1]}`;
              if (speedMatch) progressMsg += ` | Speed: ${speedMatch[1]}`;
              
              log(progressMsg, 'info');
              
              if (io) {
                io.emit('mdraid-resync-progress', {
                  percent: progress,
                  eta: finishMatch ? finishMatch[1] : null,
                  speed: speedMatch ? speedMatch[1] : null
                });
              }
              
              lastProgress = progress;
            }
          } else if (mdstatOutput.includes('[UU]') || (!mdstatOutput.includes('recovery') && !mdstatOutput.includes('resync'))) {
            log('✅ Resynchronization completed!', 'success');
            if (io) {
              io.emit('mdraid-resync-progress', { percent: 100, completed: true });
            }
            resyncComplete = true;
          }
        }
      }
    } catch (error) {
      log(`Could not monitor resync: ${error.message}`, 'warning');
    }

    // ÉTAPE 6: État final
    log('=== Step 6: Final status ===', 'step');
    
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      log(`📊 Final RAID status:`, 'info');
      log(detailResult.stdout.trim(), 'info');
      
      const dfResult = await executeCommand('df', ['-h', '/data']);
      log(`📊 Filesystem capacity:`, 'info');
      log(dfResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Could not get final status: ${error.message}`, 'warning');
    }

    log('✅ SMART RAID optimization completed successfully!', 'success');
    log(`🎉 Your RAID capacity has been maximized to ${Math.floor(smartOptimization.finalRaidCapacity / 1024 / 1024 / 1024)}G`, 'success');

    res.json({
      success: true,
      logs,
      message: 'RAID optimization completed successfully',
      finalCapacity: smartOptimization.finalRaidCapacity
    });
  } catch (error) {
    console.error('Error during RAID optimization:', error);
    
    log(`Fatal error: ${error.message}`, 'error');
    
    res.status(500).json({
      success: false,
      error: 'Failed to optimize RAID',
      details: error.message,
      logs: logs
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
      syncProgress: null,
      syncing: false
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
      
      // Extraire les membres avec leurs tailles
      const memberMatches = detailResult.stdout.matchAll(/\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\w+)\s+(\/dev\/\S+)/g);
      for (const match of memberMatches) {
        const device = match[7];
        
        // Obtenir la taille du device
        let size = null;
        try {
          const lsblkResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', device]);
          size = parseInt(lsblkResult.stdout.trim());
        } catch (e) {
          // Ignorer l'erreur
        }
        
        status.members.push({
          number: match[1],
          major: match[2],
          minor: match[3],
          raidDevice: match[4],
          state: match[5],
          device: device,
          size: size
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
      
      // Parser la progression de resync/recovery
      const progressMatch = mdstatResult.stdout.match(/(?:recovery|resync)\s*=\s*(\d+\.\d+)%/);
      if (progressMatch) {
        status.syncProgress = parseFloat(progressMatch[1]);
        status.syncing = true;
        
        // Parser l'ETA
        const finishMatch = mdstatResult.stdout.match(/finish\s*=\s*([\d.]+min)/);
        if (finishMatch) {
          status.syncETA = finishMatch[1];
        }
        
        // Parser la vitesse
        const speedMatch = mdstatResult.stdout.match(/speed\s*=\s*([\d.]+[KMG]\/sec)/);
        if (speedMatch) {
          status.syncSpeed = speedMatch[1];
        }
      } else {
        status.syncing = false;
      }
    } catch (error) {
      // Erreur lecture mdstat - s'assurer que syncing est false
      status.syncing = false;
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

/**
 * POST /api/storage/mdraid-stop-resync
 * Arrête la resynchronisation en cours sur un array RAID
 * Body: { array: string }
 */
router.post('/storage/mdraid-stop-resync', authenticateToken, async (req, res) => {
  const { array } = req.body;

  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message
    };
    logs.push(logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    if (io) {
      io.emit('mdraid-log', logEntry);
    }
  };

  try {
    // Validation
    if (!array || !array.startsWith('/dev/md')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid array device path'
      });
    }

    log(`🛑 Arrêt de la resynchronisation sur ${array}`, 'info');

    // Vérifier si une resynchronisation est en cours
    const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
    if (!mdstatResult.stdout.includes('recovery') && !mdstatResult.stdout.includes('resync')) {
      log('⚠️ Aucune resynchronisation en cours', 'warning');
      return res.json({
        success: false,
        error: 'No resynchronization in progress',
        logs
      });
    }

    // Arrêter la resynchronisation en écrivant "idle" dans sync_action
    const arrayName = array.replace('/dev/', '');
    const syncActionPath = `/sys/block/${arrayName}/md/sync_action`;
    
    try {
      // Utiliser tee avec sudo pour écrire dans le fichier système
      await executeCommand('bash', ['-c', `echo idle | sudo -n tee ${syncActionPath} > /dev/null`]);
      
      // Attendre un peu pour que le changement prenne effet
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Vérifier que l'arrêt a bien fonctionné
      const checkResult = await executeCommand('cat', [syncActionPath]);
      const currentState = checkResult.stdout.trim();
      
      if (currentState === 'idle') {
        log('✅ Resynchronisation arrêtée avec succès', 'success');
        
        // Émettre un événement pour mettre à jour le frontend
        if (io) {
          io.emit('mdraid-resync-progress', { 
            percent: 0, 
            eta: null, 
            speed: null, 
            stopped: true 
          });
        }

        res.json({
          success: true,
          message: 'Resynchronization stopped successfully',
          logs
        });
      } else {
        // Le système a repris la resynchronisation automatiquement
        // C'est une recovery (ajout de disque), il faut retirer le disque
        log(`⚠️ La resynchronisation a repris automatiquement (état: ${currentState})`, 'warning');
        log('🔧 Arrêt définitif: retrait du disque en cours d\'ajout...', 'info');
        
        // Trouver le disque en cours d'ajout (celui qui est en spare ou en reconstruction)
        const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
        const lines = detailResult.stdout.split('\n');
        let diskToRemove = null;
        
        for (const line of lines) {
          // Chercher les lignes avec "spare" ou "rebuilding"
          if (line.includes('spare') || line.includes('rebuilding')) {
            const match = line.match(/(\/dev\/\S+)/);
            if (match) {
              diskToRemove = match[1];
              break;
            }
          }
        }
        
        if (diskToRemove) {
          log(`🎯 Disque identifié: ${diskToRemove}`, 'info');
          log(`⏸️ Retrait de ${diskToRemove} du RAID...`, 'info');
          
          try {
            // Retirer le disque du RAID
            await executeCommand('sudo', ['-n', 'mdadm', array, '--fail', diskToRemove]);
            await executeCommand('sudo', ['-n', 'mdadm', array, '--remove', diskToRemove]);
            
            log(`✅ Disque ${diskToRemove} retiré avec succès`, 'success');
            log(`💡 La resynchronisation est maintenant arrêtée`, 'success');
            log(`ℹ️ Vous pouvez ré-ajouter le disque plus tard si nécessaire`, 'info');
            
            // Émettre un événement pour mettre à jour le frontend
            if (io) {
              io.emit('mdraid-resync-progress', { 
                percent: 0, 
                eta: null, 
                speed: null, 
                stopped: true 
              });
            }
            
            res.json({
              success: true,
              message: 'Resynchronization stopped by removing the disk being added',
              diskRemoved: diskToRemove,
              logs
            });
          } catch (removeError) {
            log(`❌ Erreur lors du retrait: ${removeError.message}`, 'error');
            res.json({
              success: false,
              error: `Failed to remove disk: ${removeError.message}`,
              logs
            });
          }
        } else {
          log('❌ Impossible d\'identifier le disque en cours d\'ajout', 'error');
          res.json({
            success: false,
            error: 'Could not identify the disk being added',
            logs
          });
        }
      }
    } catch (error) {
      log(`❌ Erreur lors de l'arrêt: ${error.message}`, 'error');
      res.status(500).json({
        success: false,
        error: error.message,
        logs
      });
    }
  } catch (error) {
    console.error('Error stopping resync:', error);
    log(`❌ Erreur: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: error.message,
      logs
    });
  }
});

/**
 * POST /api/storage/mdraid-remove-disk
 * Retire un disque du RAID mdadm /dev/md0
 * Body: { array: string, partition: string }
 */
router.post('/storage/mdraid-remove-disk', authenticateToken, async (req, res) => {
  const { array, partition } = req.body;

  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message
    };
    logs.push(logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
    
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

    if (!partition || !isValidDevicePath(partition)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid partition device path'
      });
    }

    log('🚀 Starting mdadm RAID disk removal process', 'info');
    log(`Array: ${array}`, 'info');
    log(`Partition to remove: ${partition}`, 'info');

    // Vérifier que le RAID existe
    log('=== Step 1: Verifying RAID array ===', 'step');
    
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      
      if (!detailResult.stdout.includes(partition)) {
        log(`❌ Partition ${partition} is not a member of ${array}`, 'error');
        return res.status(400).json({
          success: false,
          error: `Partition ${partition} is not part of the array`,
          logs
        });
      }
      
      log(`✓ Verified: ${partition} is part of ${array}`, 'success');
      
      // Vérifier le nombre de membres actifs
      const activeMatch = detailResult.stdout.match(/Active Devices\s*:\s*(\d+)/i);
      const activeDevices = activeMatch ? parseInt(activeMatch[1]) : 0;
      
      if (activeDevices <= 1) {
        log(`❌ Cannot remove the last active device from the array`, 'error');
        return res.status(400).json({
          success: false,
          error: 'Cannot remove the last device from RAID1 array',
          logs
        });
      }
      
      log(`✓ Array has ${activeDevices} active devices, safe to remove one`, 'success');
    } catch (error) {
      log(`❌ Error checking array: ${error.message}`, 'error');
      return res.status(500).json({
        success: false,
        error: 'Failed to verify RAID array',
        logs
      });
    }

    // Marquer le disque comme défaillant
    log('=== Step 2: Marking device as failed ===', 'step');
    
    try {
      log(`Marking ${partition} as failed...`, 'info');
      const failResult = await executeCommand('sudo', ['-n', 'mdadm', '--fail', array, partition]);
      log(`✓ Marked ${partition} as failed`, 'success');
      if (failResult.stdout) log(failResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Error marking device as failed: ${error.message}`, 'warning');
      log('Continuing with removal...', 'info');
    }

    // Retirer le disque du RAID
    log('=== Step 3: Removing device from array ===', 'step');
    
    try {
      log(`Removing ${partition} from ${array}...`, 'info');
      const removeResult = await executeCommand('sudo', ['-n', 'mdadm', '--remove', array, partition]);
      log(`✓ Removed ${partition} from ${array}`, 'success');
      if (removeResult.stdout) log(removeResult.stdout.trim(), 'info');
      
      // Attendre que le changement soit pris en compte
      await executeCommand('sleep', ['2']);
      
      // Vérifier que le disque a bien été retiré
      const verifyResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      if (verifyResult.stdout.includes(partition)) {
        log(`⚠ Warning: ${partition} may still appear in array details`, 'warning');
      } else {
        log(`✓ Verified: ${partition} successfully removed from array`, 'success');
      }
    } catch (error) {
      log(`Error removing device: ${error.message}`, 'error');
      throw error;
    }

    // Nettoyer le superbloc du disque retiré
    log('=== Step 4: Cleaning up removed device ===', 'step');
    
    try {
      log(`Zeroing superblock on ${partition}...`, 'info');
      await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', partition]);
      log(`✓ Zeroed superblock on ${partition}`, 'success');
    } catch (error) {
      log(`Warning: Could not zero superblock: ${error.message}`, 'warning');
    }

    try {
      log(`Wiping signatures from ${partition}...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', partition]);
      log(`✓ Wiped signatures from ${partition}`, 'success');
    } catch (error) {
      log(`Warning: Could not wipe signatures: ${error.message}`, 'warning');
    }

    // Mettre à jour la configuration
    log('=== Step 5: Updating mdadm configuration ===', 'step');
    
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
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log(`✓ Updated initramfs`, 'success');
    } catch (error) {
      log(`Error updating initramfs: ${error.message}`, 'error');
      throw error;
    }

    // Afficher l'état final
    log('=== Step 6: Final status ===', 'step');
    
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      log(`📊 mdadm --detail ${array}:`, 'info');
      log(detailResult.stdout.trim(), 'info');
    } catch (error) {
      log(`Could not get mdadm details: ${error.message}`, 'warning');
    }

    log('✅ RAID disk removal completed successfully!', 'success');
    log(`💡 The partition ${partition} is now available for other uses`, 'info');

    res.json({
      success: true,
      logs,
      message: 'Disk removed from RAID successfully',
      removedPartition: partition
    });
  } catch (error) {
    console.error('Error removing disk from mdraid:', error);
    
    log(`Fatal error: ${error.message}`, 'error');
    
    res.status(500).json({
      success: false,
      error: 'Failed to remove disk from RAID',
      details: error.message,
      logs: logs
    });
  }
});


module.exports = router;
module.exports.setSocketIO = setSocketIO;