export {};
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { authenticateToken, authenticateTokenOrFirstTime } = require('../middleware/auth');

// Type for command execution result
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

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
function executeCommand(command: string, args: string[] = [], streamLogs = false, onLog: ((log: {type: string, text: string}) => void) | null = null): Promise<CommandResult> {
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
  } catch (error: any) {
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
  } catch (error: any) {
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
        // Retourner la taille exacte du membre (la marge sera appliquée lors de la vérification)
        return memberSize;
      }
    }
    
    // Méthode alternative: Utiliser Array Size
    const arraySizeMatch = detailOutput.match(/Array Size\s*:\s*(\d+)\s*\(/i);
    if (arraySizeMatch) {
      const arraySizeKiB = parseInt(arraySizeMatch[1]);
      // Retourner la taille exacte (la marge sera appliquée lors de la vérification)
      return arraySizeKiB * 1024;
    }
    
    // Par défaut, retourner une taille minimale
    return 10 * 1024 * 1024 * 1024; // 10 GiB
  } catch (error: any) {
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
router.get('/storage/inventory', authenticateTokenOrFirstTime, async (req: any, res: any) => {
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
    } catch (e: any) {
      console.error('Error parsing lsblk output:', e);
    }

    try {
      findmntData = JSON.parse(findmntResult.stdout);
    } catch (e: any) {
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
  } catch (error: any) {
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
router.post('/storage/mdraid-prechecks', authenticateTokenOrFirstTime, async (req: any, res: any) => {
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
    } catch (error: any) {
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
        } catch (e: any) {
          // Ignorer si on ne peut pas obtenir la taille
        }
      }
      
      requiredSizeBytes = await getUsedDevSize(array);
      reasons.push(`✓ Current RAID size per member: ${Math.floor(requiredSizeBytes / 1024 / 1024)} MiB`);
    } catch (error: any) {
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
    } catch (error: any) {
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
          } catch (e: any) {
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
    } catch (error: any) {
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
      // Mode standard : vérifier que le disque est assez grand
      const safetyMargin = 2 * 1024 * 1024; // 2 MiB (suffisant pour GPT et alignement)
      
      if (deviceSizeBytes < requiredSizeBytes) {
        reasons.push(`❌ Disk ${disk} is too small (${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB < ${Math.floor(requiredSizeBytes / 1024 / 1024)} MiB required)`);
        canProceed = false;
      }
      
      // Utiliser toute la capacité disponible (mdadm accepte des membres plus grands)
      endBytes = deviceSizeBytes - safetyMargin;
      endMiB = Math.floor(endBytes / 1024 / 1024);
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
  } catch (error: any) {
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
router.post('/storage/mdraid-optimize-and-add', authenticateTokenOrFirstTime, async (req: any, res: any) => {
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
    } catch (e: any) {
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
      } catch (e: any) {
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
      } catch (e: any) {
        log(`Note: Could not delete partition: ${e.message}`, 'warning');
      }
    } catch (error: any) {
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
      
    } catch (error: any) {
      log(`Error during expansion: ${error.message}`, 'error');
      // Tenter de remonter /data en cas d'erreur
      try {
        await executeCommand('sudo', ['-n', 'mount', '/data']);
        log(`✓ Remounted /data after error`, 'info');
      } catch (e: any) {}
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
      
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
  } catch (error: any) {
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
router.post('/storage/mdraid-add-disk', authenticateTokenOrFirstTime, async (req: any, res: any) => {
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
    
    // Calculer la taille de partition : utiliser toute la capacité disponible (moins 2 MiB pour GPT)
    // Ne PAS limiter à requiredSizeBytes car mdadm accepte des membres plus grands
    const endBytes = deviceSizeBytes - (2 * 1024 * 1024);
    const endMiB = Math.floor(endBytes / 1024 / 1024); // Arrondir vers le BAS pour sécurité
    const nextPartLabel = await getNextPartLabel(array);
    const newPartitionPath = getPartitionPath(disk, 1);

    log(`Required size: ${Math.floor(requiredSizeBytes / 1024 / 1024)} MiB`, 'info');
    log(`Device size: ${Math.floor(deviceSizeBytes / 1024 / 1024)} MiB`, 'info');
    log(`Partition size: ${endMiB} MiB`, 'info');
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
    } catch (error: any) {
      log(`Error wiping ${disk}: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Creating GPT partition table on ${disk}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mklabel', 'gpt']);
      log(`✓ Created GPT table on ${disk}`, 'success');
    } catch (error: any) {
      log(`Error creating GPT table: ${error.message}`, 'error');
      throw error;
    }

    // Étape 3: Créer la partition nommée
    log('=== Step 3: Creating RAID partition ===', 'step');
    
    try {
      log(`Creating partition from 1MiB to ${endMiB}MiB...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mkpart', 'primary', '1MiB', `${endMiB}MiB`]);
      log(`✓ Created partition`, 'success');
    } catch (error: any) {
      log(`Error creating partition: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Setting partition label to ${nextPartLabel}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'name', '1', nextPartLabel]);
      log(`✓ Set partition label`, 'success');
    } catch (error: any) {
      log(`Error setting partition label: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Setting RAID flag on partition...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'set', '1', 'raid', 'on']);
      log(`✓ Set RAID flag`, 'success');
    } catch (error: any) {
      log(`Error setting RAID flag: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Running partprobe and udevadm settle...`, 'info');
      await executeCommand('sudo', ['-n', 'partprobe', disk]);
      await executeCommand('sudo', ['-n', 'udevadm', 'settle']);
      log(`✓ Partition table updated`, 'success');
    } catch (error: any) {
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
                } catch (e: any) {
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
                } catch (e: any) {
                  log(`Note: Could not stop ${mdArray}: ${e.message}`, 'info');
                }
              }
            } catch (e: any) {
              // Array n'existe pas ou erreur, continuer
            }
          }
        } catch (e: any) {
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
                } catch (e: any) {
                  log(`Note: Could not stop ${mdArray}: ${e.message}`, 'info');
                }
              }
            }
          }
        } catch (e: any) {
          log(`Warning cleaning orphaned arrays: ${e.message}`, 'warning');
        }
        
        // Maintenant zéroter le superbloc
        log(`Zeroing superblock on ${newPartitionPath}...`, 'info');
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', newPartitionPath]);
        log(`✓ Zeroed superblock`, 'success');
      } else {
        log(`✓ No existing RAID membership found`, 'success');
      }
    } catch (error: any) {
      // Pas de superbloc existant, c'est OK
      log(`✓ No existing superblock found (clean partition)`, 'success');
    }
    
    // Wiper toutes les signatures de la partition (filesystem, etc.)
    try {
      log(`Wiping all signatures from ${newPartitionPath}...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', newPartitionPath]);
      log(`✓ Wiped partition signatures`, 'success');
    } catch (error: any) {
      log(`Warning: wipefs on partition: ${error.message}`, 'warning');
    }
    
    // Attendre que udev se stabilise après le wipe
    try {
      log(`Waiting for udev to settle after cleanup...`, 'info');
      await executeCommand('sudo', ['-n', 'udevadm', 'settle', '--timeout=10']);
      await executeCommand('sleep', ['2']);
      log(`✓ Device settled`, 'success');
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      log(`Error updating mdadm.conf: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Updating initramfs...`, 'info');
      const initramfsResult = await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log(`✓ Updated initramfs`, 'success');
      if (initramfsResult.stdout) log(initramfsResult.stdout.trim(), 'info');
    } catch (error: any) {
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
    } catch (error: any) {
      log(`Could not monitor resync: ${error.message}`, 'warning');
    }

    // Étape 7: Afficher l'état final
    log('=== Step 7: Final status ===', 'step');
    
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      log('📊 Final /proc/mdstat:', 'info');
      log(mdstatResult.stdout.trim(), 'info');
    } catch (error: any) {
      log(`Could not read /proc/mdstat: ${error.message}`, 'warning');
    }

    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      log(`📊 mdadm --detail ${array}:`, 'info');
      log(detailResult.stdout.trim(), 'info');
    } catch (error: any) {
      log(`Could not get mdadm details: ${error.message}`, 'warning');
    }

    try {
      const lsblkResult = await executeCommand('lsblk', ['-o', 'NAME,SIZE,TYPE,FSTYPE,PARTLABEL,PARTTYPE', disk]);
      log(`📊 lsblk ${disk}:`, 'info');
      log(lsblkResult.stdout.trim(), 'info');
    } catch (error: any) {
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
  } catch (error: any) {
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
 * Récupère l'état de TOUS les RAID mdadm actifs
 */
router.get('/storage/mdraid-status', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  try {
    // Get the device mounted on /data
    let dataDevice = null;
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'SOURCE', '/data']);
      dataDevice = findmntResult.stdout.trim();
    } catch (e: any) {
      // /data not mounted
    }

    // Find all active md arrays
    const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
    const mdLines = mdstatResult.stdout.split('\n');
    const arrays = [];
    
    for (const line of mdLines) {
      const match = line.match(/^(md\d+)\s*:\s*active\s+(\S+)\s+(.+)/);
      if (match) {
        const mdName = match[1];
        const mdDevice = `/dev/${mdName}`;
        const level = match[2];
        const devicesLine = match[3];
        
        const arrayStatus: any = {
          array: mdDevice,
          raidLevel: level,
          exists: true,
          mountedOnData: (dataDevice === mdDevice),
          members: [],
          syncProgress: null,
          syncing: false
        };

        // Parse member devices from the line
        const deviceMatches = devicesLine.matchAll(/(\S+)\[(\d+)\](\((\S+)\))?/g);
        for (const devMatch of deviceMatches) {
          const devPath = devMatch[1].startsWith('/dev/') ? devMatch[1] : `/dev/${devMatch[1]}`;
          const devNum = devMatch[2];
          const state = devMatch[4] || 'active'; // S, F, etc.
          arrayStatus.members.push({
            device: devPath,
            number: devNum,
            state: state === 'S' ? 'spare' : state === 'F' ? 'faulty' : 'active'
          });
        }

        // Get detailed info from mdadm
        try {
          const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdDevice]);
          arrayStatus.detail = detailResult.stdout;
          
          const activeMatch = detailResult.stdout.match(/Active Devices\s*:\s*(\d+)/i);
          const totalMatch = detailResult.stdout.match(/Total Devices\s*:\s*(\d+)/i);
          const raidDevicesMatch = detailResult.stdout.match(/Raid Devices\s*:\s*(\d+)/i);
          const stateMatch = detailResult.stdout.match(/State\s*:\s*(.+)/i);
          const arraySizeMatch = detailResult.stdout.match(/Array Size\s*:\s*(\d+)/i);
          
          if (activeMatch) arrayStatus.activeDevices = parseInt(activeMatch[1]);
          if (totalMatch) arrayStatus.totalDevices = parseInt(totalMatch[1]);
          if (raidDevicesMatch) arrayStatus.raidDevices = parseInt(raidDevicesMatch[1]);
          if (stateMatch) arrayStatus.state = stateMatch[1].trim();
          if (arraySizeMatch) arrayStatus.arraySize = parseInt(arraySizeMatch[1]);
          
          // Get member sizes
          const memberMatches = detailResult.stdout.matchAll(/\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\w+)\s+(\/dev\/\S+)/g);
          for (const m of memberMatches) {
            const device = m[7];
            const existingMember = arrayStatus.members.find((mem: any) => mem.device === device);
            if (existingMember) {
              try {
                const lsblkResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', device]);
                existingMember.size = parseInt(lsblkResult.stdout.trim());
              } catch (e: any) {}
              existingMember.raidState = m[5];
            }
          }
        } catch (e: any) {
          // Array might not be accessible for detail
        }

        // Check sync/recovery/reshape progress from mdstat
        const targetSection = mdstatResult.stdout.split(/^(?=md\d+\s*:)/m).find(s => s.startsWith(mdName)) || '';
        const progressMatch = targetSection.match(/(?:recovery|resync|reshape)\s*=\s*(\d+\.\d+)%/);
        if (progressMatch) {
          arrayStatus.syncProgress = parseFloat(progressMatch[1]);
          arrayStatus.syncing = true;
          
          const finishMatch = targetSection.match(/finish\s*=\s*([\d.]+min)/);
          if (finishMatch) arrayStatus.syncETA = finishMatch[1];
          
          const speedMatch = targetSection.match(/speed\s*=\s*([\d.]+[KMG]\/sec)/);
          if (speedMatch) arrayStatus.syncSpeed = speedMatch[1];
        }

        arrays.push(arrayStatus);
      }
    }

    res.json({
      success: true,
      arrays,
      dataDevice,
      count: arrays.length
    });
  } catch (error: any) {
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
router.post('/storage/mdraid-stop-resync', authenticateTokenOrFirstTime, async (req: any, res: any) => {
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
          } catch (removeError: any) {
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
    } catch (error: any) {
      log(`❌ Erreur lors de l'arrêt: ${error.message}`, 'error');
      res.status(500).json({
        success: false,
        error: error.message,
        logs
      });
    }
  } catch (error: any) {
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
router.post('/storage/mdraid-remove-disk', authenticateTokenOrFirstTime, async (req: any, res: any) => {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      log(`Error removing device: ${error.message}`, 'error');
      throw error;
    }

    // Nettoyer le superbloc du disque retiré
    log('=== Step 4: Cleaning up removed device ===', 'step');
    
    try {
      log(`Zeroing superblock on ${partition}...`, 'info');
      await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', partition]);
      log(`✓ Zeroed superblock on ${partition}`, 'success');
    } catch (error: any) {
      log(`Warning: Could not zero superblock: ${error.message}`, 'warning');
    }

    try {
      log(`Wiping signatures from ${partition}...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', partition]);
      log(`✓ Wiped signatures from ${partition}`, 'success');
    } catch (error: any) {
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
    } catch (error: any) {
      log(`Error updating mdadm.conf: ${error.message}`, 'error');
      throw error;
    }

    try {
      log(`Updating initramfs...`, 'info');
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log(`✓ Updated initramfs`, 'success');
    } catch (error: any) {
      log(`Error updating initramfs: ${error.message}`, 'error');
      throw error;
    }

    // Afficher l'état final
    log('=== Step 6: Final status ===', 'step');
    
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
      log(`📊 mdadm --detail ${array}:`, 'info');
      log(detailResult.stdout.trim(), 'info');
    } catch (error: any) {
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
  } catch (error: any) {
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


/**
 * GET /api/storage/disk-health
 * Récupère les données SMART de tous les disques physiques
 */
router.get('/storage/disk-health', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  try {
    // Lister les disques physiques
    const lsblkResult = await executeCommand('lsblk', ['-d', '-n', '-o', 'NAME,TYPE']);
    const lines = lsblkResult.stdout.trim().split('\n').filter(l => l.trim());
    
    const disks = [];
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const name = parts[0];
      const type = parts[1];
      
      if (type !== 'disk') continue;
      // Skip loop, ram, etc.
      if (name.startsWith('loop') || name.startsWith('ram') || name.startsWith('sr')) continue;
      
      const device = `/dev/${name}`;
      const diskInfo: any = {
        device,
        health: 'unknown',
        temperature: null,
        model: null,
        serial: null,
        powerOnHours: null,
        reallocatedSectors: null
      };
      
      try {
        let smartResult = await executeCommand('sudo', ['-n', 'smartctl', '-j', '-a', device]);
        let smart = JSON.parse(smartResult.stdout);
        
        // If smartctl reports a USB bridge error or no SMART data, retry with -d sat
        const hasUsbBridgeError = smart.smartctl?.messages?.some((m: any) => m.string?.includes('USB bridge'));
        const noSmartData = !smart.smart_status && !smart.ata_smart_attributes;
        if (hasUsbBridgeError || (smart.smartctl?.exit_status !== 0 && noSmartData)) {
          try {
            smartResult = await executeCommand('sudo', ['-n', 'smartctl', '-j', '-a', '-d', 'sat', device]);
            smart = JSON.parse(smartResult.stdout);
          } catch (retryErr: any) {
            // SAT passthrough also failed, keep original result
          }
        }
        
        // Health assessment
        if (smart.smart_status && smart.smart_status.passed !== undefined) {
          diskInfo.health = smart.smart_status.passed ? 'good' : 'failing';
        }
        
        // Model
        if (smart.model_name) diskInfo.model = smart.model_name;
        else if (smart.model_family) diskInfo.model = smart.model_family;
        
        // Serial
        if (smart.serial_number) diskInfo.serial = smart.serial_number;
        
        // Temperature
        if (smart.temperature && smart.temperature.current !== undefined) {
          diskInfo.temperature = smart.temperature.current;
        }
        
        // SMART attributes
        if (smart.ata_smart_attributes && smart.ata_smart_attributes.table) {
          for (const attr of smart.ata_smart_attributes.table) {
            if (attr.id === 9) diskInfo.powerOnHours = attr.raw.value;
            if (attr.id === 5) diskInfo.reallocatedSectors = attr.raw.value;
            if (attr.id === 194 && diskInfo.temperature === null) diskInfo.temperature = attr.raw.value;
          }
        }
        
        // NVMe temperature fallback
        if (diskInfo.temperature === null && smart.nvme_smart_health_information_log) {
          diskInfo.temperature = smart.nvme_smart_health_information_log.temperature;
        }
        
        // NVMe power on hours fallback
        if (diskInfo.powerOnHours === null && smart.nvme_smart_health_information_log) {
          diskInfo.powerOnHours = smart.nvme_smart_health_information_log.power_on_hours;
        }
        
        // Check for warning conditions
        if (diskInfo.health === 'good') {
          if (diskInfo.reallocatedSectors && diskInfo.reallocatedSectors > 0) {
            diskInfo.health = 'warning';
          }
          if (diskInfo.temperature && diskInfo.temperature > 55) {
            diskInfo.health = 'warning';
          }
        }
      } catch (e: any) {
        // smartctl not available or failed for this disk
      }
      
      disks.push(diskInfo);
    }
    
    res.json({ success: true, disks });
  } catch (error: any) {
    console.error('Error getting disk health:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get disk health',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/mdraid-create-prechecks
 * Pré-vérifications avant la création d'un nouvel array RAID
 * Body: { level: string, disks: string[] }
 */
router.post('/storage/mdraid-create-prechecks', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  try {
    const { level, disks } = req.body;
    
    if (!level || !disks || !Array.isArray(disks) || disks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid parameters: level and disks[] are required'
      });
    }
    
    // Validate RAID level
    const raidLevelMap = {
      'raid0': { minDisks: 2, mdLevel: '0' },
      'raid1': { minDisks: 2, mdLevel: '1' },
      'raid5': { minDisks: 3, mdLevel: '5' },
      'raid6': { minDisks: 4, mdLevel: '6' },
      'raid10': { minDisks: 4, mdLevel: '10' }
    };
    
    const raidConfig = raidLevelMap[level];
    if (!raidConfig) {
      return res.status(400).json({
        success: false,
        error: `Unsupported RAID level: ${level}`
      });
    }
    
    const reasons = [];
    const plan = [];
    let canProceed = true;
    
    // 1. Check minimum disk count
    if (disks.length < raidConfig.minDisks) {
      reasons.push(`❌ ${level.toUpperCase()} requires at least ${raidConfig.minDisks} disks (${disks.length} selected)`);
      canProceed = false;
    } else {
      reasons.push(`✓ Disk count OK: ${disks.length} disks for ${level.toUpperCase()} (min: ${raidConfig.minDisks})`);
    }
    
    // RAID 10 requires even number
    if (level === 'raid10' && disks.length % 2 !== 0) {
      reasons.push(`❌ RAID 10 requires an even number of disks`);
      canProceed = false;
    }
    
    // 2. Validate each disk
    let smallestSize = Infinity;
    const diskSizes = [];
    
    for (const disk of disks) {
      if (!isValidDevicePath(disk)) {
        reasons.push(`❌ Invalid device path: ${disk}`);
        canProceed = false;
        continue;
      }
      
      // Check not mounted
      const mountCheck = await isDeviceMounted(disk);
      if (mountCheck.mounted) {
        reasons.push(`❌ ${disk} is mounted on ${mountCheck.mountpoint}`);
        canProceed = false;
      } else {
        reasons.push(`✓ ${disk} is not mounted`);
      }
      
      // Check size
      try {
        const sizeResult = await executeCommand('lsblk', ['-b', '-d', '-n', '-o', 'SIZE', disk]);
        const sizeBytes = parseInt(sizeResult.stdout.trim());
        diskSizes.push({ disk, size: sizeBytes });
        if (sizeBytes < smallestSize) smallestSize = sizeBytes;
        reasons.push(`✓ ${disk} size: ${Math.floor(sizeBytes / 1024 / 1024 / 1024)} GiB`);
      } catch (e: any) {
        reasons.push(`❌ Could not determine size of ${disk}: ${e.message}`);
        canProceed = false;
      }
      
      // Check for existing superblocks
      try {
        const examResult = await executeCommand('sudo', ['-n', 'mdadm', '--examine', disk]);
        if (examResult.stdout.includes('Magic')) {
          reasons.push(`⚠ ${disk} has existing RAID superblock (will be wiped)`);
        }
      } catch (e: any) {
        // No superblock, OK
      }
    }
    
    // 3. Check if /dev/md0 already exists
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      if (mdstatResult.stdout.includes('md0 :')) {
        reasons.push(`⚠ /dev/md0 already exists — it will need to be reconfigured`);
      }
    } catch (e: any) {}
    
    // 4. Calculate expected capacity
    let expectedCapacity = 0;
    if (smallestSize < Infinity) {
      const usablePerDisk = smallestSize - (2 * 1024 * 1024); // 2 MiB GPT overhead
      const n = disks.length;
      switch (level) {
        case 'raid0': expectedCapacity = usablePerDisk * n; break;
        case 'raid1': expectedCapacity = usablePerDisk; break;
        case 'raid5': expectedCapacity = usablePerDisk * (n - 1); break;
        case 'raid6': expectedCapacity = usablePerDisk * (n - 2); break;
        case 'raid10': expectedCapacity = usablePerDisk * Math.floor(n / 2); break;
      }
      reasons.push(`✓ Expected usable capacity: ~${Math.floor(expectedCapacity / 1024 / 1024 / 1024)} GiB`);
    }
    
    // 5. Build command plan
    const partEndMiB = smallestSize < Infinity ? Math.floor((smallestSize - (2 * 1024 * 1024)) / 1024 / 1024) : 0;
    
    for (let i = 0; i < disks.length; i++) {
      const d = disks[i];
      const label = `md0_${String.fromCharCode(97 + i)}`;
      plan.push(`wipefs -a ${d}`);
      plan.push(`parted -s ${d} mklabel gpt`);
      plan.push(`parted -s ${d} mkpart primary 1MiB ${partEndMiB}MiB`);
      plan.push(`parted -s ${d} name 1 ${label}`);
      plan.push(`parted -s ${d} set 1 raid on`);
    }
    plan.push(`partprobe && udevadm settle && sleep 2`);
    
    const partPaths = disks.map(d => getPartitionPath(d, 1));
    plan.push(`mdadm --create /dev/md0 --level=${raidConfig.mdLevel} --raid-devices=${disks.length} ${partPaths.join(' ')}`);
    plan.push(`mkfs.btrfs -f /dev/md0`);
    plan.push(`mount /dev/md0 /mnt/new_raid`);
    plan.push(`systemctl stop docker.socket docker containerd`);
    plan.push(`# btrfs send/receive for each subvolume (preserves Docker data)`);
    plan.push(`rsync -a (remaining non-subvolume files)`);
    plan.push(`umount /mnt/new_raid && umount /data && mount /dev/md0 /data`);
    plan.push(`# Write clean mdadm.conf with HOMEHOST <ignore>`);
    plan.push(`update-initramfs -u`);
    plan.push(`systemctl start containerd docker.socket docker`);
    
    res.json({
      success: true,
      canProceed,
      reasons,
      plan,
      expectedCapacity,
      raidLevel: level,
      diskCount: disks.length
    });
  } catch (error: any) {
    console.error('Error during create pre-checks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform create pre-checks',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/mdraid-create
 * Crée un nouvel array RAID depuis zéro
 * Body: { level: string, disks: string[], dryRun: boolean }
 */
router.post('/storage/mdraid-create', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  const { level, disks, dryRun = false } = req.body;
  
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
    if (!level || !disks || !Array.isArray(disks) || disks.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' });
    }
    
    const raidLevelMap = {
      'raid0': { minDisks: 2, mdLevel: '0' },
      'raid1': { minDisks: 2, mdLevel: '1' },
      'raid5': { minDisks: 3, mdLevel: '5' },
      'raid6': { minDisks: 4, mdLevel: '6' },
      'raid10': { minDisks: 4, mdLevel: '10' }
    };
    
    const raidConfig = raidLevelMap[level];
    if (!raidConfig) {
      return res.status(400).json({ success: false, error: `Unsupported RAID level: ${level}` });
    }
    
    if (disks.length < raidConfig.minDisks) {
      return res.status(400).json({ success: false, error: `${level} requires at least ${raidConfig.minDisks} disks` });
    }
    
    // Check if any RAID array is currently syncing/recovering/reshaping
    log('Checking for active RAID operations...', 'info');
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      const syncingMatch = mdstatResult.stdout.match(/(recovery|resync|reshape)\s*=\s*(\d+\.\d+)%/);
      if (syncingMatch) {
        const operation = syncingMatch[1];
        const progress = syncingMatch[2];
        log(`❌ Cannot create new RAID: another array is currently ${operation}ing (${progress}%)`, 'error');
        return res.status(400).json({ 
          success: false, 
          error: `Cannot create RAID while another array is ${operation}ing (${progress}%). Please wait for it to complete or stop it first.`,
          syncingInProgress: true,
          operation,
          progress: parseFloat(progress)
        });
      }
    } catch (e: any) {
      log('Could not check mdstat, continuing...', 'warning');
    }
    
    // Validate all disks
    for (const disk of disks) {
      if (!isValidDevicePath(disk)) {
        return res.status(400).json({ success: false, error: `Invalid device path: ${disk}` });
      }
    }
    
    log(`🚀 Starting RAID array creation: ${level.toUpperCase()} with ${disks.length} disks`, 'info');
    log(`Disks: ${disks.join(', ')}`, 'info');
    log(`Dry Run: ${dryRun}`, 'info');
    
    // Calculate partition size (use smallest disk)
    let smallestSize = Infinity;
    for (const disk of disks) {
      const sizeResult = await executeCommand('lsblk', ['-b', '-d', '-n', '-o', 'SIZE', disk]);
      const sizeBytes = parseInt(sizeResult.stdout.trim());
      if (sizeBytes < smallestSize) smallestSize = sizeBytes;
    }
    const partEndMiB = Math.floor((smallestSize - (2 * 1024 * 1024)) / 1024 / 1024);
    
    if (dryRun) {
      log('🔍 DRY RUN MODE - No changes will be made', 'warning');
      for (let i = 0; i < disks.length; i++) {
        const d = disks[i];
        const label = `md0_${String.fromCharCode(97 + i)}`;
        log(`wipefs -a ${d}`, 'info');
        log(`parted -s ${d} mklabel gpt`, 'info');
        log(`parted -s ${d} mkpart primary 1MiB ${partEndMiB}MiB`, 'info');
        log(`parted -s ${d} name 1 ${label}`, 'info');
        log(`parted -s ${d} set 1 raid on`, 'info');
      }
      const partPaths = disks.map(d => getPartitionPath(d, 1));
      log(`mdadm --create /dev/md0 --level=${raidConfig.mdLevel} --raid-devices=${disks.length} ${partPaths.join(' ')}`, 'info');
      log(`mkfs.btrfs -f /dev/md0`, 'info');
      log(`mount /dev/md0 /data`, 'info');
      log('✓ Dry run completed', 'success');
      return res.json({ success: true, dryRun: true, logs, message: 'Dry run completed' });
    }
    
    // === Step 1: Find a free md device slot & cleanup ghost arrays ===
    log('=== Step 1: Preparing environment ===', 'step');
    
    // Check if requested disks are trapped in a ghost/auto-reassembled array
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      const mdLines = mdstatResult.stdout.split('\n');
      const ghostArrays = new Set();
      
      for (let i = 0; i < mdLines.length; i++) {
        const headerMatch = mdLines[i].match(/^(md\d+)\s*:/);
        if (headerMatch) {
          const mdName = headerMatch[1];
          // Check if any of our target disks are in this array
          for (const disk of disks) {
            const diskBase = disk.replace('/dev/', '');
            if (mdLines[i].includes(diskBase)) {
              ghostArrays.add(mdName);
            }
          }
        }
      }
      
      if (ghostArrays.size > 0) {
        log(`⚠ Found ghost arrays using requested disks: ${[...ghostArrays].join(', ')}`, 'warning');
        for (const ghost of ghostArrays) {
          const ghostDev = `/dev/${ghost}`;
          try {
            await executeCommand('sudo', ['-n', 'umount', '-l', ghostDev]).catch(() => {});
            await executeCommand('sudo', ['-n', 'mdadm', '--stop', ghostDev]);
            log(`✓ Stopped ghost array ${ghostDev}`, 'success');
          } catch (e: any) {
            log(`Warning stopping ${ghostDev}: ${e.message}`, 'warning');
          }
        }
        await executeCommand('sleep', ['1']);
      }
      
      // ALWAYS clean superblocks on all target disks before creating new RAID
      log('Cleaning all target disks...', 'info');
      for (const disk of disks) {
        // Remove any existing partitions first
        try {
          await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'rm', '1']).catch(() => {});
        } catch (e: any) {}
        
        // Zap GPT/MBR
        try {
          await executeCommand('sudo', ['-n', 'sgdisk', '--zap-all', disk]);
        } catch (e: any) {}
        
        // Wipe all signatures
        try {
          await executeCommand('sudo', ['-n', 'wipefs', '-a', disk]);
        } catch (e: any) {}
        
        // Zero superblock on disk
        try {
          await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', disk]);
          log(`✓ Cleaned ${disk}`, 'success');
        } catch (e: any) {
          log(`Note: ${disk}: ${e.message}`, 'info');
        }
        
        // Also zero superblock on potential partition paths
        for (let partNum = 1; partNum <= 4; partNum++) {
          const testPart = getPartitionPath(disk, partNum);
          try {
            await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', testPart]);
          } catch (e: any) {}
        }
      }
      await executeCommand('sleep', ['1']);
      await executeCommand('sudo', ['-n', 'partprobe']);
      await executeCommand('sleep', ['1']);
    } catch (e: any) {
      log(`Ghost array check: ${e.message}`, 'info');
    }
    
    let mdDevice = '/dev/md0';
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      // Find all active md devices
      const activeMds = [];
      const mdLines = mdstatResult.stdout.split('\n');
      for (const line of mdLines) {
        const match = line.match(/^(md\d+)\s*:/);
        if (match) activeMds.push(parseInt(match[1].replace('md', '')));
      }
      
      if (activeMds.length > 0) {
        // Find next free slot
        let slot = 0;
        while (activeMds.includes(slot)) slot++;
        mdDevice = `/dev/md${slot}`;
        log(`Existing arrays detected: ${activeMds.map(n => 'md' + n).join(', ')}`, 'info');
        log(`Using free slot: ${mdDevice}`, 'info');
      } else {
        log('No existing arrays, using /dev/md0', 'info');
      }
    } catch (e: any) {
      log('Using default /dev/md0', 'info');
    }
    
    // === Step 2: Prepare all disks ===
    log('=== Step 2: Preparing disks ===', 'step');
    
    const partitionPaths = [];
    const mdNum = mdDevice.replace('/dev/md', '');
    
    for (let i = 0; i < disks.length; i++) {
      const disk = disks[i];
      const label = `md${mdNum}_${String.fromCharCode(97 + i)}`;
      const partPath = getPartitionPath(disk, 1);
      partitionPaths.push(partPath);
      
      log(`--- Preparing ${disk} (${i + 1}/${disks.length}) ---`, 'info');
      
      // Check not mounted
      const mountCheck = await isDeviceMounted(disk);
      if (mountCheck.mounted) {
        log(`❌ ${disk} is mounted on ${mountCheck.mountpoint}, cannot proceed`, 'error');
        throw new Error(`${disk} is mounted`);
      }
      
      // Zero any existing superblock on disk and partitions
      log(`Cleaning RAID signatures on ${disk}...`, 'info');
      try {
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', disk]);
        log(`  ✓ Zeroed superblock on disk`, 'success');
      } catch (e: any) {}
      
      // Remove any existing partitions first
      try {
        await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'rm', '1']);
        log(`  ✓ Removed old partition 1`, 'success');
      } catch (e: any) {}
      
      // Wipe all signatures
      try {
        await executeCommand('sudo', ['-n', 'wipefs', '-a', disk]);
        log(`  ✓ Wiped all signatures`, 'success');
      } catch (e: any) {}
      
      // Also try sgdisk to zap GPT
      try {
        await executeCommand('sudo', ['-n', 'sgdisk', '--zap-all', disk]);
        log(`  ✓ Zapped GPT`, 'success');
      } catch (e: any) {}
      
      // Zero superblock on the partition path if it exists
      try {
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', partPath]);
      } catch (e: any) {}
      
      // Wipe partition signatures
      log(`Wiping ${disk}...`, 'info');
      await executeCommand('sudo', ['-n', 'wipefs', '-a', disk]);
      
      log(`Creating GPT table on ${disk}...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mklabel', 'gpt']);
      
      log(`Creating partition (1MiB to ${partEndMiB}MiB)...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mkpart', 'primary', '1MiB', `${partEndMiB}MiB`]);
      
      log(`Setting label ${label} and RAID flag...`, 'info');
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'name', '1', label]);
      await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'set', '1', 'raid', 'on']);
      
      log(`✓ ${disk} ready`, 'success');
    }
    
    // Partprobe all at once
    log('Updating partition tables...', 'info');
    for (const disk of disks) {
      await executeCommand('sudo', ['-n', 'partprobe', disk]);
    }
    await executeCommand('sudo', ['-n', 'udevadm', 'settle']);
    await executeCommand('sleep', ['2']);
    log('✓ All partition tables updated', 'success');
    
    // Wipe partition signatures
    for (const partPath of partitionPaths) {
      try {
        await executeCommand('sudo', ['-n', 'wipefs', '-a', partPath]);
      } catch (e: any) {}
    }
    await executeCommand('sudo', ['-n', 'udevadm', 'settle', '--timeout=10']);
    await executeCommand('sleep', ['2']);
    
    // === Step 3: Create RAID array ===
    log('=== Step 3: Creating RAID array ===', 'step');
    
    const mdadmArgs = [
      '-n', 'mdadm', '--create', mdDevice,
      '--level=' + raidConfig.mdLevel,
      '--raid-devices=' + disks.length.toString(),
      '--name=ryvie',
      '--force',  // Force creation even if disks have existing signatures
      '--run',
      ...partitionPaths
    ];
    
    log(`Creating ${level.toUpperCase()} array with: ${partitionPaths.join(', ')}`, 'info');
    const createResult = await executeCommand('sudo', mdadmArgs);
    if (createResult.stdout) log(createResult.stdout.trim(), 'info');
    if (createResult.stderr) log(createResult.stderr.trim(), 'warning');
    
    // Check if creation actually failed
    if (createResult.exitCode !== 0 || createResult.stderr.includes('already in use')) {
      log(`❌ mdadm --create failed (exit code: ${createResult.exitCode})`, 'error');
      throw new Error(`mdadm --create failed: ${createResult.stderr.trim()}`);
    }
    
    // Verify md0 now exists with our new disks
    const verifyResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdDevice]);
    const hasNewDisk = partitionPaths.some(p => verifyResult.stdout.includes(p));
    if (!hasNewDisk) {
      log('❌ New array does not contain expected disks!', 'error');
      throw new Error('Created array does not contain expected partition paths');
    }
    log('✓ RAID array created and verified', 'success');
    
    await executeCommand('sleep', ['2']);
    
    // === Step 4: Create filesystem ===
    log('=== Step 4: Creating btrfs filesystem ===', 'step');
    
    log(`Creating btrfs filesystem on ${mdDevice}...`, 'info');
    const mkfsResult = await executeCommand('sudo', ['-n', 'mkfs.btrfs', '-f', mdDevice]);
    if (mkfsResult.stdout) log(mkfsResult.stdout.trim(), 'info');
    log('✓ Filesystem created', 'success');
    
    // === Step 5: Mount on temporary location (keep old /data intact) ===
    log('=== Step 5: Mounting on temporary location ===', 'step');
    
    const tmpMount = '/mnt/new_raid';
    try {
      await executeCommand('sudo', ['-n', 'mkdir', '-p', tmpMount]);
    } catch (e: any) {}
    
    log(`Mounting ${mdDevice} on ${tmpMount} (keeping /data on old array)...`, 'info');
    await executeCommand('sudo', ['-n', 'mount', mdDevice, tmpMount]);
    log(`✓ Mounted on ${tmpMount}`, 'success');
    
    // Set permissions
    try {
      await executeCommand('sudo', ['-n', 'chown', 'ryvie:ryvie', tmpMount]);
      log('✓ Permissions set', 'success');
    } catch (e: any) {}
    
    // === Step 6: Save mdadm.conf (so new array survives reboot) ===
    log('=== Step 6: Saving RAID configuration ===', 'step');
    
    try {
      const scanResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '--scan']);
      const cleanConf = `# mdadm.conf - RAID configuration (auto-generated)\nHOMEHOST <ignore>\n${scanResult.stdout.trim()}\n`;
      const fs = require('fs');
      const tmpFile = '/tmp/mdadm.conf.new';
      fs.writeFileSync(tmpFile, cleanConf);
      await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/mdadm/mdadm.conf']);
      fs.unlinkSync(tmpFile);
      log('✓ Updated /etc/mdadm/mdadm.conf', 'success');
    } catch (e: any) {
      log(`Warning: ${e.message}`, 'warning');
    }
    
    try {
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log('✓ Updated initramfs', 'success');
    } catch (e: any) {
      log(`Warning initramfs: ${e.message}`, 'warning');
    }
    
    // === Step 7: Monitor resync ===
    log('=== Step 7: Monitoring resync ===', 'step');
    log('ℹ️ /data remains on old array during resync — no downtime', 'info');
    
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      log('📊 /proc/mdstat:', 'info');
      log(mdstatResult.stdout.trim(), 'info');
      
      if (mdstatResult.stdout.includes('recovery') || mdstatResult.stdout.includes('resync')) {
        log('🔄 Resynchronization started...', 'info');
        
        let lastProgress = -1;
        let resyncComplete = false;
        const maxWaitMinutes = 1440;
        const startTime = Date.now();
        
        while (!resyncComplete) {
          await executeCommand('sleep', ['5']);
          
          const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
          if (elapsedMinutes > maxWaitMinutes) {
            log('⚠ Resync monitoring timeout (24h)', 'warning');
            break;
          }
          
          const currentMdstat = await executeCommand('cat', ['/proc/mdstat']);
          const mdstatOutput = currentMdstat.stdout;
          
          const progressMatch = mdstatOutput.match(/(?:recovery|resync)\s*=\s*(\d+\.\d+)%/);
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
          } else if (mdstatOutput.includes('[UU') || (!mdstatOutput.includes('recovery') && !mdstatOutput.includes('resync'))) {
            log('✅ Resynchronization completed!', 'success');
            if (io) {
              io.emit('mdraid-resync-progress', { percent: 100, completed: true });
            }
            resyncComplete = true;
          }
        }
      } else {
        log('ℹ️ No resync needed (clean creation)', 'info');
      }
    } catch (e: any) {
      log(`Could not monitor resync: ${e.message}`, 'warning');
    }
    
    // === Step 8: Stop Docker & migrate data (preserving btrfs subvolumes) ===
    log('=== Step 8: Migrating data from old /data ===', 'step');
    
    try {
      const oldDataCheck = await executeCommand('ls', ['/data']);
      if (oldDataCheck.stdout.trim()) {
        // 8a. Stop Docker and containerd so data is consistent during copy
        log('🛑 Stopping Docker & containerd before migration...', 'info');
        try {
          await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'docker.socket']);
          await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'docker']);
          await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'containerd']);
          log('✓ Docker & containerd stopped', 'success');
        } catch (e: any) {
          log(`Warning stopping Docker: ${e.message}`, 'warning');
        }
        
        // 8b. Detect btrfs subvolumes on old /data and migrate them properly
        log('📦 Detecting btrfs subvolumes on old /data...', 'info');
        let subvolumes: string[] = [];
        try {
          const subvolResult = await executeCommand('sudo', ['-n', 'btrfs', 'subvolume', 'list', '-o', '/data']);
          subvolumes = subvolResult.stdout.trim().split('\n')
            .filter(line => line.includes('path '))
            .map(line => {
              const m = line.match(/path\s+(.+)$/);
              return m ? m[1] : '';
            })
            .filter(p => p);
          
          if (subvolumes.length > 0) {
            log(`Found ${subvolumes.length} subvolume(s): ${subvolumes.join(', ')}`, 'info');
          } else {
            log('No subvolumes found, will use rsync', 'info');
          }
        } catch (e: any) {
          log('Could not list subvolumes (source may not be btrfs), will use rsync', 'info');
        }
        
        if (subvolumes.length > 0) {
          // 8c. Use btrfs send/receive to preserve subvolumes (Docker/containerd need this)
          log('📦 Migrating with btrfs send/receive (preserves subvolumes)...', 'info');
          
          // First, create read-only snapshots of each subvolume, send/receive, then delete snapshots
          for (const subvol of subvolumes) {
            const subvolPath = `/data/${subvol}`;
            const snapPath = `/data/${subvol}.migration-snap`;
            
            try {
              // Create read-only snapshot
              await executeCommand('sudo', ['-n', 'btrfs', 'subvolume', 'snapshot', '-r', subvolPath, snapPath]);
              log(`  📸 Snapshot created: ${subvol}`, 'info');
              
              // Send/receive to new array
              const sendReceiveResult = await executeCommand('sudo', ['-n', 'bash', '-c', `btrfs send "${snapPath}" | btrfs receive "${tmpMount}/"`]);
              if (sendReceiveResult.exitCode === 0) {
                log(`  ✓ Subvolume ${subvol} migrated via btrfs send/receive`, 'success');
                
                // Make the received snapshot read-write
                const receivedName = `${subvol}.migration-snap`;
                const receivedPath = `${tmpMount}/${receivedName}`;
                const finalPath = `${tmpMount}/${subvol}`;
                
                // Delete the read-only received snapshot and create a rw snapshot from it
                try {
                  await executeCommand('sudo', ['-n', 'btrfs', 'subvolume', 'snapshot', receivedPath, finalPath]);
                  await executeCommand('sudo', ['-n', 'btrfs', 'subvolume', 'delete', receivedPath]);
                  log(`  ✓ ${subvol} set to read-write`, 'success');
                } catch (rwErr: any) {
                  // If renaming fails, the snapshot name works too
                  log(`  ⚠ Could not rename ${receivedName} → ${subvol}: ${rwErr.message}`, 'warning');
                }
              } else {
                log(`  ⚠ btrfs send/receive failed for ${subvol}, falling back to rsync`, 'warning');
                await executeCommand('sudo', ['-n', 'rsync', '-a', '--info=progress2', `${subvolPath}/`, `${tmpMount}/${subvol}/`]);
              }
              
              // Cleanup source snapshot
              try {
                await executeCommand('sudo', ['-n', 'btrfs', 'subvolume', 'delete', snapPath]);
              } catch (e: any) {}
            } catch (subvolErr: any) {
              log(`  ⚠ Failed to migrate subvolume ${subvol} via btrfs: ${subvolErr.message}`, 'warning');
              log(`  Falling back to rsync for ${subvol}...`, 'info');
              try {
                await executeCommand('sudo', ['-n', 'mkdir', '-p', `${tmpMount}/${subvol}`]);
                await executeCommand('sudo', ['-n', 'rsync', '-a', `${subvolPath}/`, `${tmpMount}/${subvol}/`]);
                log(`  ✓ ${subvol} migrated via rsync (fallback)`, 'success');
              } catch (rsyncErr: any) {
                log(`  ❌ Failed to migrate ${subvol}: ${rsyncErr.message}`, 'error');
              }
            }
          }
          
          // 8d. Copy non-subvolume files/dirs with rsync (excluding already-migrated subvolumes)
          log('📦 Copying remaining files (non-subvolume data)...', 'info');
          const excludeArgs = subvolumes.flatMap(sv => ['--exclude', sv, '--exclude', `${sv}.migration-snap`]);
          try {
            await executeCommand('sudo', ['-n', 'rsync', '-a', '--info=progress2', ...excludeArgs, '/data/', `${tmpMount}/`]);
            log('✓ Remaining files copied', 'success');
          } catch (e: any) {
            log(`Warning copying remaining files: ${e.message}`, 'warning');
          }
        } else {
          // No subvolumes — plain rsync is fine
          log('📦 Copying data with rsync...', 'info');
          log('This may take a while depending on data size...', 'info');
          const rsyncResult = await executeCommand('sudo', ['-n', 'rsync', '-a', '--info=progress2', '/data/', `${tmpMount}/`]);
          if (rsyncResult.stdout) log(rsyncResult.stdout.trim(), 'info');
          log('✓ Data migration completed', 'success');
        }
      } else {
        log('ℹ️ Old /data is empty, nothing to migrate', 'info');
      }
    } catch (e: any) {
      log(`Warning during data migration: ${e.message}`, 'warning');
      log('⚠ Data migration failed — old data remains on old array', 'warning');
    }
    
    // === Step 9: Swap mounts — switch /data to new array ===
    log('=== Step 9: Switching /data to new array ===', 'step');
    
    // Unmount temporary mount
    try {
      await executeCommand('sudo', ['-n', 'umount', tmpMount]);
      log(`✓ Unmounted ${tmpMount}`, 'success');
    } catch (e: any) {
      log(`Warning unmount tmp: ${e.message}`, 'warning');
    }
    
    // Unmount old /data
    try {
      await executeCommand('sudo', ['-n', 'umount', '-l', '/data']);
      log('✓ Unmounted old /data', 'success');
    } catch (e: any) {
      log(`Warning unmount old /data: ${e.message}`, 'warning');
    }
    
    // Mount new array on /data
    await executeCommand('sudo', ['-n', 'mount', mdDevice, '/data']);
    log(`✓ ${mdDevice} now mounted on /data`, 'success');
    
    // Update fstab to point to new device
    try {
      const fstabResult = await executeCommand('cat', ['/etc/fstab']);
      const fs = require('fs');
      // Remove any old /data entry
      let fstabLines = fstabResult.stdout.split('\n').filter(line => !line.match(/\s+\/data\s+/));
      // Add new entry
      fstabLines.push(`${mdDevice} /data btrfs defaults,nofail 0 0`);
      const tmpFstab = '/tmp/fstab.new';
      fs.writeFileSync(tmpFstab, fstabLines.join('\n') + '\n');
      await executeCommand('sudo', ['-n', 'cp', tmpFstab, '/etc/fstab']);
      fs.unlinkSync(tmpFstab);
      log(`✓ Updated /etc/fstab (${mdDevice} → /data)`, 'success');
    } catch (e: any) {
      log(`Warning fstab: ${e.message}`, 'warning');
    }
    
    // Write clean mdadm.conf (avoid capturing stderr as config data)
    try {
      const scanResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '--scan']);
      const cleanConf = `# mdadm.conf - RAID configuration (auto-generated)\nHOMEHOST <ignore>\n${scanResult.stdout.trim()}\n`;
      const fs = require('fs');
      const tmpConf = '/tmp/mdadm.conf.new';
      fs.writeFileSync(tmpConf, cleanConf);
      await executeCommand('sudo', ['-n', 'cp', tmpConf, '/etc/mdadm/mdadm.conf']);
      fs.unlinkSync(tmpConf);
      log('✓ Written clean /etc/mdadm/mdadm.conf', 'success');
    } catch (e: any) {
      log(`Warning mdadm.conf: ${e.message}`, 'warning');
    }
    
    try {
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log('✓ Updated initramfs', 'success');
    } catch (e: any) {}
    
    // === Step 10: Restart Docker & containerd on new /data ===
    log('=== Step 10: Restarting Docker & containerd ===', 'step');
    
    try {
      log('🔄 Starting containerd...', 'info');
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'containerd']);
      await executeCommand('sleep', ['2']);
      log('✓ containerd started', 'success');
      
      log('🔄 Starting Docker...', 'info');
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker.socket']);
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']);
      await executeCommand('sleep', ['3']);
      log('✓ Docker started', 'success');
      
      // Ensure ryvie-network exists (Docker recreates networks on restart)
      try {
        await executeCommand('sudo', ['-n', 'docker', 'network', 'inspect', 'ryvie-network']);
        log('✓ ryvie-network already exists', 'success');
      } catch (e: any) {
        await executeCommand('sudo', ['-n', 'docker', 'network', 'create', 'ryvie-network']);
        log('✓ ryvie-network created', 'success');
      }
      
      // Verify Docker sees the containers from the migrated data
      const psResult = await executeCommand('sudo', ['-n', 'docker', 'ps', '-a', '--format', '{{.Names}}\t{{.Status}}']);
      const containerLines = psResult.stdout.trim().split('\n').filter(l => l.trim());
      log(`📊 Docker sees ${containerLines.length} container(s) after migration`, 'info');
      for (const line of containerLines.slice(0, 10)) {
        log(`  ${line}`, 'info');
      }
      if (containerLines.length > 10) {
        log(`  ... and ${containerLines.length - 10} more`, 'info');
      }
    } catch (e: any) {
      log(`⚠ Error restarting Docker: ${e.message}`, 'warning');
      log('Docker may need to be restarted manually after reboot', 'warning');
    }
    
    // === Step 11: Final status ===
    log('=== Step 11: Final status ===', 'step');
    
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdDevice]);
      log('📊 RAID status:', 'info');
      log(detailResult.stdout.trim(), 'info');
    } catch (e: any) {}
    
    try {
      const dfResult = await executeCommand('df', ['-h', '/data']);
      log('📊 Filesystem:', 'info');
      log(dfResult.stdout.trim(), 'info');
    } catch (e: any) {}
    
    log('✅ RAID array created and /data migrated successfully!', 'success');
    log('ℹ️ Docker containers have been preserved with their btrfs subvolumes', 'info');
    
    res.json({
      success: true,
      dryRun: false,
      logs,
      mdDevice,
      message: `${level.toUpperCase()} array created on ${mdDevice}, data migrated, /data switched`
    });
  } catch (error: any) {
    console.error('Error creating RAID array:', error);
    log(`Fatal error: ${error.message}`, 'error');
    
    res.status(500).json({
      success: false,
      error: 'Failed to create RAID array',
      details: error.message,
      logs
    });
  }
});

/**
 * POST /api/storage/mdraid-activate
 * Active/réassemble un array RAID existant (reprend le resync après reboot)
 * Body: { array: string }
 */
router.post('/storage/mdraid-activate', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  const { array = '/dev/md0' } = req.body;

  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = { timestamp: new Date().toISOString(), type, message };
    logs.push(logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (io) io.emit('mdraid-log', logEntry);
  };

  try {
    log(`Activating ${array}...`, 'info');
    
    // Try to re-read array
    try {
      await executeCommand('sudo', ['-n', 'mdadm', '--readwrite', array]);
      log(`✓ Array set to read-write`, 'success');
    } catch (e: any) {
      log(`Note: ${e.message}`, 'info');
    }
    
    // Ensure mounted
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'TARGET', '/data']);
      if (findmntResult.stdout.trim()) {
        log('✓ /data already mounted', 'info');
      }
    } catch (e: any) {
      try {
        await executeCommand('sudo', ['-n', 'mount', '/data']);
        log('✓ Mounted /data', 'success');
      } catch (e2: any) {
        log(`Could not mount /data: ${e2.message}`, 'warning');
      }
    }
    
    log('✅ Array activated', 'success');
    
    res.json({ success: true, logs, message: 'Array activated' });
  } catch (error: any) {
    log(`Error: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: 'Failed to activate array',
      details: error.message,
      logs
    });
  }
});

/**
 * POST /api/storage/mdraid-destroy
 * Détruit un array RAID, nettoie les disques, et restaure l'ancien array si possible
 * Body: { array?: string }
 */
router.post('/storage/mdraid-destroy', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  const { array } = req.body;

  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = { timestamp: new Date().toISOString(), type, message };
    logs.push(logEntry);
    console.log(`[${type.toUpperCase()}] ${message}`);
    if (io) io.emit('mdraid-log', logEntry);
  };

  try {
    // Determine which array to destroy
    let targetArray = array;
    if (!targetArray) {
      // First, check if any array is currently syncing/recovering/reshaping
      // If so, prioritize destroying that one
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      
      // Find array with ongoing sync/recovery/reshape
      const syncingMatch = mdstatResult.stdout.match(/(md\d+)\s*:\s*active\s+\S+\s+.+\[\d+\/\d+\].*(?:recovery|resync|reshape)\s*=/);
      if (syncingMatch) {
        targetArray = `/dev/${syncingMatch[1]}`;
        log(`⚠ Found array ${targetArray} with ongoing sync/recovery — targeting it for destruction`, 'warning');
      } else {
        // No syncing array, find the newest non-system array (highest md number)
        const mdNums = [];
        for (const line of mdstatResult.stdout.split('\n')) {
          const match = line.match(/^(md(\d+))\s*:/);
          if (match) mdNums.push(parseInt(match[2]));
        }
        if (mdNums.length === 0) {
          return res.status(400).json({ success: false, error: 'No RAID arrays found' });
        }
        const highest = Math.max(...mdNums);
        if (highest === 0 && mdNums.length === 1) {
          return res.status(400).json({ success: false, error: 'Only md0 exists, cannot destroy system array without explicit target' });
        }
        targetArray = `/dev/md${highest}`;
      }
    }

    log(`🛑 Starting RAID destroy: ${targetArray}`, 'info');

    // === Step 1: Get array members before destroying ===
    log('=== Step 1: Getting array members ===', 'step');
    let members = [];
    let memberDisks = [];
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', targetArray]);
      const lines = detailResult.stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/\s+(\/dev\/\S+)\s*$/);
        if (match) {
          const dev = match[1].trim();
          if (dev.startsWith('/dev/sd') || dev.startsWith('/dev/nvme') || dev.startsWith('/dev/vd')) {
            members.push(dev);
            // Extract base disk (e.g., /dev/sdb1 -> /dev/sdb)
            const diskMatch = dev.match(/^(\/dev\/(?:sd[a-z]+|nvme\d+n\d+|vd[a-z]+))/);
            if (diskMatch && !memberDisks.includes(diskMatch[1])) {
              memberDisks.push(diskMatch[1]);
            }
          }
        }
      }
      log(`Members: ${members.join(', ')}`, 'info');
      log(`Base disks: ${memberDisks.join(', ')}`, 'info');
    } catch (e: any) {
      log(`Could not get array details: ${e.message}`, 'warning');
    }

    // === Step 2: Stop any ongoing sync/recovery/reshape ===
    log('=== Step 2: Stopping any ongoing sync/recovery ===', 'step');
    try {
      const mdName = targetArray.replace('/dev/', '');
      const syncActionPath = `/sys/block/${mdName}/md/sync_action`;
      
      // Check if there's an ongoing operation
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      const targetSection = mdstatResult.stdout.split(/^(?=md\d+\s*:)/m).find(s => s.startsWith(mdName)) || '';
      
      if (targetSection.match(/(recovery|resync|reshape)\s*=/)) {
        log(`⚠ ${targetArray} is syncing — stopping sync first...`, 'warning');
        try {
          await executeCommand('bash', ['-c', `echo idle | sudo -n tee ${syncActionPath} > /dev/null`]);
          log('✓ Stopped sync/recovery operation', 'success');
          await executeCommand('sleep', ['2']);
        } catch (e: any) {
          log(`Could not stop sync: ${e.message}`, 'warning');
        }
      }
    } catch (e: any) {
      log('No sync to stop or already stopped', 'info');
    }

    // === Step 3: Unmount ===
    log('=== Step 3: Unmounting ===', 'step');
    try {
      // Try to unmount the array itself (not just find mountpoints)
      log(`Unmounting ${targetArray}...`, 'info');
      await executeCommand('sudo', ['-n', 'umount', targetArray]);
      log(`✓ Unmounted ${targetArray}`, 'success');
    } catch (e: any) {
      log(`Direct unmount failed: ${e.message}, trying lazy unmount...`, 'warning');
      try {
        await executeCommand('sudo', ['-n', 'umount', '-l', targetArray]);
        log(`✓ Lazy unmounted ${targetArray}`, 'success');
      } catch (e2: any) {
        log('Array not mounted or already unmounted', 'info');
      }
    }

    // === Step 4: Stop the array ===
    log('=== Step 4: Stopping array ===', 'step');
    try {
      await executeCommand('sudo', ['-n', 'mdadm', '--stop', targetArray]);
      log(`✓ Stopped ${targetArray}`, 'success');
    } catch (e: any) {
      log(`Warning stopping array: ${e.message}`, 'warning');
    }
    await executeCommand('sleep', ['1']);

    // === Step 4: Zero superblocks on members ===
    log('=== Step 4: Cleaning member disks ===', 'step');
    for (const member of members) {
      try {
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', member]);
        log(`✓ Zeroed superblock on ${member}`, 'success');
      } catch (e: any) {
        log(`Note: ${member}: ${e.message}`, 'info');
      }
    }

    // === Step 5: Wipe partitions and disks ===
    log('=== Step 5: Wiping disks ===', 'step');
    for (const member of members) {
      try {
        await executeCommand('sudo', ['-n', 'wipefs', '-a', member]);
        log(`✓ Wiped signatures on ${member}`, 'success');
      } catch (e: any) {}
    }
    for (const disk of memberDisks) {
      try {
        await executeCommand('sudo', ['-n', 'wipefs', '-a', disk]);
        await executeCommand('sudo', ['-n', 'sgdisk', '--zap-all', disk]);
        await executeCommand('sudo', ['-n', 'partprobe', disk]);
        log(`✓ Cleaned ${disk} (GPT removed)`, 'success');
      } catch (e: any) {
        log(`Note cleaning ${disk}: ${e.message}`, 'info');
      }
    }
    await executeCommand('sudo', ['-n', 'udevadm', 'settle']);

    // === Step 6: Update mdadm.conf (remove destroyed array) ===
    log('=== Step 6: Updating configuration ===', 'step');
    try {
      const scanResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '--scan']);
      const fs = require('fs');
      const tmpFile = '/tmp/mdadm.conf.new';
      fs.writeFileSync(tmpFile, scanResult.stdout || '');
      await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/mdadm/mdadm.conf']);
      fs.unlinkSync(tmpFile);
      log('✓ Updated /etc/mdadm/mdadm.conf', 'success');
    } catch (e: any) {
      log(`Warning updating mdadm.conf: ${e.message}`, 'warning');
    }

    // Remove destroyed array from fstab if present
    try {
      const fstabResult = await executeCommand('cat', ['/etc/fstab']);
      const fstabLines = fstabResult.stdout.split('\n');
      const filteredLines = fstabLines.filter(line => !line.includes(targetArray));
      if (filteredLines.length !== fstabLines.length) {
        const fs = require('fs');
        const tmpFstab = '/tmp/fstab.new';
        fs.writeFileSync(tmpFstab, filteredLines.join('\n'));
        await executeCommand('sudo', ['-n', 'cp', tmpFstab, '/etc/fstab']);
        fs.unlinkSync(tmpFstab);
        log(`✓ Removed ${targetArray} from /etc/fstab`, 'success');
      }
    } catch (e: any) {
      log(`Warning updating fstab: ${e.message}`, 'warning');
    }

    // === Step 7: Try to restore old md0 if it exists ===
    log('=== Step 7: Restoring previous configuration ===', 'step');
    let oldRestored = false;
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      if (mdstatResult.stdout.includes('md0 :')) {
        // md0 still exists, try to mount it
        try {
          const findmntCheck = await executeCommand('findmnt', ['-no', 'TARGET', '/data']);
          if (!findmntCheck.stdout.trim()) {
            await executeCommand('sudo', ['-n', 'mount', '/dev/md0', '/data']);
            log('✓ Restored /data mount from /dev/md0', 'success');
            oldRestored = true;
          }
        } catch (e: any) {
          try {
            await executeCommand('sudo', ['-n', 'mkdir', '-p', '/data']);
            await executeCommand('sudo', ['-n', 'mount', '/dev/md0', '/data']);
            log('✓ Restored /data mount from /dev/md0', 'success');
            oldRestored = true;
          } catch (e2: any) {
            log(`Could not remount old md0: ${e2.message}`, 'warning');
          }
        }
      }
    } catch (e: any) {}

    if (!oldRestored) {
      log('ℹ️ No previous array to restore, /data is unmounted', 'info');
    }

    try {
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log('✓ Updated initramfs', 'success');
    } catch (e: any) {}

    log('✅ RAID array destroyed and disks cleaned', 'success');

    res.json({
      success: true,
      logs,
      destroyedArray: targetArray,
      cleanedDisks: memberDisks,
      oldArrayRestored: oldRestored,
      message: `${targetArray} destroyed, ${memberDisks.length} disks cleaned${oldRestored ? ', old md0 restored on /data' : ''}`
    });
  } catch (error: any) {
    console.error('Error destroying RAID array:', error);
    log(`Fatal error: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: 'Failed to destroy RAID array',
      details: error.message,
      logs
    });
  }
});

/**
 * POST /api/storage/mdraid-reshape
 * Convertit le niveau RAID d'un array existant (ex: RAID1 -> RAID5)
 * Body: { array: string, targetLevel: string, dryRun?: boolean }
 */
router.post('/storage/mdraid-reshape', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  const { array, targetLevel, dryRun = false } = req.body;

  const logs = [];
  const log = (message, type = 'info') => {
    const logEntry = { timestamp: new Date().toISOString(), type, message };
    logs.push(logEntry);
    console.log(`[mdraid-reshape] [${type}] ${message}`);
    if (io) io.emit('raid-log', logEntry);
  };

  try {
    if (!array || !targetLevel) {
      return res.status(400).json({ success: false, error: 'Missing array or targetLevel parameter' });
    }

    // Validate target level
    const validLevels = ['0', '1', '4', '5', '6', '10'];
    const normalizedLevel = targetLevel.replace('raid', '');
    if (!validLevels.includes(normalizedLevel)) {
      return res.status(400).json({ success: false, error: `Unsupported target RAID level: ${targetLevel}` });
    }

    log(`=== RAID Reshape: ${array} → RAID ${normalizedLevel} ===`, 'step');

    // Step 1: Get current array details
    log('Step 1: Checking current array status...', 'step');
    const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', array]);
    
    const currentLevelMatch = detailResult.stdout.match(/Raid Level\s*:\s*(\S+)/i);
    const stateMatch = detailResult.stdout.match(/State\s*:\s*(.+)/i);
    const activeMatch = detailResult.stdout.match(/Active Devices\s*:\s*(\d+)/i);
    const raidDevicesMatch = detailResult.stdout.match(/Raid Devices\s*:\s*(\d+)/i);
    
    if (!currentLevelMatch) {
      log('❌ Could not determine current RAID level', 'error');
      return res.status(400).json({ success: false, error: 'Could not determine current RAID level', logs });
    }

    const currentLevel = currentLevelMatch[1]; // e.g. "raid1"
    const currentLevelNum = currentLevel.replace('raid', '');
    const state = stateMatch ? stateMatch[1].trim() : 'unknown';
    const activeDevices = activeMatch ? parseInt(activeMatch[1]) : 0;
    const raidDevices = raidDevicesMatch ? parseInt(raidDevicesMatch[1]) : 0;

    log(`Current: ${currentLevel}, State: ${state}, Active devices: ${activeDevices}, Raid devices: ${raidDevices}`, 'info');

    if (currentLevelNum === normalizedLevel) {
      log(`❌ Array is already at RAID level ${normalizedLevel}`, 'error');
      return res.status(400).json({ success: false, error: `Array is already ${currentLevel}`, logs });
    }

    // Step 2: Validate state
    log('Step 2: Validating array state...', 'step');
    if (!state.includes('clean') && !state.includes('active')) {
      log(`❌ Array state is "${state}" — must be clean or active for reshape`, 'error');
      return res.status(400).json({ success: false, error: `Array must be clean/active for reshape (current: ${state})`, logs });
    }

    if (state.includes('resync') || state.includes('recover') || state.includes('reshape')) {
      log(`❌ Array is busy (${state}) — wait for completion before reshaping`, 'error');
      return res.status(400).json({ success: false, error: `Array is busy: ${state}`, logs });
    }

    // Step 3: Validate device count for target level
    log('Step 3: Checking disk count requirements...', 'step');
    const minDisksMap = { '0': 2, '1': 2, '4': 3, '5': 3, '6': 4, '10': 4 };
    const minDisks = minDisksMap[normalizedLevel] || 2;

    if (activeDevices < minDisks) {
      log(`❌ RAID ${normalizedLevel} requires at least ${minDisks} disks, but only ${activeDevices} are active`, 'error');
      return res.status(400).json({ 
        success: false, 
        error: `RAID ${normalizedLevel} requires at least ${minDisks} disks (currently ${activeDevices})`, 
        logs 
      });
    }

    // Step 4: Validate conversion path
    log('Step 4: Validating conversion path...', 'step');
    const allowedConversions = {
      '1': ['0', '5'],
      '5': ['0', '1', '6'],
      '6': ['5'],
      '0': ['5', '6'],
      '10': [],
      '4': ['5']
    };

    const allowed = allowedConversions[currentLevelNum] || [];
    if (!allowed.includes(normalizedLevel)) {
      log(`❌ Conversion from RAID ${currentLevelNum} to RAID ${normalizedLevel} is not supported by mdadm`, 'error');
      return res.status(400).json({ 
        success: false, 
        error: `Conversion from ${currentLevel} to RAID ${normalizedLevel} is not supported. Allowed: ${allowed.map(l => 'RAID ' + l).join(', ') || 'none'}`, 
        logs 
      });
    }

    log(`✓ Conversion ${currentLevel} → RAID ${normalizedLevel} is valid`, 'success');

    // Step 5: Calculate new capacity
    log('Step 5: Estimating new capacity...', 'step');
    let arraySizeMatch = detailResult.stdout.match(/Array Size\s*:\s*(\d+)/i);
    let usedDevSizeMatch = detailResult.stdout.match(/Used Dev Size\s*:\s*(\d+)/i);
    const arraySizeKB = arraySizeMatch ? parseInt(arraySizeMatch[1]) : 0;
    const usedDevSizeKB = usedDevSizeMatch ? parseInt(usedDevSizeMatch[1]) : 0;

    let newCapacityEstimate = '';
    if (usedDevSizeKB > 0) {
      const devSizeGB = (usedDevSizeKB / 1024 / 1024).toFixed(1);
      if (normalizedLevel === '5') {
        const capacityGB = ((activeDevices - 1) * usedDevSizeKB / 1024 / 1024).toFixed(1);
        newCapacityEstimate = `~${capacityGB} GiB (${activeDevices - 1} x ${devSizeGB} GiB)`;
      } else if (normalizedLevel === '0') {
        const capacityGB = (activeDevices * usedDevSizeKB / 1024 / 1024).toFixed(1);
        newCapacityEstimate = `~${capacityGB} GiB (${activeDevices} x ${devSizeGB} GiB)`;
      } else if (normalizedLevel === '6') {
        const capacityGB = ((activeDevices - 2) * usedDevSizeKB / 1024 / 1024).toFixed(1);
        newCapacityEstimate = `~${capacityGB} GiB (${activeDevices - 2} x ${devSizeGB} GiB)`;
      } else if (normalizedLevel === '1') {
        newCapacityEstimate = `~${devSizeGB} GiB (mirrored)`;
      }
    }

    if (newCapacityEstimate) {
      log(`Estimated new capacity: ${newCapacityEstimate}`, 'info');
    }

    // Dry run mode
    if (dryRun) {
      log(`[DRY RUN] Would execute: mdadm --grow ${array} --level=${normalizedLevel} --raid-devices=${activeDevices}`, 'info');
      log('✓ Dry run completed — no changes made', 'success');
      return res.json({ 
        success: true, 
        dryRun: true, 
        logs,
        currentLevel: currentLevel,
        targetLevel: `raid${normalizedLevel}`,
        activeDevices,
        newCapacityEstimate,
        command: `mdadm --grow ${array} --level=${normalizedLevel} --raid-devices=${activeDevices}`
      });
    }

    // Step 6: Execute reshape
    log('Step 6: Starting RAID reshape...', 'step');
    log(`Executing: mdadm --grow ${array} --level=${normalizedLevel} --raid-devices=${activeDevices}`, 'info');

    try {
      const reshapeResult = await executeCommand('sudo', [
        '-n', 'mdadm', '--grow', array, 
        `--level=${normalizedLevel}`,
        `--raid-devices=${activeDevices}`
      ]);
      
      if (reshapeResult.stderr && reshapeResult.stderr.trim()) {
        log(`mdadm output: ${reshapeResult.stderr.trim()}`, 'info');
      }
      if (reshapeResult.stdout && reshapeResult.stdout.trim()) {
        log(`mdadm output: ${reshapeResult.stdout.trim()}`, 'info');
      }
      
      log(`✓ Reshape initiated: ${currentLevel} → RAID ${normalizedLevel}`, 'success');
    } catch (reshapeErr: any) {
      log(`❌ Reshape failed: ${reshapeErr.message}`, 'error');
      if (reshapeErr.stderr) log(`stderr: ${reshapeErr.stderr}`, 'error');
      return res.status(500).json({ success: false, error: `Reshape failed: ${reshapeErr.message}`, logs });
    }

    // Step 7: Update mdadm.conf
    log('Step 7: Updating configuration...', 'step');
    try {
      await executeCommand('sudo', ['-n', 'bash', '-c', 'mdadm --detail --scan > /etc/mdadm/mdadm.conf']);
      log('✓ Updated /etc/mdadm/mdadm.conf', 'success');
    } catch (e: any) {
      log(`Warning: Could not update mdadm.conf: ${e.message}`, 'warning');
    }

    try {
      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log('✓ Updated initramfs', 'success');
    } catch (e: any) {
      log(`Warning: Could not update initramfs: ${e.message}`, 'warning');
    }

    // Step 8: Check if reshape is in progress
    log('Step 8: Checking reshape progress...', 'step');
    try {
      const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
      const mdName = array.replace('/dev/', '');
      const mdstatSections = mdstatResult.stdout.split(/^(?=md\d+\s*:)/m);
      const targetSection = mdstatSections.find(s => s.startsWith(mdName)) || '';
      
      const reshapeMatch = targetSection.match(/reshape\s*=\s*(\d+\.\d+)%/);
      if (reshapeMatch) {
        log(`Reshape in progress: ${reshapeMatch[1]}%`, 'info');
      } else {
        log('Reshape completed immediately or is pending', 'info');
      }
    } catch (e: any) {
      // Not critical
    }

    // Step 9: If filesystem is btrfs, resize after reshape completes
    log('Step 9: Filesystem resize will be needed after reshape completes', 'info');
    log('Run: btrfs filesystem resize max /data', 'info');

    log(`✅ RAID reshape initiated: ${currentLevel} → RAID ${normalizedLevel}`, 'success');

    res.json({
      success: true,
      logs,
      currentLevel,
      targetLevel: `raid${normalizedLevel}`,
      activeDevices,
      newCapacityEstimate,
      message: `Reshape started: ${currentLevel} → RAID ${normalizedLevel}`
    });
  } catch (error: any) {
    console.error('Error during RAID reshape:', error);
    log(`Fatal error: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: 'Failed to reshape RAID array',
      details: error.message,
      logs
    });
  }
});

/**
 * GET /api/storage/mdraid-reshape-options
 * Retourne les conversions RAID possibles pour l'array actuel
 */
router.get('/storage/mdraid-reshape-options', authenticateTokenOrFirstTime, async (req: any, res: any) => {
  try {
    // Détecter le device md monté sur /data
    let mdDevice = '/dev/md0';
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'FSTYPE,SOURCE', '/data']);
      const parts = findmntResult.stdout.trim().split(/\s+/);
      if (parts[1] && parts[1].match(/\/dev\/md\d+/)) {
        mdDevice = parts[1];
      }
    } catch (e: any) {
      try {
        const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
        const match = mdstatResult.stdout.match(/^(md\d+)\s*:/m);
        if (match) mdDevice = '/dev/' + match[1];
      } catch (e2: any) {}
    }

    const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdDevice]);
    
    const levelMatch = detailResult.stdout.match(/Raid Level\s*:\s*(\S+)/i);
    const activeMatch = detailResult.stdout.match(/Active Devices\s*:\s*(\d+)/i);
    const stateMatch = detailResult.stdout.match(/State\s*:\s*(.+)/i);
    const usedDevSizeMatch = detailResult.stdout.match(/Used Dev Size\s*:\s*(\d+)/i);
    
    const currentLevel = levelMatch ? levelMatch[1] : 'unknown';
    const currentLevelNum = currentLevel.replace('raid', '');
    const activeDevices = activeMatch ? parseInt(activeMatch[1]) : 0;
    const state = stateMatch ? stateMatch[1].trim() : 'unknown';
    const usedDevSizeKB = usedDevSizeMatch ? parseInt(usedDevSizeMatch[1]) : 0;

    const allowedConversions = {
      '1': ['0', '5'],
      '5': ['0', '1', '6'],
      '6': ['5'],
      '0': ['5', '6'],
      '10': [],
      '4': ['5']
    };

    const minDisksMap = { '0': 2, '1': 2, '4': 3, '5': 3, '6': 4, '10': 4 };

    const allowed = allowedConversions[currentLevelNum] || [];
    const options = allowed.map(level => {
      const minDisks = minDisksMap[level] || 2;
      const hasEnoughDisks = activeDevices >= minDisks;
      
      let capacityEstimate = '';
      if (usedDevSizeKB > 0) {
        const devSizeGB = usedDevSizeKB / 1024 / 1024;
        if (level === '5') capacityEstimate = `~${((activeDevices - 1) * devSizeGB).toFixed(1)} GiB`;
        else if (level === '0') capacityEstimate = `~${(activeDevices * devSizeGB).toFixed(1)} GiB`;
        else if (level === '6') capacityEstimate = `~${((activeDevices - 2) * devSizeGB).toFixed(1)} GiB`;
        else if (level === '1') capacityEstimate = `~${devSizeGB.toFixed(1)} GiB`;
      }

      return {
        level: `raid${level}`,
        available: hasEnoughDisks,
        minDisks,
        capacityEstimate,
        reason: !hasEnoughDisks ? `Requires at least ${minDisks} disks (you have ${activeDevices})` : null
      };
    });

    const canReshape = state.includes('clean') || state.includes('active');
    const isBusy = state.includes('resync') || state.includes('recover') || state.includes('reshape');

    res.json({
      success: true,
      array: mdDevice,
      currentLevel,
      activeDevices,
      state,
      canReshape: canReshape && !isBusy,
      busyReason: isBusy ? `Array is busy: ${state}` : null,
      options
    });
  } catch (error: any) {
    console.error('Error getting reshape options:', error);
    res.status(500).json({ success: false, error: 'Failed to get reshape options', details: error.message });
  }
});

export = router;
module.exports.setSocketIO = setSocketIO;
