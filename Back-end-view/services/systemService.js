const os = require('os');
const si = require('systeminformation');
const osutils = require('os-utils');

async function getServerInfo() {
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const ramUsagePercentage = (((totalRam - freeRam) / totalRam) * 100).toFixed(1);

  const diskLayout = await si.diskLayout();
  const fsSizes = await si.fsSize();

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

  const mountedDisks = disks.filter(d => d.mounted);
  const totalSize = mountedDisks.reduce((sum, d) => sum + parseFloat(d.size), 0);
  const totalUsed = mountedDisks.reduce((sum, d) => sum + parseFloat(d.used), 0);
  const totalFree = mountedDisks.reduce((sum, d) => sum + parseFloat(d.free), 0);

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
