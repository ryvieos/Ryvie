const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SNAPSHOT_PENDING_FILE = '/tmp/ryvie-snapshot-pending.txt';

/**
 * Enregistre un snapshot en attente de vérification
 */
function registerPendingSnapshot(snapshotPath) {
  if (snapshotPath) {
    fs.writeFileSync(SNAPSHOT_PENDING_FILE, snapshotPath, 'utf8');
    console.log(`[SnapshotCleanup] Snapshot enregistré pour vérification: ${snapshotPath}`);
  }
}

/**
 * Nettoie tous les snapshots orphelins au démarrage
 */
function cleanAllSnapshots() {
  const SNAPSHOT_DIR = '/data/snapshot';
  
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      return;
    }
    
    const snapshots = fs.readdirSync(SNAPSHOT_DIR).filter(name => {
      const fullPath = path.join(SNAPSHOT_DIR, name);
      return fs.statSync(fullPath).isDirectory();
    });
    
    if (snapshots.length > 0) {
      console.log(`[SnapshotCleanup] 🧹 Nettoyage de ${snapshots.length} snapshot(s) orphelin(s)...`);
      
      for (const snapshot of snapshots) {
        const snapshotPath = path.join(SNAPSHOT_DIR, snapshot);
        try {
          execSync(`sudo btrfs subvolume delete "${snapshotPath}"/* 2>/dev/null || true`, { stdio: 'inherit' });
          execSync(`sudo rmdir "${snapshotPath}" 2>/dev/null || true`, { stdio: 'inherit' });
          console.log(`[SnapshotCleanup] ✅ Snapshot supprimé: ${snapshot}`);
        } catch (delError: any) {
          console.error(`[SnapshotCleanup] ❌ Erreur lors de la suppression de ${snapshot}:`, delError.message);
        }
      }
    }
  } catch (error: any) {
    console.error('[SnapshotCleanup] Erreur lors du nettoyage des snapshots:', error.message);
  }
}

/**
 * Vérifie et nettoie les snapshots en attente au démarrage
 */
function checkPendingSnapshots() {
  // D'abord, nettoyer tous les snapshots orphelins
  cleanAllSnapshots();
  
  if (!fs.existsSync(SNAPSHOT_PENDING_FILE)) {
    return;
  }

  try {
    const snapshotPath = fs.readFileSync(SNAPSHOT_PENDING_FILE, 'utf8').trim();
    console.log(`[SnapshotCleanup] Snapshot en attente trouvé: ${snapshotPath}`);

    // Attendre 5 secondes que les services démarrent
    setTimeout(() => {
      try {
        // Vérifier que PM2 fonctionne
        const pm2Output = execSync('/usr/local/bin/pm2 list', { encoding: 'utf8' });
        const hasOnlineProcesses = pm2Output.includes('online');

        if (hasOnlineProcesses) {
          console.log('[SnapshotCleanup] ✅ Services PM2 en ligne, suppression du snapshot...');
          
          // Supprimer le snapshot
          try {
            execSync(`sudo btrfs subvolume delete "${snapshotPath}"/* 2>/dev/null || true`, { stdio: 'inherit' });
            execSync(`sudo rmdir "${snapshotPath}" 2>/dev/null || true`, { stdio: 'inherit' });
            console.log('[SnapshotCleanup] ✅ Snapshot supprimé avec succès');
            
            // Supprimer le fichier de tracking
            fs.unlinkSync(SNAPSHOT_PENDING_FILE);
          } catch (delError: any) {
            console.error('[SnapshotCleanup] ❌ Erreur lors de la suppression du snapshot:', delError.message);
          }
        } else {
          console.error('[SnapshotCleanup] ❌ Services PM2 non disponibles, rollback...');
          
          // Rollback
          try {
            const rollbackOutput = execSync(`/opt/Ryvie/scripts/snapshots/rollback.sh --set "${snapshotPath}"`, { encoding: 'utf8' });
            console.log(rollbackOutput);
            console.log('[SnapshotCleanup] ✅ Rollback terminé');
            
            // Supprimer le fichier de tracking
            fs.unlinkSync(SNAPSHOT_PENDING_FILE);
          } catch (rollbackError: any) {
            console.error('[SnapshotCleanup] ❌ Erreur lors du rollback:', rollbackError.message);
          }
        }
      } catch (checkError: any) {
        console.error('[SnapshotCleanup] ❌ Erreur lors de la vérification:', checkError.message);
      }
    }, 5000);

  } catch (error: any) {
    console.error('[SnapshotCleanup] Erreur lors de la lecture du snapshot en attente:', error.message);
  }
}

export = {
  registerPendingSnapshot,
  checkPendingSnapshots
};
