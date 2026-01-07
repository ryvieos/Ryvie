const os = require('os');
const si = require('systeminformation');
const osutils = require('os-utils');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Cache pour getServerInfo (10 secondes)
let serverInfoCache: any = null;
let serverInfoCacheTime = 0;
const CACHE_DURATION = 10000; // 10 secondes

async function getServerInfo() {
  // Retourner le cache si valide
  const now = Date.now();
  if (serverInfoCache && (now - serverInfoCacheTime) < CACHE_DURATION) {
    return serverInfoCache;
  }
  
  // Sinon, calculer les infos
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const ramUsagePercentage = (((totalRam - freeRam) / totalRam) * 100).toFixed(1);

  const diskLayout = await si.diskLayout();
  const fsSizes = await si.fsSize();

  // Compter le nombre d'utilisateurs dans LDAP
  let activeUsersCount = 0;
  try {
    const { listUsersPublic } = require('./ldapService');
    const ldapUsers = await listUsersPublic();
    activeUsersCount = ldapUsers.length;
  } catch (error) {
    console.log('[systemService] Impossible de compter les utilisateurs LDAP:', error);
  }

  // Compter le nombre d'apps installées
  let appsCount = 0;
  try {
    const { listInstalledApps } = require('./appManagerService');
    const installedApps = await listInstalledApps();
    appsCount = installedApps.length;
  } catch (error) {
    console.log('[systemService] Impossible de compter les apps:', error);
  }

  // Vérifier le statut RAID
  let raidStatus = 'inactif';
  try {
    const { stdout } = await execPromise('cat /proc/mdstat 2>/dev/null || echo ""', { timeout: 5000 });
    if (stdout && stdout.includes('active')) {
      raidStatus = 'actif';
    }
  } catch (error) {
    console.log('[systemService] Impossible de vérifier le statut RAID');
  }

  // Trouver la partition racine (/) et /data
  const rootPartition = fsSizes.find(f => f.mount === '/');
  const dataPartition = fsSizes.find(f => f.mount === '/data');
  
  let totalSize = 0;
  let totalUsed = 0;
  let totalFree = 0;

  if (rootPartition) {
    // Total = taille partition système (/) + taille partition /data
    totalSize = rootPartition.size / 1e9;
    if (dataPartition) {
      totalSize += dataPartition.size / 1e9;
    }
    
    // Utilisé = taille partition système + espace utilisé dans /data
    let systemPartitionSize = rootPartition.size / 1e9;
    totalUsed = systemPartitionSize;
    
    // Ajouter l'espace utilisé dans /data (utiliser dataPartition.used qui est cohérent)
    if (dataPartition) {
      const dataUsedGB = dataPartition.used / 1e9;
      totalUsed += dataUsedGB;
      console.log(`[systemService] Système: ${systemPartitionSize.toFixed(1)} GB, /data utilisé: ${dataUsedGB.toFixed(1)} GB, Total: ${totalUsed.toFixed(1)} GB`);
    }
    
    totalFree = totalSize - totalUsed;
  }

  // Informations détaillées sur tous les disques
  const disks = diskLayout.map(d => {
    const totalBytes = d.size;
    const parts = fsSizes.filter(f => f.fs && f.fs.startsWith(d.device));
    const mounted = parts.length > 0;
    const usedBytes = mounted ? parts.reduce((sum, p) => sum + p.used, 0) : 0;
    const freeBytes = mounted ? (totalBytes - usedBytes) : 0;

    return {
      device: d.device,
      size: `${(totalBytes / 1e9).toFixed(1)} GB`,
      used: `${(usedBytes / 1e9).toFixed(1)} GB`,
      free: `${(freeBytes / 1e9).toFixed(1)} GB`,
      mounted,
    };
  });

  const cpuUsagePercentage = await new Promise(resolve => {
    osutils.cpuUsage(u => resolve((u * 100).toFixed(1)));
  });

  const result = {
    stockage: {
      utilise: `${totalUsed.toFixed(1)} GB`,
      libre: `${totalFree.toFixed(1)} GB`,
      total: `${totalSize.toFixed(1)} GB`,
    },
    disques: disks,
    cpu: `${cpuUsagePercentage}%`,
    ram: `${ramUsagePercentage}%`,
    activeUsers: activeUsersCount,
    totalApps: appsCount,
    raidDuplication: raidStatus,
  };
  
  // Mettre en cache le résultat
  serverInfoCache = result;
  serverInfoCacheTime = Date.now();
  
  return result;
}

async function restartServer() {
  const { exec } = require('child_process');
  const util = require('util');
  const execPromise = util.promisify(exec);
  
  try {
    console.log('[systemService] Redémarrage du système demandé');
    
    // Redémarrer le système complet après un délai de 5 secondes
    // Cela permet au serveur de répondre correctement à la requête HTTP
    // et de s'assurer que la réponse est bien envoyée au client
    // avant que le système ne commence à s'arrêter
    setTimeout(async () => {
      try {
        console.log('[systemService] Exécution de sudo reboot...');
        await execPromise('sudo reboot');
      } catch (error: any) {
        console.error('[systemService] Erreur lors du reboot:', error);
      }
    }, 5000);
    
    return { success: true, message: 'Le serveur va redémarrer dans 5 secondes...' };
  } catch (error: any) {
    console.error('[systemService] Erreur lors du redémarrage:', error);
    throw error;
  }
}

export = { getServerInfo, restartServer };
