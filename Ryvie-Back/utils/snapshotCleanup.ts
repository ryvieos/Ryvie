const { execSync } = require('child_process');
const fs = require('fs');
const { RYVIE_DIR } = require('../config/paths');

const SNAPSHOT_PENDING_FILE = '/tmp/ryvie-snapshot-pending.txt';

// Scripts snapshots système (le backend n'appelle jamais `btrfs` directement)
const SNAPSHOT_SH = `${RYVIE_DIR}/scripts/snapshots/snapshot.sh`;
const ROLLBACK_SH = `${RYVIE_DIR}/scripts/snapshots/rollback.sh`;

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
 * Nettoie les sets de snapshots système orphelins au démarrage.
 * Délègue à snapshot.sh purge-orphans, qui PRÉSERVE /data/snapshot/apps
 * (snapshots per-app) et /data/snapshot/backups (sauvegardes ryvie-backup.sh).
 */
function cleanAllSnapshots() {
  try {
    console.log('[SnapshotCleanup] 🧹 Purge des sets de snapshots système orphelins...');
    execSync(`sudo ${SNAPSHOT_SH} purge-orphans`, { stdio: 'inherit' });
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
            execSync(`sudo ${SNAPSHOT_SH} delete-set "${snapshotPath}"`, { stdio: 'inherit' });
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
            const rollbackOutput = execSync(`sudo ${ROLLBACK_SH} --set "${snapshotPath}"`, { encoding: 'utf8' });
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
