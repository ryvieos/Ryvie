# Implémentation mdadm RAID1 pour Ryvie

## 🎯 Objectif
Remplacer le système Btrfs multi-device par un RAID1 mdadm avec Btrfs single au-dessus.

## 📋 Architecture

### Ancien système (supprimé)
- Btrfs multi-device avec `btrfs device add` + `btrfs balance`
- Redondance gérée par Btrfs directement

### Nouveau système (implémenté)
- **RAID mdadm** : `/dev/md0` (RAID1) pour la redondance matérielle
- **Btrfs single** : Monté sur `/dev/md0` pour le système de fichiers
- Séparation des responsabilités : mdadm = redondance, Btrfs = filesystem

## 🔧 Backend - Nouvelles routes

### 1. `POST /api/storage/mdraid-prechecks`
**Body:** `{ array: "/dev/md0", disk: "/dev/sdb" }`

**Fonctionnalités:**
- ✅ Vérifie que `/data` est monté sur `/dev/md0` (btrfs)
- ✅ Calcule la taille requise par membre (via `mdadm --detail`)
- ✅ Vérifie que le disque cible n'est pas monté
- ✅ Vérifie la taille du disque (doit être ≥ taille requise + 4 MiB)
- ✅ Détecte les superblocs mdadm existants
- ✅ Détermine le prochain PARTLABEL (md0_b, md0_c, etc.)
- ✅ Génère le plan de commandes

**Réponse:**
```json
{
  "success": true,
  "canProceed": true,
  "reasons": ["✓ /data is mounted on /dev/md0 (btrfs)", ...],
  "plan": ["wipefs -a /dev/sdb", "parted -s /dev/sdb mklabel gpt", ...],
  "requiredSizeBytes": 107374182400,
  "deviceSizeBytes": 120034123776,
  "nextPartLabel": "md0_b",
  "newPartitionPath": "/dev/sdb1"
}
```

### 2. `POST /api/storage/mdraid-add-disk`
**Body:** `{ array: "/dev/md0", disk: "/dev/sdb", dryRun: false }`

**Étapes exécutées:**
1. **Sanity checks** : Répète les vérifications critiques
2. **Wipe & GPT** : `wipefs -a` + `parted mklabel gpt`
3. **Partition RAID** :
   - `parted mkpart primary 1MiB <END_MIB>MiB`
   - `parted name 1 md0_b` (PARTLABEL)
   - `parted set 1 raid on`
4. **Ajout au RAID** :
   - `mdadm --zero-superblock /dev/sdb1`
   - `mdadm --add /dev/md0 /dev/sdb1`
5. **Persistance** :
   - `mdadm --detail --scan > /etc/mdadm/mdadm.conf`
   - `update-initramfs -u`
6. **Status final** : Affiche `/proc/mdstat`, `mdadm --detail`, `lsblk`

**Gestion NVMe:**
- Détection automatique : `/dev/nvme0n1` → partition `/dev/nvme0n1p1`

### 3. `GET /api/storage/mdraid-status`
**Réponse:**
```json
{
  "success": true,
  "status": {
    "array": "/dev/md0",
    "exists": true,
    "mounted": true,
    "fstype": "btrfs",
    "source": "/dev/md0",
    "activeDevices": 2,
    "totalDevices": 2,
    "state": "clean",
    "syncProgress": 45.2,
    "members": [
      {"device": "/dev/sda1", "state": "active sync"},
      {"device": "/dev/sdb1", "state": "active sync"}
    ],
    "mdstat": "...",
    "detail": "..."
  }
}
```

## 🎨 Frontend - Modifications

### Changements principaux
1. **Sélection unique** : Un seul disque à la fois (au lieu de multi-sélection)
2. **Détection automatique** : Appelle `/api/storage/mdraid-status` au chargement
3. **Affichage de l'état** :
   - État du RAID (clean, degraded, resyncing)
   - Progression de resynchronisation (%)
   - Membres actifs vs total
4. **Workflow simplifié** :
   - Sélectionner un disque → Prechecks automatiques → Confirmation → Exécution

### UI mise à jour
- Titre : "Assistant RAID mdadm"
- Badge d'état : Affiche l'état du RAID en temps réel
- Progression : Barre de progression si resync en cours
- Avertissement destructif : Message clair sur l'effacement du disque

## 🔐 Sécurité & Validations

### Validations strictes
- ✅ Devices autorisés : `/dev/sd[a-z]+`, `/dev/vd[a-z]+`, `/dev/nvme\d+n\d+`
- ✅ Refus des disques montés
- ✅ Refus des disques système (/, /boot, /boot/efi)
- ✅ Vérification de la taille minimale
- ✅ Warning si superbloc mdadm existant

### Règle de nommage GPT (PARTLABEL)
- Premier membre : `md0_a` (conventionnel, peut ne pas avoir de label)
- Deuxième membre : `md0_b`
- Troisième membre : `md0_c`
- Etc.

Calcul : `chr(97 + activeDevices)` où activeDevices vient de `mdadm --detail`

## 📊 Fonctions utilitaires ajoutées

### Backend (`storage.js`)
```javascript
// Vérifie si un device est monté
async function isDeviceMounted(devicePath)

// Détermine la prochaine lettre pour PARTLABEL
async function getNextPartLabel(arrayDevice)

// Obtient la taille requise par membre
async function getUsedDevSize(arrayDevice)

// Gère les chemins de partition (NVMe vs SATA)
function getPartitionPath(diskPath, partNum)
```

## 🗑️ Routes supprimées

Les anciennes routes Btrfs ont été supprimées :
- ❌ `POST /api/storage/btrfs-prechecks`
- ❌ `POST /api/storage/btrfs-raid-create`
- ❌ `POST /api/storage/btrfs-fix-raid-profiles`
- ❌ `POST /api/storage/btrfs-enable-degraded`
- ❌ `GET /api/storage/btrfs-status`

## 🚀 Workflow utilisateur

1. **Accès à l'interface** : L'utilisateur ouvre la page Storage Settings
2. **Détection automatique** : Le système détecte `/dev/md0` et affiche son état
3. **Sélection** : L'utilisateur clique sur un disque disponible
4. **Prechecks** : Vérifications automatiques + affichage du plan
5. **Confirmation** : Modal avec liste des commandes et warning destructif
6. **Exécution** : Logs en temps réel de chaque étape
7. **Résultat** : Affichage de `/proc/mdstat` et `mdadm --detail`
8. **Monitoring** : L'utilisateur peut suivre la progression du resync

## 📝 Exemple de logs

```
🚀 Starting mdadm RAID disk addition process
Array: /dev/md0
Disk: /dev/sdb
Dry Run: false

=== Step 1: Sanity checks ===
✓ /data is mounted on /dev/md0 (btrfs)
✓ Disk /dev/sdb is not mounted
Required size: 102400 MiB
Device size: 114473 MiB
Partition will be: /dev/sdb1 (md0_b)

=== Step 2: Wiping disk and creating GPT table ===
Wiping signatures on /dev/sdb...
✓ Wiped /dev/sdb
Creating GPT partition table on /dev/sdb...
✓ Created GPT table on /dev/sdb

=== Step 3: Creating RAID partition ===
Creating partition from 1MiB to 102400MiB...
✓ Created partition
Setting partition label to md0_b...
✓ Set partition label
Setting RAID flag on partition...
✓ Set RAID flag

=== Step 4: Adding partition to RAID array ===
Zeroing superblock on /dev/sdb1...
✓ Zeroed superblock
Adding /dev/sdb1 to /dev/md0...
✓ Added /dev/sdb1 to /dev/md0

=== Step 5: Persisting mdadm configuration ===
Updating /etc/mdadm/mdadm.conf...
✓ Updated /etc/mdadm/mdadm.conf
Updating initramfs...
✓ Updated initramfs

=== Step 6: Final status ===
📊 /proc/mdstat:
md0 : active raid1 sdb1[2] sda1[0]
      104857600 blocks super 1.2 [2/2] [UU]
      [>....................]  resync =  0.5% (524288/104857600)

✅ RAID disk addition completed successfully!
🔄 The array is now resyncing. Monitor progress with: cat /proc/mdstat
```

## ✅ Tests recommandés

1. **Test avec disque SATA** : `/dev/sdb` → `/dev/sdb1`
2. **Test avec disque NVMe** : `/dev/nvme0n1` → `/dev/nvme0n1p1`
3. **Test dry-run** : Vérifier que rien n'est modifié
4. **Test avec disque monté** : Doit être refusé
5. **Test avec disque trop petit** : Doit être refusé
6. **Test de progression** : Vérifier l'affichage du resync
7. **Test de persistance** : Redémarrer et vérifier que le RAID démarre

## 🔄 Migration depuis ancien système

Si un système utilise encore l'ancien Btrfs multi-device :
1. Le frontend détectera que `/data` n'est pas sur `/dev/md0`
2. `raidType` restera `null`
3. L'interface affichera une erreur ou un message approprié
4. L'administrateur devra migrer manuellement vers mdadm

## 📚 Documentation technique

### Commandes mdadm utiles
```bash
# Voir l'état du RAID
cat /proc/mdstat
mdadm --detail /dev/md0

# Ajouter un disque
mdadm --add /dev/md0 /dev/sdb1

# Retirer un disque
mdadm --fail /dev/md0 /dev/sdb1
mdadm --remove /dev/md0 /dev/sdb1

# Sauvegarder la config
mdadm --detail --scan > /etc/mdadm/mdadm.conf
update-initramfs -u
```

### Structure de partition GPT
```
/dev/sdb
├── GPT Header (1 MiB)
└── /dev/sdb1 (md0_b)
    ├── Type: Linux RAID
    ├── PARTLABEL: md0_b
    └── Flag: raid
```

## 🎉 Conclusion

L'implémentation est complète et fonctionnelle. Le système utilise maintenant mdadm pour la redondance RAID1, avec Btrfs en single au-dessus pour bénéficier des fonctionnalités du filesystem (snapshots, compression, etc.) sans la complexité du RAID Btrfs multi-device.
