const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getServerInfo } = require('../services/systemService');
const si = require('systeminformation');
const { getLocalIP } = require('../utils/network');

// GET /status (non-authenticated health endpoint)
router.get('/status', (req, res) => {
  res.status(200).json({
    message: 'Server is running',
    serverDetected: false,
    ip: getLocalIP(),
  });
});

// GET /api/server-info
router.get('/server-info', verifyToken, async (req, res) => {
  try {
    const serverInfo = await getServerInfo();
    res.json(serverInfo);
  } catch (error) {
    console.error('Erreur lors de la récupération des informations du serveur :', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération des informations' });
  }
});

// GET /api/storage-detail
router.get('/storage-detail', verifyToken, async (req, res) => {
  try {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    const Docker = require('dockerode');
    const docker = new Docker();

    // 1. Calculer la taille de la partition système
    const fsSizes = await si.fsSize();
    const rootPartition = fsSizes.find(f => f.mount === '/');
    const systemSize = rootPartition ? rootPartition.size / 1e9 : 0;

    // 2. Récupérer toutes les apps
    const { listInstalledApps } = require('../services/appManagerService');
    const apps = await listInstalledApps();

    // 3. Calculer la taille de chaque app
    const appsDetails = [];
    let totalAppsSize = 0;
    const fs = require('fs');
    const path = require('path');

    for (const app of apps) {
      try {
        let appSize = 0;
        console.log(`[Storage Detail] Calcul taille pour app: ${app.id} (${app.name})`);

        // Taille du dossier de l'app dans /data/apps
        // Chercher le dossier avec ou sans préfixe "Ryvie-"
        let appFolder = null;
        try {
          // D'abord essayer avec le préfixe Ryvie-
          let { stdout } = await execPromise(`find /data/apps -maxdepth 1 -type d -iname "Ryvie-${app.id}"`, { timeout: 5000 });
          appFolder = stdout.trim();
          
          // Si pas trouvé, essayer sans préfixe
          if (!appFolder) {
            const result = await execPromise(`find /data/apps -maxdepth 1 -type d -iname "${app.id}"`, { timeout: 5000 });
            appFolder = result.stdout.trim();
          }
          
          // Fallback final
          if (!appFolder) {
            appFolder = `/data/apps/Ryvie-${app.id}`;
          }
        } catch (error) {
          appFolder = `/data/apps/Ryvie-${app.id}`;
        }
        
        console.log(`[Storage Detail] Vérification dossier: ${appFolder}`);
        
        try {
          const { stdout } = await execPromise(`sudo du -sb ${appFolder} 2>/dev/null | cut -f1`, { timeout: 30000 });
          const folderSize = parseInt(stdout.trim()) || 0;
          const folderSizeGB = folderSize / 1e9;
          console.log(`[Storage Detail] Taille dossier ${appFolder}: ${folderSize} bytes (${folderSizeGB.toFixed(2)} GB)`);
          appSize += folderSizeGB;
        } catch (error) {
          console.error(`[Storage Detail] Erreur calcul taille dossier ${appFolder}:`, error.message);
        }

        // Taille des volumes Docker de l'app (liés aux containers de l'app)
        try {
          const containers = await docker.listContainers({ all: true });
          const appContainers = containers.filter(c => {
            const containerName = c.Names[0]?.replace('/', '') || '';
            return containerName.startsWith(`app-${app.id}-`);
          });
          
          const volumeNames = new Set();
          for (const container of appContainers) {
            const containerInfo = await docker.getContainer(container.Id).inspect();
            if (containerInfo.Mounts) {
              for (const mount of containerInfo.Mounts) {
                if (mount.Type === 'volume' && mount.Name) {
                  volumeNames.add(mount.Name);
                }
              }
            }
          }
          
          console.log(`[Storage Detail] Volumes trouvés pour ${app.id}:`, volumeNames.size);
          
          for (const volName of volumeNames) {
            try {
              const volInfo = await docker.getVolume(volName).inspect();
              const { stdout } = await execPromise(`sudo du -sb ${volInfo.Mountpoint} 2>/dev/null | cut -f1`, { timeout: 30000 });
              const volSize = parseInt(stdout.trim()) / 1e9 || 0;
              console.log(`[Storage Detail] Volume ${volName}: ${volSize.toFixed(4)} GB`);
              appSize += volSize;
            } catch (error) {
              console.error(`[Storage Detail] Erreur calcul volume ${volName}:`, error.message);
            }
          }
        } catch (error) {
          console.error(`[Storage Detail] Erreur récupération volumes ${app.id}:`, error.message);
        }

        // Taille des images Docker de l'app (liées aux containers de l'app)
        try {
          const containers = await docker.listContainers({ all: true });
          const appContainers = containers.filter(c => {
            const containerName = c.Names[0]?.replace('/', '') || '';
            return containerName.startsWith(`app-${app.id}-`);
          });
          
          const imageIds = new Set();
          for (const container of appContainers) {
            if (container.ImageID) {
              imageIds.add(container.ImageID);
            }
          }
          
          console.log(`[Storage Detail] Images trouvées pour ${app.id}:`, imageIds.size);
          
          const images = await docker.listImages();
          for (const imageId of imageIds) {
            const img = images.find(i => i.Id === imageId);
            if (img) {
              const imgSize = (img.Size || 0) / 1e9;
              console.log(`[Storage Detail] Image ${img.RepoTags?.[0] || img.Id.substring(0, 12)}: ${imgSize.toFixed(4)} GB`);
              appSize += imgSize;
            }
          }
        } catch (error) {
          console.error(`[Storage Detail] Erreur récupération images ${app.id}:`, error.message);
        }

        // Taille SizeRw des containers
        try {
          const containers = await docker.listContainers({ all: true });
          const appContainers = containers.filter(c => {
            const containerName = c.Names[0]?.replace('/', '') || '';
            return containerName.startsWith(`app-${app.id}-`);
          });
          console.log(`[Storage Detail] Containers trouvés pour ${app.id}:`, appContainers.length);
          
          for (const container of appContainers) {
            const containerInfo = await docker.getContainer(container.Id).inspect();
            const sizeRw = (containerInfo.SizeRw || 0) / 1e9;
            console.log(`[Storage Detail] SizeRw container ${container.Names[0]}: ${sizeRw.toFixed(4)} GB`);
            appSize += sizeRw;
          }
        } catch (error) {
          console.error(`[Storage Detail] Erreur calcul SizeRw ${app.id}:`, error.message);
        }

        // Récupérer l'icône depuis /data/config/manifests/{appId}/
        let iconUrl = null;
        const manifestDir = `/data/config/manifests/${app.id}`;
        const possibleIcons = ['icon.svg', 'icon.png', 'icon.jpg', 'icon.jpeg'];
        
        for (const iconName of possibleIcons) {
          const iconPath = path.join(manifestDir, iconName);
          if (fs.existsSync(iconPath)) {
            iconUrl = `/api/apps/${app.id}/icon`;
            console.log(`[Storage Detail] Icône trouvée pour ${app.id}: ${iconPath} -> ${iconUrl}`);
            break;
          }
        }
        
        if (!iconUrl) {
          console.log(`[Storage Detail] Icône non trouvée pour ${app.id} dans ${manifestDir}`);
        }

        console.log(`[Storage Detail] Taille totale ${app.id}: ${appSize.toFixed(2)} GB`);
        
        totalAppsSize += appSize;
        appsDetails.push({
          id: app.id,
          name: app.name,
          icon: iconUrl,
          size: appSize,
          sizeFormatted: `${appSize.toFixed(2)} GB`
        });
      } catch (error) {
        console.error(`[Storage Detail] Erreur calcul taille app ${app.id}:`, error);
      }
    }

    // Trier par taille décroissante
    appsDetails.sort((a, b) => b.size - a.size);

    // 4. Calculer "Autres" (espace utilisé dans /data moins les apps)
    const dataPartition = fsSizes.find(f => f.mount === '/data');
    let dataUsed = 0;
    try {
      const { stdout } = await execPromise('sudo du -sb /data 2>/dev/null | cut -f1', { timeout: 60000 });
      dataUsed = parseInt(stdout.trim()) / 1e9;
    } catch (error) {
      dataUsed = dataPartition ? dataPartition.used / 1e9 : 0;
    }

    const othersSize = Math.max(0, dataUsed - totalAppsSize);

    // 5. Calculer le total
    const totalUsed = systemSize + dataUsed;
    const totalSize = systemSize + (dataPartition ? dataPartition.size / 1e9 : 0);

    res.json({
      success: true,
      summary: {
        total: totalSize,
        used: totalUsed,
        system: systemSize,
        apps: totalAppsSize,
        others: othersSize,
        totalFormatted: `${totalSize.toFixed(1)} GB`,
        usedFormatted: `${totalUsed.toFixed(1)} GB`,
        systemFormatted: `${systemSize.toFixed(1)} GB`,
        appsFormatted: `${totalAppsSize.toFixed(1)} GB`,
        othersFormatted: `${othersSize.toFixed(1)} GB`
      },
      apps: appsDetails
    });
  } catch (error) {
    console.error('Erreur récupération détail stockage:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du détail du stockage' });
  }
});

// GET /api/disks
router.get('/disks', async (req, res) => {
  try {
    const diskLayout = await si.diskLayout();
    const fsSizes = await si.fsSize();

    const disks = diskLayout.map(d => {
      const totalBytes = d.size;
      const parts = fsSizes.filter(f => f.fs && f.fs.startsWith(d.device));
      const mounted = parts.length > 0;
      let usedBytes, freeBytes;
      if (mounted) {
        usedBytes = parts.reduce((sum, p) => sum + p.used, 0);
        freeBytes = totalBytes - usedBytes;
      } else {
        usedBytes = 0;
        freeBytes = 0;
      }
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

    res.json({
      disks,
      total: {
        size: `${totalSize.toFixed(1)} GB`,
        used: `${totalUsed.toFixed(1)} GB`,
        free: `${totalFree.toFixed(1)} GB`,
      },
    });
  } catch (err) {
    console.error('Erreur récupération info disques :', err);
    res.status(500).json({ error: 'Impossible de récupérer les informations de disques' });
  }
});

module.exports = router;
