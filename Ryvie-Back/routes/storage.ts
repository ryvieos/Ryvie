export {};
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { authenticateToken } = require('../middleware/auth');

// Type for command execution result
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const fs = require('fs');

// Named md device — avoids conflict with auto-assembled /dev/md0
const MD_DEVICE_NAME = '/dev/md/ryvie';

// Instance Socket.IO pour les logs en temps réel
let io = null;

/**
 * Find the active RAID array device for /data.
 * Checks /dev/md/ryvie first, then falls back to /dev/md0, then scans /proc/mdstat.
 * Returns the device path or null if none found.
 */
async function findActiveMdDevice(): Promise<string | null> {
  // 1. Check named device
  try {
    await executeCommand('sudo', ['-n', 'mdadm', '--detail', MD_DEVICE_NAME]);
    return MD_DEVICE_NAME;
  } catch (e: any) {}

  // 2. Check /dev/md0
  try {
    await executeCommand('sudo', ['-n', 'mdadm', '--detail', '/dev/md0']);
    return '/dev/md0';
  } catch (e: any) {}

  // 3. Check what /data is mounted on
  try {
    const findmntResult = await executeCommand('findmnt', ['-no', 'SOURCE', '/data']);
    const source = findmntResult.stdout.trim();
    if (source && source.startsWith('/dev/md')) {
      return source;
    }
  } catch (e: any) {}

  return null;
}

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
router.get('/storage/inventory', authenticateToken, async (req: any, res: any) => {
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
router.post('/storage/mdraid-prechecks', authenticateToken, async (req: any, res: any) => {
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
router.post('/storage/mdraid-optimize-and-add', authenticateToken, async (req: any, res: any) => {
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
router.post('/storage/mdraid-add-disk', authenticateToken, async (req: any, res: any) => {
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
 * Récupère l'état du RAID mdadm
 */
router.get('/storage/mdraid-status', authenticateToken, async (req: any, res: any) => {
  try {
    const activeMd = await findActiveMdDevice();
    const status: any = {
      array: activeMd || MD_DEVICE_NAME,
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
      
      status.mounted = (source && source.startsWith('/dev/md') && fstype === 'btrfs');
      status.fstype = fstype;
      status.source = source;
    } catch (error: any) {
      // /data n'est pas monté
    }

    // Vérifier l'état du RAID
    const mdDeviceToCheck = activeMd || MD_DEVICE_NAME;
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', mdDeviceToCheck]);
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
        } catch (e: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      // Erreur lecture mdstat - s'assurer que syncing est false
      status.syncing = false;
    }

    res.json({
      success: true,
      status
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
router.post('/storage/mdraid-stop-resync', authenticateToken, async (req: any, res: any) => {
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
router.post('/storage/mdraid-remove-disk', authenticateToken, async (req: any, res: any) => {
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
 * Récupère les données SMART de tous les disques
 */
router.get('/storage/disk-health', authenticateToken, async (req: any, res: any) => {
  try {
    // Lister les disques physiques
    const lsblkResult = await executeCommand('lsblk', ['-J', '-d', '-o', 'NAME,SIZE,MODEL,SERIAL,TYPE,TRAN,ROTA']);
    const lsblkData = JSON.parse(lsblkResult.stdout);
    const disks = (lsblkData.blockdevices || []).filter((d: any) => d.type === 'disk' && !d.name.includes('sr'));

    const healthData = [];

    for (const disk of disks) {
      const devicePath = `/dev/${disk.name}`;
      const entry: any = {
        device: devicePath,
        name: disk.name,
        size: disk.size,
        model: disk.model || 'Unknown',
        serial: disk.serial || 'N/A',
        transport: disk.tran || 'unknown',
        rotational: disk.rota === true || disk.rota === '1',
        smart: null,
        health: 'unknown',
        temperature: null,
        powerOnHours: null,
        reallocatedSectors: null,
        pendingSectors: null
      };

      try {
        const smartResult = await executeCommand('sudo', ['-n', 'smartctl', '-j', '-a', devicePath]);
        const smartData = JSON.parse(smartResult.stdout);

        // Overall health
        if (smartData.smart_status && smartData.smart_status.passed !== undefined) {
          entry.health = smartData.smart_status.passed ? 'good' : 'failing';
        }

        // Parse SMART attributes
        if (smartData.ata_smart_attributes && smartData.ata_smart_attributes.table) {
          for (const attr of smartData.ata_smart_attributes.table) {
            switch (attr.id) {
              case 194: // Temperature
              case 190:
                entry.temperature = attr.raw?.value ?? null;
                break;
              case 9: // Power-On Hours
                entry.powerOnHours = attr.raw?.value ?? null;
                break;
              case 5: // Reallocated Sectors
                entry.reallocatedSectors = attr.raw?.value ?? null;
                break;
              case 197: // Current Pending Sector
                entry.pendingSectors = attr.raw?.value ?? null;
                break;
            }
          }
        }

        // NVMe attributes
        if (smartData.nvme_smart_health_information_log) {
          const nvme = smartData.nvme_smart_health_information_log;
          entry.temperature = nvme.temperature ?? null;
          entry.powerOnHours = nvme.power_on_hours ?? null;
          entry.reallocatedSectors = null;
          entry.pendingSectors = null;
          if (nvme.media_errors !== undefined && nvme.media_errors > 0) {
            entry.health = 'warning';
          }
        }

        // Compute health score from attributes
        if (entry.reallocatedSectors !== null && entry.reallocatedSectors > 0) {
          entry.health = entry.reallocatedSectors > 100 ? 'failing' : 'warning';
        }
        if (entry.pendingSectors !== null && entry.pendingSectors > 0) {
          entry.health = 'warning';
        }

        entry.smart = {
          available: true,
          enabled: smartData.smart_status !== undefined
        };
      } catch (smartError: any) {
        // smartctl may fail if SMART not supported
        entry.smart = { available: false, enabled: false };
        entry.health = 'unknown';
      }

      healthData.push(entry);
    }

    res.json({
      success: true,
      disks: healthData
    });
  } catch (error: any) {
    console.error('Error fetching disk health:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch disk health data',
      details: error.message
    });
  }
});

/**
 * POST /api/storage/mdraid-create
 * Crée un nouvel array RAID mdadm avec le niveau et les disques choisis
 * Body: { level: string, disks: string[], dryRun: boolean }
 */
router.post('/storage/mdraid-create', authenticateToken, async (req: any, res: any) => {
  const { level, disks: selectedDisks, dryRun = false } = req.body;

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
    // Validate level
    const validLevels = ['raid0', 'raid1', 'raid5', 'raid6', 'raid10'];
    if (!level || !validLevels.includes(level)) {
      return res.status(400).json({
        success: false,
        error: `Invalid RAID level. Must be one of: ${validLevels.join(', ')}`
      });
    }

    // Validate disk count for level
    const minDisks = { raid0: 2, raid1: 2, raid5: 3, raid6: 4, raid10: 4 };
    if (!selectedDisks || !Array.isArray(selectedDisks) || selectedDisks.length < minDisks[level]) {
      return res.status(400).json({
        success: false,
        error: `RAID level ${level} requires at least ${minDisks[level]} disks (got ${selectedDisks?.length || 0})`
      });
    }

    // For RAID10, need even number
    if (level === 'raid10' && selectedDisks.length % 2 !== 0) {
      return res.status(400).json({
        success: false,
        error: 'RAID 10 requires an even number of disks'
      });
    }

    // Validate all disk paths
    for (const disk of selectedDisks) {
      if (!isValidDevicePath(disk)) {
        return res.status(400).json({
          success: false,
          error: `Invalid device path: ${disk}`
        });
      }
    }

    log(`🚀 Creating new ${level.toUpperCase()} array with ${selectedDisks.length} disks`, 'info');
    log(`Level: ${level}`, 'info');
    log(`Disks: ${selectedDisks.join(', ')}`, 'info');
    log(`Dry Run: ${dryRun}`, 'info');

    // Step 0: Detect current state — Docker stays running during RAID creation + bulk rsync
    log('=== Step 0: Detecting current state ===', 'step');

    // Detect if /data is currently mounted (old RAID with data to migrate)
    let oldDataMounted = false;
    let oldDataSource = '';
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'SOURCE', '/data']);
      oldDataSource = findmntResult.stdout.trim();
      if (oldDataSource) {
        oldDataMounted = true;
        log(`/data is currently mounted on ${oldDataSource} — data will be migrated`, 'info');
        log('Docker and apps will stay running during bulk data copy (minimal downtime)', 'info');
      }
    } catch (e: any) {
      log('/data is not mounted — no data to migrate', 'info');
    }

    // Step 1: Verify all disks are not mounted
    log('=== Step 1: Verifying disks ===', 'step');
    for (const disk of selectedDisks) {
      const mountCheck = await isDeviceMounted(disk);
      if (mountCheck.mounted) {
        log(`❌ Disk ${disk} is mounted on ${mountCheck.mountpoint}`, 'error');
        // Try to restart Docker before failing
        try { await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']); } catch (e: any) {}
        return res.status(400).json({
          success: false,
          error: `Disk ${disk} is mounted on ${mountCheck.mountpoint}`,
          logs
        });
      }
      log(`✓ ${disk} is not mounted`, 'success');
    }

    // Step 2: Determine partition sizes (use smallest disk as reference)
    log('=== Step 2: Calculating partition sizes ===', 'step');
    let minSizeBytes = Infinity;
    const diskSizes = {};
    for (const disk of selectedDisks) {
      const sizeResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', disk]);
      const sizeBytes = parseInt(sizeResult.stdout.trim());
      diskSizes[disk] = sizeBytes;
      if (sizeBytes < minSizeBytes) minSizeBytes = sizeBytes;
      log(`${disk}: ${Math.floor(sizeBytes / 1024 / 1024)} MiB`, 'info');
    }
    const partEndMiB = Math.floor((minSizeBytes - 2 * 1024 * 1024) / 1024 / 1024);
    log(`Partition size per disk: ${partEndMiB} MiB`, 'info');

    if (dryRun) {
      log('🔍 DRY RUN MODE - No changes will be made', 'warning');
      log('=== Commands that would be executed ===', 'step');
      const partPaths = [];
      selectedDisks.forEach((disk, i) => {
        const label = `ryvie_${String.fromCharCode(97 + i)}`;
        const partPath = getPartitionPath(disk, 1);
        partPaths.push(partPath);
        log(`wipefs -a ${disk}`, 'info');
        log(`parted -s ${disk} mklabel gpt`, 'info');
        log(`parted -s ${disk} mkpart primary 1MiB ${partEndMiB}MiB`, 'info');
        log(`parted -s ${disk} name 1 ${label}`, 'info');
        log(`parted -s ${disk} set 1 raid on`, 'info');
      });
      const mdLevel = level.replace('raid', '');
      log(`mdadm --create ${MD_DEVICE_NAME} --level=${mdLevel} --raid-devices=${selectedDisks.length} ${partPaths.join(' ')}`, 'info');
      log(`mkfs.btrfs ${MD_DEVICE_NAME}`, 'info');
      log(`mount ${MD_DEVICE_NAME} /data`, 'info');
      log('✓ Dry run completed', 'success');

      return res.json({
        success: true,
        dryRun: true,
        logs,
        message: 'Dry run completed - no changes made'
      });
    }

    // Step 3: Prepare all disks
    log('=== Step 3: Preparing disks ===', 'step');
    const partitionPaths = [];

    for (let i = 0; i < selectedDisks.length; i++) {
      const disk = selectedDisks[i];
      const label = `ryvie_${String.fromCharCode(97 + i)}`;
      const partPath = getPartitionPath(disk, 1);
      partitionPaths.push(partPath);

      log(`--- Preparing ${disk} ---`, 'info');

      try {
        log(`Wiping ${disk}...`, 'info');
        await executeCommand('sudo', ['-n', 'wipefs', '-a', disk]);
        log(`✓ Wiped`, 'success');
      } catch (e: any) {
        log(`Error wiping ${disk}: ${e.message}`, 'error');
        throw e;
      }

      try {
        log(`Creating GPT table on ${disk}...`, 'info');
        await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mklabel', 'gpt']);
        log(`✓ GPT table created`, 'success');
      } catch (e: any) {
        log(`Error creating GPT: ${e.message}`, 'error');
        throw e;
      }

      try {
        log(`Creating partition (1MiB to ${partEndMiB}MiB)...`, 'info');
        await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'mkpart', 'primary', '1MiB', `${partEndMiB}MiB`]);
        await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'name', '1', label]);
        await executeCommand('sudo', ['-n', 'parted', '-s', disk, 'set', '1', 'raid', 'on']);
        log(`✓ Partition created: ${partPath} (${label})`, 'success');
      } catch (e: any) {
        log(`Error creating partition: ${e.message}`, 'error');
        throw e;
      }

      await executeCommand('sudo', ['-n', 'partprobe', disk]);
    }

    await executeCommand('sudo', ['-n', 'udevadm', 'settle']);
    await executeCommand('sleep', ['2']);

    // Wipe superblocks on all new partitions
    for (const partPath of partitionPaths) {
      try {
        await executeCommand('sudo', ['-n', 'wipefs', '-a', partPath]);
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', partPath]);
      } catch (e: any) {
        // OK if no superblock
      }
    }

    // === Pre-create: ensure no stale arrays use the NEW partitions ===
    log('Checking for stale arrays on new partitions...', 'info');
    for (const partPath of partitionPaths) {
      try {
        const examResult = await executeCommand('sudo', ['-n', 'mdadm', '--examine', partPath]);
        // If mdadm --examine succeeds, there's a superblock — wipe it again
        await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', '--force', partPath]);
        await executeCommand('sudo', ['-n', 'wipefs', '-af', partPath]);
        log(`Wiped residual superblock on ${partPath}`, 'warning');
      } catch (e: any) {
        // No superblock — good
      }
    }

    // Step 4: Create the RAID array
    log('=== Step 4: Creating RAID array ===', 'step');
    const mdLevel = level.replace('raid', '');

    // Restore raid speed limit
    try {
      await executeCommand('sudo', ['-n', 'bash', '-c', 'echo 200000 > /proc/sys/dev/raid/speed_limit_max']);
    } catch (e: any) {}

    try {
      // Ensure /dev/md directory exists
      await executeCommand('sudo', ['-n', 'mkdir', '-p', '/dev/md']);
      const createArgs = [
        '-n', 'mdadm', '--create', MD_DEVICE_NAME,
        '--level=' + mdLevel,
        '--raid-devices=' + selectedDisks.length,
        '--name=ryvie',
        '--homehost=any',
        '--run', '--force',
        ...partitionPaths
      ];
      log(`Running: mdadm --create ${MD_DEVICE_NAME} --level=${mdLevel} --raid-devices=${selectedDisks.length} ${partitionPaths.join(' ')}`, 'info');
      await executeCommand('sudo', createArgs);
      log(`✓ RAID array created: ${MD_DEVICE_NAME} (${level.toUpperCase()})`, 'success');
    } catch (e: any) {
      log(`Error creating array: ${e.message}`, 'error');
      throw e;
    }

    // Step 4b: Verify the new array is correct (not the old one re-assembled)
    try {
      const verifyResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', MD_DEVICE_NAME]);
      const verifyOutput = verifyResult.stdout;
      const raidLevelMatch = verifyOutput.match(/Raid Level\s*:\s*(\S+)/);
      const actualLevel = raidLevelMatch ? raidLevelMatch[1] : 'unknown';
      const expectedLevel = `raid${mdLevel}`;
      if (actualLevel !== expectedLevel) {
        log(`❌ FATAL: ${MD_DEVICE_NAME} is ${actualLevel} but expected ${expectedLevel} — old array re-assembled!`, 'error');
        // Try to stop it and abort
        try { await executeCommand('sudo', ['-n', 'mdadm', '--stop', MD_DEVICE_NAME]); } catch (e: any) {}
        try { await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']); } catch (e: any) {}
        return res.status(500).json({
          success: false,
          error: `Array verification failed: ${MD_DEVICE_NAME} is ${actualLevel}, expected ${expectedLevel}. The old array may have re-assembled. Please reboot and try again.`,
          logs
        });
      }
      // Also verify member count
      const deviceLines = verifyOutput.split('\n').filter((l: string) => /^\s+\d+\s+\d+\s+\d+/.test(l));
      log(`✓ Verified: ${MD_DEVICE_NAME} is ${actualLevel} with ${deviceLines.length} device(s)`, 'success');
    } catch (e: any) {
      log(`Warning: Could not verify array: ${e.message}`, 'warning');
    }

    // Step 5: Create filesystem on new RAID
    log('=== Step 5: Creating btrfs filesystem ===', 'step');
    try {
      await executeCommand('sudo', ['-n', 'mkfs.btrfs', '-f', MD_DEVICE_NAME]);
      log(`✓ btrfs filesystem created on ${MD_DEVICE_NAME}`, 'success');
    } catch (e: any) {
      log(`Error creating filesystem: ${e.message}`, 'error');
      throw e;
    }

    // Step 6: Data migration — two-pass rsync for minimal downtime
    // Pass 1: bulk rsync WITH Docker running (apps stay accessible)
    // Pass 2: stop Docker, quick incremental rsync, swap mounts (downtime ~1-2 min)
    log('=== Step 6: Data migration ===', 'step');
    const tmpMount = '/mnt/new_raid';

    // Collect old RAID members BEFORE we stop anything (needed later for cleanup)
    let oldMdMembers: string[] = [];
    if (oldDataMounted && oldDataSource) {
      try {
        const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', oldDataSource]);
        const lines = detailResult.stdout.split('\n').filter((l: string) => /^\s+\d+\s+\d+\s+\d+/.test(l));
        for (const line of lines) {
          const match = line.match(/(\/dev\/\S+)/);
          if (match && !oldMdMembers.includes(match[1])) oldMdMembers.push(match[1]);
        }
        log(`Old RAID members: ${oldMdMembers.join(', ')}`, 'info');
      } catch (e: any) {
        // Try known partitions
        try {
          await executeCommand('sudo', ['-n', 'mdadm', '--examine', '/dev/sda6']);
          oldMdMembers.push('/dev/sda6');
          log('Old RAID member detected: /dev/sda6', 'info');
        } catch (e2: any) {}
      }
    }

    if (oldDataMounted) {
      // 6a: Mount new RAID on temporary mount point
      try {
        await executeCommand('sudo', ['-n', 'mkdir', '-p', tmpMount]);
        await executeCommand('sudo', ['-n', 'mount', '-o', 'defaults,noatime,compress=zstd,space_cache=v2', MD_DEVICE_NAME, tmpMount]);
        log(`✓ Mounted new RAID (${MD_DEVICE_NAME}) on ${tmpMount}`, 'success');
      } catch (e: any) {
        log(`Error mounting new RAID on ${tmpMount}: ${e.message}`, 'error');
        throw e;
      }

      // 6b: PASS 1 — Bulk rsync WITH Docker still running (zero downtime)
      log('📦 Pass 1: Bulk data copy (Docker still running, apps accessible)...', 'info');
      log('This may take a while depending on the amount of data...', 'info');
      try {
        const rsyncResult = await executeCommand('sudo', ['-n', 'rsync', '-aHAX', '--info=progress2', '/data/', `${tmpMount}/`]);
        log('✓ Pass 1 completed — bulk data copied', 'success');
        if (rsyncResult.stdout) {
          const lastLines = rsyncResult.stdout.split('\n').filter((l: string) => l.trim()).slice(-3);
          for (const line of lastLines) {
            log(`  rsync: ${line.trim()}`, 'info');
          }
        }
      } catch (e: any) {
        log(`Error during bulk copy: ${e.message}`, 'error');
        try { await executeCommand('sudo', ['-n', 'umount', tmpMount]); } catch (umErr: any) {}
        throw e;
      }

      // 6c: Stop Docker — START of brief downtime
      log('⏸ Stopping Docker for final sync (brief downtime starts now)...', 'warning');
      try {
        await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'docker.socket']);
        await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'docker']);
        log('✓ Docker stopped', 'success');
      } catch (e: any) {
        log(`Warning: Could not stop Docker: ${e.message}`, 'warning');
      }
      try {
        await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'containerd']);
        log('✓ containerd stopped', 'success');
      } catch (e: any) {}

      await executeCommand('sleep', ['2']);

      // Kill any remaining processes using /data
      try {
        await executeCommand('sudo', ['-n', 'fuser', '-km', '/data']);
        await executeCommand('sleep', ['1']);
      } catch (e: any) {}

      // 6d: PASS 2 — Quick incremental rsync (only changed files since pass 1)
      log('📦 Pass 2: Incremental sync (only changes since pass 1)...', 'info');
      try {
        const rsync2Result = await executeCommand('sudo', ['-n', 'rsync', '-aHAX', '--delete', '--info=progress2', '/data/', `${tmpMount}/`]);
        log('✓ Pass 2 completed — all data synchronized', 'success');
        if (rsync2Result.stdout) {
          const lastLines = rsync2Result.stdout.split('\n').filter((l: string) => l.trim()).slice(-3);
          for (const line of lastLines) {
            log(`  rsync: ${line.trim()}`, 'info');
          }
        }
      } catch (e: any) {
        log(`Error during incremental sync: ${e.message}`, 'error');
        // Abort — restart Docker on old RAID
        try { await executeCommand('sudo', ['-n', 'umount', tmpMount]); } catch (umErr: any) {}
        try { await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']); } catch (restartErr: any) {}
        throw e;
      }

      // 6e: Swap mounts — unmount temp, unmount old /data, mount new on /data
      log('🔄 Swapping mounts...', 'info');
      try {
        await executeCommand('sudo', ['-n', 'umount', tmpMount]);
        log(`✓ Unmounted ${tmpMount}`, 'success');
      } catch (e: any) {
        log(`Warning: Could not unmount ${tmpMount}: ${e.message}`, 'warning');
      }

      // Unmount old /data (may be mounted multiple times)
      let unmountAttempts = 0;
      while (unmountAttempts < 5) {
        try {
          await executeCommand('sudo', ['-n', 'umount', '/data']);
          unmountAttempts++;
        } catch (e: any) {
          break;
        }
      }
      if (unmountAttempts > 0) {
        log(`✓ Unmounted old /data (${unmountAttempts} mount(s))`, 'success');
      }

      // 6f: Stop old RAID array
      if (oldDataSource && oldDataSource.startsWith('/dev/md')) {
        try {
          await executeCommand('sudo', ['-n', 'mdadm', '--stop', oldDataSource]);
          log(`✓ Stopped old array ${oldDataSource}`, 'success');
        } catch (e: any) {
          log(`Warning: Could not stop old array ${oldDataSource}: ${e.message}`, 'warning');
        }
      }

      // 6g: Destroy old RAID — zero superblocks and delete partition from parent disk
      log('🗑 Destroying old RAID...', 'info');
      const oldMembersNotOnNewDisks = oldMdMembers.filter(m => !selectedDisks.some(d => m.startsWith(d)));

      for (const member of oldMembersNotOnNewDisks) {
        try {
          await executeCommand('sudo', ['-n', 'wipefs', '-af', member]);
          await executeCommand('sudo', ['-n', 'mdadm', '--zero-superblock', '--force', member]);
          const partMatch = member.match(/^(\/dev\/[a-z]+)(\d+)$/) || member.match(/^(\/dev\/nvme\d+n\d+)p(\d+)$/);
          if (partMatch) {
            const parentDisk = partMatch[1];
            const partNum = partMatch[2];
            log(`Deleting partition ${partNum} from ${parentDisk} (old RAID member ${member})...`, 'info');
            await executeCommand('sudo', ['-n', 'sfdisk', '--delete', parentDisk, partNum]);
            await executeCommand('sudo', ['-n', 'partprobe', parentDisk]);
            log(`✓ Deleted ${member} from partition table`, 'success');
          }
        } catch (e: any) {
          log(`Warning: Could not fully clean up ${member}: ${e.message}`, 'warning');
        }
      }

    } else {
      log('No existing data to migrate — fresh install', 'info');
      // No old RAID — stop Docker if running (for clean mount)
      try {
        await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'docker.socket']);
        await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'docker']);
        await executeCommand('sudo', ['-n', 'systemctl', 'stop', 'containerd']);
      } catch (e: any) {}
    }

    // Step 6h: Mount new RAID on /data
    log('Mounting new RAID on /data...', 'info');
    try {
      await executeCommand('sudo', ['-n', 'mkdir', '-p', '/data']);
      await executeCommand('sudo', ['-n', 'mount', '-o', 'defaults,noatime,compress=zstd,space_cache=v2', MD_DEVICE_NAME, '/data']);
      log(`✓ Mounted ${MD_DEVICE_NAME} on /data (btrfs, compress=zstd)`, 'success');
    } catch (e: any) {
      log(`Error mounting: ${e.message}`, 'error');
      try { await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']); } catch (restartErr: any) {}
      throw e;
    }

    // Step 6i: Ensure essential /data directories exist (in case of fresh install)
    if (!oldDataMounted) {
      log('Creating essential /data directories...', 'info');
      const essentialDirs = ['/data/apps', '/data/config', '/data/docker', '/data/logs', '/data/images', '/data/snapshot'];
      for (const dir of essentialDirs) {
        try {
          await executeCommand('sudo', ['-n', 'mkdir', '-p', dir]);
        } catch (e: any) {}
      }
      try {
        await executeCommand('sudo', ['-n', 'chown', '-R', 'ryvie:ryvie', '/data/apps', '/data/config', '/data/logs', '/data/images']);
      } catch (e: any) {}
      log('✓ Essential directories created', 'success');
    }

    // Step 7: Save mdadm config + update fstab
    log('=== Step 7: Saving configuration ===', 'step');
    try {
      const scanResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', '--scan']);
      const tmpFile = '/tmp/mdadm.conf.new';
      fs.writeFileSync(tmpFile, scanResult.stdout);
      await executeCommand('sudo', ['-n', 'cp', tmpFile, '/etc/mdadm/mdadm.conf']);
      fs.unlinkSync(tmpFile);
      log(`✓ Updated /etc/mdadm/mdadm.conf`, 'success');

      await executeCommand('sudo', ['-n', 'update-initramfs', '-u']);
      log(`✓ Updated initramfs`, 'success');
    } catch (e: any) {
      log(`Warning: Config save: ${e.message}`, 'warning');
    }

    // Step 7b: Update /etc/fstab with new UUID
    log('Updating /etc/fstab...', 'info');
    try {
      const blkidResult = await executeCommand('sudo', ['-n', 'blkid', '-s', 'UUID', '-o', 'value', MD_DEVICE_NAME]);
      const newUUID = blkidResult.stdout.trim();
      if (newUUID) {
        log(`New ${MD_DEVICE_NAME} UUID: ${newUUID}`, 'info');

        // Read current fstab
        const fstabResult = await executeCommand('cat', ['/etc/fstab']);
        const fstabLines = fstabResult.stdout.split('\n');
        let foundDataEntry = false;
        const newFstabLines = fstabLines.map((line: string) => {
          // Match any line that mounts /data (by UUID or device)
          if (line.match(/\s+\/data\s+/) && !line.startsWith('#')) {
            foundDataEntry = true;
            return `UUID=${newUUID}  /data  btrfs  defaults,noatime,compress=zstd,space_cache=v2  0  0`;
          }
          return line;
        });

        if (!foundDataEntry) {
          // Add new entry if none exists
          newFstabLines.push(`UUID=${newUUID}  /data  btrfs  defaults,noatime,compress=zstd,space_cache=v2  0  0`);
        }

        const tmpFstab = '/tmp/fstab.new';
        fs.writeFileSync(tmpFstab, newFstabLines.join('\n'));
        await executeCommand('sudo', ['-n', 'cp', tmpFstab, '/etc/fstab']);
        fs.unlinkSync(tmpFstab);
        log(`✓ Updated /etc/fstab with UUID=${newUUID}`, 'success');
      } else {
        log(`⚠ Could not get UUID of ${MD_DEVICE_NAME}`, 'warning');
      }
    } catch (e: any) {
      log(`Warning: fstab update: ${e.message}`, 'warning');
    }

    // Step 7c: Restart Docker and containerd
    log('Restarting Docker...', 'info');
    try {
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'containerd']);
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker.socket']);
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']);
      log('✓ Docker restarted', 'success');
    } catch (e: any) {
      log(`Warning: Could not restart Docker: ${e.message}`, 'warning');
    }

    // Step 8: Monitor initial sync (for raid5/6/10)
    if (level !== 'raid0') {
      log('=== Step 8: Monitoring initial sync ===', 'step');
      try {
        const mdstatResult = await executeCommand('cat', ['/proc/mdstat']);
        if (mdstatResult.stdout.includes('recovery') || mdstatResult.stdout.includes('resync')) {
          log('🔄 Resynchronization started...', 'info');

          let lastProgress = -1;
          let resyncComplete = false;
          const maxWaitMinutes = 120;
          const startTime = Date.now();

          while (!resyncComplete) {
            await executeCommand('sleep', ['3']);

            const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
            if (elapsedMinutes > maxWaitMinutes) {
              log('⚠ Resync monitoring timeout - continuing in background', 'warning');
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
          log('✓ No resync needed (instant sync)', 'success');
        }
      } catch (e: any) {
        log(`Could not monitor resync: ${e.message}`, 'warning');
      }
    }

    // Final status
    log('=== Final status ===', 'step');
    try {
      const detailResult = await executeCommand('sudo', ['-n', 'mdadm', '--detail', MD_DEVICE_NAME]);
      log(detailResult.stdout.trim(), 'info');
      const dfResult = await executeCommand('df', ['-h', '/data']);
      log(dfResult.stdout.trim(), 'info');
    } catch (e: any) {}

    log(`✅ ${level.toUpperCase()} array created successfully with ${selectedDisks.length} disks!`, 'success');

    res.json({
      success: true,
      logs,
      message: `${level.toUpperCase()} array created successfully`
    });
  } catch (error: any) {
    console.error('Error creating RAID array:', error);
    log(`Fatal error: ${error.message}`, 'error');

    // Try to restart Docker on failure
    try {
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'containerd']);
      await executeCommand('sudo', ['-n', 'systemctl', 'start', 'docker']);
      log('Docker restarted after failure', 'info');
    } catch (restartErr: any) {}

    res.status(500).json({
      success: false,
      error: 'Failed to create RAID array',
      details: error.message,
      logs
    });
  }
});

/**
 * POST /api/storage/mdraid-create-prechecks
 * Pré-vérifications pour la création d'un nouvel array RAID
 * Body: { level: string, disks: string[] }
 */
router.post('/storage/mdraid-create-prechecks', authenticateToken, async (req: any, res: any) => {
  try {
    const { level, disks: selectedDisks } = req.body;
    const reasons = [];
    const plan = [];
    let canProceed = true;

    const validLevels = ['raid0', 'raid1', 'raid5', 'raid6', 'raid10'];
    if (!level || !validLevels.includes(level)) {
      return res.status(400).json({ success: false, error: 'Invalid RAID level' });
    }

    const minDisks = { raid0: 2, raid1: 2, raid5: 3, raid6: 4, raid10: 4 };
    if (!selectedDisks || !Array.isArray(selectedDisks) || selectedDisks.length < minDisks[level]) {
      reasons.push(`❌ ${level.toUpperCase()} requires at least ${minDisks[level]} disks (got ${selectedDisks?.length || 0})`);
      canProceed = false;
    } else {
      reasons.push(`✓ ${selectedDisks.length} disks selected (minimum ${minDisks[level]} for ${level.toUpperCase()})`);
    }

    if (level === 'raid10' && selectedDisks && selectedDisks.length % 2 !== 0) {
      reasons.push(`❌ RAID 10 requires an even number of disks`);
      canProceed = false;
    }

    // Check if an md array already exists
    const existingMd = await findActiveMdDevice();
    if (existingMd) {
      reasons.push(`⚠ ${existingMd} already exists - it will be stopped and recreated`);
    } else {
      reasons.push(`✓ No existing RAID array found`);
    }

    // Check if /data is already mounted
    try {
      const findmntResult = await executeCommand('findmnt', ['-no', 'SOURCE', '/data']);
      const source = findmntResult.stdout.trim();
      if (source) {
        reasons.push(`⚠ /data is currently mounted on ${source} - will need to be unmounted`);
      }
    } catch (e: any) {
      reasons.push(`✓ /data is not currently mounted`);
    }

    // Check each disk
    let minSizeBytes = Infinity;
    if (selectedDisks && Array.isArray(selectedDisks)) {
      for (const disk of selectedDisks) {
        if (!isValidDevicePath(disk)) {
          reasons.push(`❌ Invalid device path: ${disk}`);
          canProceed = false;
          continue;
        }

        const mountCheck = await isDeviceMounted(disk);
        if (mountCheck.mounted) {
          reasons.push(`❌ ${disk} is mounted on ${mountCheck.mountpoint}`);
          canProceed = false;
        } else {
          reasons.push(`✓ ${disk} is not mounted`);
        }

        try {
          const sizeResult = await executeCommand('lsblk', ['-b', '-no', 'SIZE', disk]);
          const sizeBytes = parseInt(sizeResult.stdout.trim());
          if (sizeBytes < minSizeBytes) minSizeBytes = sizeBytes;
          reasons.push(`✓ ${disk} size: ${Math.floor(sizeBytes / 1024 / 1024)} MiB`);
        } catch (e: any) {
          reasons.push(`❌ Cannot read size of ${disk}`);
          canProceed = false;
        }
      }
    }

    // Compute expected capacity
    let expectedCapacity = 0;
    const partSize = minSizeBytes !== Infinity ? minSizeBytes - 2 * 1024 * 1024 : 0;
    const diskCount = selectedDisks?.length || 0;
    switch (level) {
      case 'raid0': expectedCapacity = partSize * diskCount; break;
      case 'raid1': expectedCapacity = partSize; break;
      case 'raid5': expectedCapacity = partSize * (diskCount - 1); break;
      case 'raid6': expectedCapacity = partSize * (diskCount - 2); break;
      case 'raid10': expectedCapacity = partSize * (diskCount / 2); break;
    }

    if (expectedCapacity > 0) {
      reasons.push(`✓ Expected usable capacity: ${Math.floor(expectedCapacity / 1024 / 1024 / 1024)} GiB`);
    }

    // Build plan
    if (canProceed && selectedDisks) {
      const partEndMiB = Math.floor(partSize / 1024 / 1024);
      const partPaths = [];
      selectedDisks.forEach((disk, i) => {
        const label = `ryvie_${String.fromCharCode(97 + i)}`;
        const partPath = getPartitionPath(disk, 1);
        partPaths.push(partPath);
        plan.push(`wipefs -a ${disk}`);
        plan.push(`parted -s ${disk} mklabel gpt`);
        plan.push(`parted -s ${disk} mkpart primary 1MiB ${partEndMiB}MiB`);
        plan.push(`parted -s ${disk} name 1 ${label}`);
        plan.push(`parted -s ${disk} set 1 raid on`);
      });
      const mdLevel = level.replace('raid', '');
      plan.push(`mdadm --create ${MD_DEVICE_NAME} --level=${mdLevel} --raid-devices=${diskCount} ${partPaths.join(' ')}`);
      plan.push(`mkfs.btrfs -f ${MD_DEVICE_NAME}`);
      plan.push(`mount ${MD_DEVICE_NAME} /data`);
      plan.push(`mdadm --detail --scan > /etc/mdadm/mdadm.conf`);
      plan.push(`update-initramfs -u`);
    }

    res.json({
      success: true,
      canProceed,
      reasons,
      plan,
      expectedCapacity,
      level,
      diskCount
    });
  } catch (error: any) {
    console.error('Error during create prechecks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform pre-checks',
      details: error.message
    });
  }
});

export = router;
module.exports.setSocketIO = setSocketIO;