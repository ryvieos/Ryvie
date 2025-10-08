const os = require('os');
const si = require('systeminformation');
const osutils = require('os-utils');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function getServerInfo() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const ramUsagePercentage = (((totalRam - freeRam) / totalRam) * 100).toFixed(1);

  const diskLayout = await si.diskLayout();
  const fsSizes = await si.fsSize();

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
    
    // Utilisé = taille partition système (sans /data) + espace réellement utilisé dans /data
    // Calculer la taille de la partition système sans /data
    let systemPartitionSize = rootPartition.size / 1e9;
    totalUsed = systemPartitionSize;
    
    // Ajouter l'espace réellement utilisé dans /data via du
    // Timeout réduit à 5s pour éviter de bloquer l'API, fallback sur dataPartition.used
    try {
      const { stdout } = await execPromise('sudo du -sb /data 2>/dev/null | cut -f1', { timeout: 5000 });
      const dataUsageBytes = parseInt(stdout.trim());
      if (dataUsageBytes && !isNaN(dataUsageBytes)) {
        totalUsed += dataUsageBytes / 1e9;
      }
    } catch (error) {
      // Fallback sur dataPartition.used si du échoue ou timeout
      if (dataPartition) {
        totalUsed += dataPartition.used / 1e9;
      }
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

  return {
    stockage: {
      utilise: `${totalUsed.toFixed(1)} GB`,
      libre: `${totalFree.toFixed(1)} GB`,
      total: `${totalSize.toFixed(1)} GB`,
    },
    disques: disks,
    cpu: `${cpuUsagePercentage}%`,
    ram: `${ramUsagePercentage}%`,
  };
}

module.exports = { getServerInfo };
