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
        let folderSizeGB = 0;
        let volumesSizeGB = 0;
        console.log(`[Storage Detail] Calcul taille pour app: ${app.id} (${app.name})`);

        // 1. Taille du dossier de l'app dans APPS_DIR
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
              folderSizeGB = folderSize / 1e9;
              console.log(`[Storage Detail] Taille dossier ${appFolder}: ${folderSizeGB.toFixed(2)} GB`);
              appSize += folderSizeGB;
            } else {
              console.log(`[Storage Detail] Aucun dossier trouvé pour ${app.id} dans ${APPS_DIR}`);
            }
          }
        } catch (error: any) {
          console.error(`[Storage Detail] Erreur recherche dossier ${app.id}:`, error.message);
        }

        // 2. Taille des volumes Docker nommés de l'app
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
          
          console.log(`[Storage Detail] Volumes Docker trouvés pour ${app.id}:`, volumeNames.size);
          
          for (const volName of volumeNames) {
            try {
              const volInfo = await docker.getVolume(volName).inspect();
              const { stdout } = await execPromise(`sudo du -sb ${volInfo.Mountpoint} 2>/dev/null | cut -f1`, { timeout: 30000 });
              const volSize = parseInt(stdout.trim()) / 1e9 || 0;
              console.log(`[Storage Detail] Volume ${volName}: ${volSize.toFixed(4)} GB`);
              volumesSizeGB += volSize;
              appSize += volSize;
            } catch (error: any) {
              console.error(`[Storage Detail] Erreur calcul volume ${volName}:`, error.message);
            }
          }
        } catch (error: any) {
          console.error(`[Storage Detail] Erreur récupération volumes ${app.id}:`, error.message);
        }

        // 3. Taille des images Docker de l'app (uniquement les images "In Use")
        let imagesSizeGB = 0;
        try {
          // Récupérer tous les containers (running et stopped) pour savoir quelles images sont utilisées
          const allContainers = await docker.listContainers({ all: true });
          const usedImageIds = new Set(allContainers.map(c => c.ImageID));
          
          const images = await docker.listImages();
          const appImages = images.filter(img => {
            // Ne prendre que les images "In Use" (utilisées par au moins un container)
            if (!usedImageIds.has(img.Id)) {
              return false;
            }
            
            // Chercher les images qui correspondent à l'app
            if (img.RepoTags && img.RepoTags.length > 0) {
              return img.RepoTags.some(tag => {
                const tagLower = tag.toLowerCase();
                const appIdLower = app.id.toLowerCase();
                
                // Formats supportés:
                // 1. app-{appId}-{service} (ex: app-vaultwarden-server)
                // 2. {appId}/{anything} (ex: vaultwarden/server)
                // 3. {appId}:{tag} (ex: vaultwarden:latest)
                // 4. {registry}/{appId}:{tag} (ex: julescloud/rdrive-frontend:latest)
                // 5. ryvie-{appId}-{service} (ex: ryvie-rtransfer-pingvin-share)
                
                return tagLower.includes(`app-${appIdLower}`) || 
                       tagLower.startsWith(`${appIdLower}/`) ||
                       tagLower.startsWith(`${appIdLower}:`) ||
                       tagLower.includes(`/${appIdLower}-`) ||
                       tagLower.includes(`/${appIdLower}:`) ||
                       tagLower.includes(`ryvie-${appIdLower}`);
              });
            }
            return false;
          });
          
          console.log(`[Storage Detail] Images Docker "In Use" trouvées pour ${app.id}:`, appImages.length);
          
          for (const img of appImages) {
            const imgSize = img.Size / 1e9;
            console.log(`[Storage Detail] Image ${img.RepoTags?.[0] || img.Id}: ${imgSize.toFixed(4)} GB`);
            imagesSizeGB += imgSize;
            appSize += imgSize;
          }
        } catch (error: any) {
          console.error(`[Storage Detail] Erreur récupération images ${app.id}:`, error.message);
        }

        console.log(`[Storage Detail] ${app.id} - Dossier: ${folderSizeGB.toFixed(2)} GB, Volumes: ${volumesSizeGB.toFixed(2)} GB, Images: ${imagesSizeGB.toFixed(2)} GB, Total: ${appSize.toFixed(2)} GB`)
        
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

    // 5. Calculer l'espace réel et mettre ce qui n'est pas identifié dans "Autres"
    const dataUsedReal = dataPartition ? dataPartition.used / 1e9 : (totalAppsSize + othersSize);
    
    // Espace non identifié = total /data utilisé - apps calculées - autres calculés
    const unidentifiedSpace = Math.max(0, dataUsedReal - totalAppsSize - othersSize);
    
    console.log(`[Storage Detail] /data utilisé: ${dataUsedReal.toFixed(2)} GB, Apps: ${totalAppsSize.toFixed(2)} GB, Autres calculés: ${othersSize.toFixed(2)} GB, Non identifié: ${unidentifiedSpace.toFixed(2)} GB`);
    
    // Ajouter l'espace non identifié à "Autres" (images Docker, caches, etc.)
    const othersFinal = othersSize + unidentifiedSpace;
    
    console.log(`[Storage Detail] Autres final (avec non identifié): ${othersFinal.toFixed(2)} GB`);
    
    // Trier les apps par taille décroissante
    appsDetails.sort((a, b) => b.size - a.size);
    
    const totalUsed = systemSize + dataUsedReal;
    const totalSize = systemSize + (dataPartition ? dataPartition.size / 1e9 : 0);
    const dataAvailable = (dataPartition ? dataPartition.size / 1e9 : 0) - dataUsedReal;
    
    console.log(`[Storage Detail] Apps total: ${totalAppsSize.toFixed(2)} GB, Système: ${systemSize.toFixed(1)} GB, Autres: ${othersFinal.toFixed(1)} GB, Total utilisé: ${totalUsed.toFixed(1)} GB`);

    res.json({
      success: true,
      summary: {
        total: totalSize,
        used: totalUsed,
        available: dataAvailable,
        system: systemSize,
        apps: totalAppsSize,
        others: othersFinal,
        totalFormatted: `${totalSize.toFixed(1)} GB`,
        usedFormatted: `${totalUsed.toFixed(1)} GB`,
        availableFormatted: `${dataAvailable.toFixed(1)} GB`,
        systemFormatted: `${systemSize.toFixed(1)} GB`,
        appsFormatted: `${totalAppsSize.toFixed(1)} GB`,
        othersFormatted: `${othersFinal.toFixed(1)} GB`
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
