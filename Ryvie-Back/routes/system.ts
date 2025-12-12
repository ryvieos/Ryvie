const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { getServerInfo, restartServer } = require('../services/systemService');
const si = require('systeminformation');
const { getLocalIP } = require('../utils/network');
const { APPS_DIR, MANIFESTS_DIR } = require('../config/paths');

// GET /status (non-authenticated health endpoint)
router.get('/status', (req: any, res: any) => {
  res.status(200).json({
    message: 'Server is running',
    serverDetected: false,
    ip: getLocalIP(),
  });
});

// GET /api/server-info
router.get('/server-info', verifyToken, async (req: any, res: any) => {
  try {
    const serverInfo = await getServerInfo();
    res.json(serverInfo);
  } catch (error: any) {
    console.error('Erreur lors de la récupération des informations du serveur :', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération des informations' });
  }
});

// GET /api/storage-detail
router.get('/storage-detail', verifyToken, async (req: any, res: any) => {
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

    // 3. Calculer la taille de chaque app (dossier + volumes + images)
    const appsDetails = [];
    let totalAppsSize = 0;
    const fs = require('fs');
    const path = require('path');

    for (const app of apps) {
      try {
        let appSize = 0;
        console.log(`[Storage Detail] Calcul taille pour app: ${app.id} (${app.name})`);

        // Taille du dossier de l'app dans APPS_DIR
        // Chercher tous les dossiers qui contiennent l'id de l'app (insensible à la casse)
        try {
          if (fs.existsSync(APPS_DIR)) {
            const appsDirs = fs.readdirSync(APPS_DIR, { withFileTypes: true })
              .filter(dirent => dirent.isDirectory())
              .map(dirent => dirent.name);
            
            // Chercher un dossier qui contient l'id de l'app
            const matchingDir = appsDirs.find(dir => 
              dir.toLowerCase().includes(app.id.toLowerCase())
            );
            
            if (matchingDir) {
              const appFolder = `${APPS_DIR}/${matchingDir}`;
              console.log(`[Storage Detail] Dossier trouvé: ${appFolder}`);
              
              const { stdout } = await execPromise(`sudo du -sb ${appFolder} 2>/dev/null | cut -f1`, { timeout: 30000 });
              const folderSize = parseInt(stdout.trim()) || 0;
              const folderSizeGB = folderSize / 1e9;
              console.log(`[Storage Detail] Taille dossier ${appFolder}: ${folderSize} bytes (${folderSizeGB.toFixed(2)} GB)`);
              appSize += folderSizeGB;
            } else {
              console.log(`[Storage Detail] Aucun dossier trouvé pour ${app.id} dans ${APPS_DIR}`);
            }
          }
        } catch (error: any) {
          console.error(`[Storage Detail] Erreur recherche dossier ${app.id}:`, error.message);
        }

        // Taille des volumes Docker de l'app
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
            } catch (error: any) {
              console.error(`[Storage Detail] Erreur calcul volume ${volName}:`, error.message);
            }
          }
        } catch (error: any) {
          console.error(`[Storage Detail] Erreur récupération volumes ${app.id}:`, error.message);
        }

        // Note: On ne compte PAS les images Docker car elles ont des layers partagés
        // qui seraient comptés en double. Les images sont déjà incluses dans df /data
        
        // Récupérer l'icône depuis MANIFESTS_DIR/{appId}/
        let iconUrl = null;
        const manifestDir = `${MANIFESTS_DIR}/${app.id}`;
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
      } catch (error: any) {
        console.error(`[Storage Detail] Erreur calcul taille app ${app.id}:`, error);
      }
    }

    // 4. Calculer "Autres" (tous les dossiers dans /data SAUF apps et docker)
    const dataPartition = fsSizes.find(f => f.mount === '/data');
    let othersSize = 0;
    
    try {
      // Lister tous les dossiers dans /data
      const { stdout } = await execPromise('ls -1 /data', { timeout: 5000 });
      const dataDirs = stdout.trim().split('\n').filter(d => d && d !== 'apps' && d !== 'docker' && d !== 'snapshot');
      
      console.log(`[Storage Detail] Calcul "Autres" pour les dossiers:`, dataDirs);
      
      // Calculer la taille de chaque dossier (sauf apps et docker)
      for (const dir of dataDirs) {
        try {
          const { stdout: sizeOut } = await execPromise(`sudo du -sb /data/${dir} 2>/dev/null | cut -f1`, { timeout: 30000 });
          const dirSize = parseInt(sizeOut.trim()) / 1e9 || 0;
          console.log(`[Storage Detail] /data/${dir}: ${dirSize.toFixed(4)} GB`);
          othersSize += dirSize;
        } catch (error: any) {
          console.error(`[Storage Detail] Erreur calcul /data/${dir}:`, error.message);
        }
      }
      
      console.log(`[Storage Detail] Total "Autres": ${othersSize.toFixed(2)} GB`);
    } catch (error: any) {
      console.error(`[Storage Detail] Erreur calcul "Autres":`, error.message);
      othersSize = 0;
    }

    // 5. Répartir proportionnellement l'espace non identifié entre les apps
    const dataUsedReal = dataPartition ? dataPartition.used / 1e9 : (totalAppsSize + othersSize);
    
    // Espace non identifié = total /data utilisé - apps calculées - autres
    const unidentifiedSpace = Math.max(0, dataUsedReal - totalAppsSize - othersSize);
    
    console.log(`[Storage Detail] /data utilisé: ${dataUsedReal.toFixed(2)} GB, Apps calculées: ${totalAppsSize.toFixed(2)} GB, Autres: ${othersSize.toFixed(2)} GB, Non identifié: ${unidentifiedSpace.toFixed(2)} GB`);
    
    // Répartir l'espace non identifié proportionnellement entre les apps
    let totalAppsAdjusted = 0;
    for (const appDetail of appsDetails) {
      if (totalAppsSize > 0) {
        const proportion = appDetail.size / totalAppsSize;
        const additionalSpace = proportion * unidentifiedSpace;
        const adjustedSize = appDetail.size + additionalSpace;
        
        console.log(`[Storage Detail] ${appDetail.name}: ${appDetail.size.toFixed(2)} GB + ${additionalSpace.toFixed(2)} GB = ${adjustedSize.toFixed(2)} GB`);
        
        appDetail.size = adjustedSize;
        appDetail.sizeFormatted = `${adjustedSize.toFixed(2)} GB`;
        totalAppsAdjusted += adjustedSize;
      }
    }
    
    // Trier par taille décroissante après ajustement
    appsDetails.sort((a, b) => b.size - a.size);
    
    const totalUsed = systemSize + dataUsedReal;
    const totalSize = systemSize + (dataPartition ? dataPartition.size / 1e9 : 0);
    const dataAvailable = (dataPartition ? dataPartition.size / 1e9 : 0) - dataUsedReal;
    
    console.log(`[Storage Detail] Apps ajustées total: ${totalAppsAdjusted.toFixed(2)} GB, Système: ${systemSize.toFixed(1)} GB, Total utilisé: ${totalUsed.toFixed(1)} GB`);

    res.json({
      success: true,
      summary: {
        total: totalSize,
        used: totalUsed,
        available: dataAvailable,
        system: systemSize,
        apps: totalAppsAdjusted,
        others: othersSize,
        totalFormatted: `${totalSize.toFixed(1)} GB`,
        usedFormatted: `${totalUsed.toFixed(1)} GB`,
        availableFormatted: `${dataAvailable.toFixed(1)} GB`,
        systemFormatted: `${systemSize.toFixed(1)} GB`,
        appsFormatted: `${totalAppsAdjusted.toFixed(1)} GB`,
        othersFormatted: `${othersSize.toFixed(1)} GB`
      },
      apps: appsDetails
    });
  } catch (error: any) {
    console.error('Erreur récupération détail stockage:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la récupération du détail du stockage' });
  }
});

// GET /api/disks
router.get('/disks', async (req: any, res: any) => {
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
  } catch (err: any) {
    console.error('Erreur récupération info disques :', err);
    res.status(500).json({ error: 'Impossible de récupérer les informations de disques' });
  }
});

// POST /api/server-restart
router.post('/server-restart', verifyToken, async (req: any, res: any) => {
  try {
    // Vérifier que l'utilisateur est admin
    if (req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Accès refusé. Seuls les administrateurs peuvent redémarrer le serveur.' });
    }
    
    console.log(`[System] Redémarrage du serveur demandé par ${req.user.username}`);
    
    // Envoyer la réponse IMMÉDIATEMENT avant de démarrer le reboot
    res.json({ success: true, message: 'Le serveur va redémarrer dans quelques secondes...' });
    
    // Lancer le redémarrage APRÈS avoir envoyé la réponse
    // Utiliser setImmediate pour s'assurer que la réponse est bien envoyée
    setImmediate(async () => {
      try {
        await restartServer();
      } catch (error: any) {
        console.error('Erreur lors du redémarrage du serveur:', error);
      }
    });
  } catch (error: any) {
    console.error('Erreur lors du redémarrage du serveur:', error);
    res.status(500).json({ error: 'Erreur serveur lors du redémarrage' });
  }
});

export = router;
