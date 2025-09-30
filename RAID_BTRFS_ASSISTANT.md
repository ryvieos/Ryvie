# Assistant RAID Btrfs - Documentation

## Vue d'ensemble

L'assistant RAID Btrfs permet de configurer facilement un RAID1 Btrfs sur votre serveur Ryvie en quelques clics. Il gère automatiquement la détection des disques, les validations de sécurité, et l'exécution des commandes Btrfs.

## Accès

1. Connectez-vous à Ryvie
2. Allez dans **Settings** (Paramètres)
3. Dans la section **Configuration du Stockage**, cliquez sur **"Ouvrir l'assistant Stockage (RAID + Btrfs)"**

Ou accédez directement à : `#/settings/storage`

## Fonctionnalités

### 📊 Inventaire des devices
- Affichage complet de tous les disques et partitions
- Colonnes : NAME, TYPE, SIZE, FSTYPE, MOUNTPOINTS, LABEL, UUID
- Détection automatique des devices système (grisés et non sélectionnables)

### 🔒 Règles de sélection automatiques
**Non sélectionnables (grisés avec tooltip)** :
- Partitions montées sur `/`, `/boot`, `/boot/efi`
- Partitions SWAP
- Lecteurs CD/DVD (sr0)
- Devices loop
- Tout device monté ailleurs que `/data`

**Source (radio, 1 seul)** :
- Doit être une partition Btrfs
- Doit être montée sur `/data`
- Pré-sélection automatique de `/dev/sda6` si disponible

**Cibles (multi-sélection)** :
- Doivent être des disques entiers (type `disk`)
- Ne doivent pas être montés
- Pré-sélection automatique de `/dev/sdb` si disponible

### ⚙️ Configuration

**Labels personnalisables** :
- Chaque disque cible peut avoir un label unique
- Valeurs par défaut : DATA2, DATA3, DATA4, etc.
- Format accepté : lettres, chiffres, tirets et underscores

**Niveaux RAID supportés** :
- **RAID1** (2 copies) - Recommandé pour 2 disques
- **RAID1C3** (3 copies) - Recommandé pour 3+ disques
- **RAID10** - Pour configurations avancées

**Mode Dry-run** :
- Prévisualise toutes les commandes sans les exécuter
- Permet de vérifier la configuration avant application

### ✅ Validations automatiques

L'assistant effectue des pré-checks avant d'activer le bouton "Create RAID" :

**Vérifications sur la source** :
- `/data` est bien monté
- Le filesystem est bien Btrfs
- Le device source correspond au montage

**Vérifications sur les cibles** :
- Les disques ne sont pas montés
- Taille suffisante pour les données actuelles de `/data`
- Pas de conflit avec le device racine

**Messages d'erreur** :
- Bloquent l'exécution si critique
- Affichés en rouge avec détails

**Messages d'avertissement** :
- N'empêchent pas l'exécution
- Affichés en orange pour information

### 📝 Logs en temps réel

**Fenêtre de logs** :
- Auto-scroll vers le bas
- Coloration par type : info (bleu), success (vert), warning (orange), error (rouge), step (violet)
- Timestamps pour chaque entrée
- Bouton "Copy" pour copier tous les logs

**Badges d'état** :
- **Idle** (gris) : En attente
- **Running** (bleu) : Exécution en cours
- **Success** (vert) : Terminé avec succès
- **Error** (rouge) : Erreur rencontrée

### 🔐 Modale de confirmation

Avant l'exécution, une modale affiche :

**Récapitulatif de configuration** :
- Source sélectionnée
- Cibles avec leurs labels
- Niveau RAID choisi
- Mode (Dry Run ou Live Execution)

**Liste des commandes** :
- Toutes les commandes qui seront exécutées
- Description de chaque étape
- Code exact des commandes

**Avertissement de sécurité** :
- Rappel que l'opération est destructive pour les cibles
- Recommandation de faire des backups

## Séquence d'exécution

### Étape 1 : Préparation des cibles
Pour chaque disque cible :
```bash
sudo wipefs -a /dev/sdX
sudo mkfs.btrfs -L DATA2 /dev/sdX
```

### Étape 2 : Scan des devices
```bash
sudo btrfs device scan
```

### Étape 3 : Ajout au filesystem
Pour chaque disque cible :
```bash
sudo btrfs device add -f /dev/sdX /data
```

Vérification :
```bash
sudo btrfs filesystem show /data
```

### Étape 4 : Conversion en RAID
```bash
sudo btrfs balance start -dconvert=raid1 -mconvert=raid1 /data
```

Suivi :
```bash
sudo btrfs balance status /data
```

### Étape 5 : Contrôles finaux
```bash
sudo btrfs filesystem df /data
sudo btrfs filesystem show /data
sudo btrfs device usage /data
```

## Exemple : Configuration 3 disques

**Configuration** :
- Source : `/dev/sda6` (monté sur `/data`)
- Cibles : `/dev/sdb`, `/dev/sdc`
- Labels : DATA2, DATA3
- RAID Level : RAID1

**Commandes exécutées** :
```bash
# Formatage
sudo wipefs -a /dev/sdb
sudo wipefs -a /dev/sdc
sudo mkfs.btrfs -L DATA2 /dev/sdb
sudo mkfs.btrfs -L DATA3 /dev/sdc

# Ajout au FS
sudo btrfs device scan
sudo btrfs device add -f /dev/sdb /data
sudo btrfs device add -f /dev/sdc /data
sudo btrfs filesystem show /data

# Conversion
sudo btrfs balance start -dconvert=raid1 -mconvert=raid1 /data
sudo btrfs balance status /data

# Vérifications
sudo btrfs filesystem df /data
sudo btrfs filesystem show /data
sudo btrfs device usage /data
```

## Gestion d'erreurs

### "appears to contain an existing filesystem"
**Cause** : La cible contient déjà un filesystem  
**Solution** : Automatiquement géré par `wipefs -a` avant formatage

### "Device is mounted"
**Cause** : Un disque cible est monté  
**Solution** : Démontez le disque avant de continuer  
**Commande** : `sudo umount /dev/sdX`

### "Sudo demande un mot de passe"
**Cause** : Configuration sudoers incorrecte  
**Solution** : L'utilisateur `ryvie` doit avoir sudo sans mot de passe  
**Vérification** : `sudo -n whoami` doit fonctionner sans prompt

### "Device too small"
**Cause** : Le disque cible est plus petit que l'espace utilisé sur `/data`  
**Solution** : Utilisez un disque plus grand ou libérez de l'espace sur `/data`

## Sécurité

### Validation des entrées
- Seuls les chemins devices valides sont acceptés : `/dev/sdX`, `/dev/nvmeXnY`, `/dev/vdX`
- Protection contre l'injection de commandes
- Validation des labels (alphanumériques + tirets/underscores uniquement)

### Authentification
- Toutes les routes API nécessitent un token JWT valide
- Middleware `authenticateToken` sur toutes les endpoints

### Exécution sécurisée
- Commandes exécutées via `sudo -n` (non-interactif)
- Pas de shell intermédiaire (utilisation de `spawn` avec arguments séparés)
- Logging complet de toutes les opérations

## API Backend

### GET `/api/storage/inventory`
Récupère l'inventaire complet des devices

**Réponse** :
```json
{
  "success": true,
  "data": {
    "devices": { /* lsblk -J -O */ },
    "mountpoints": { /* findmnt -J */ },
    "blkid": "...",
    "timestamp": "2025-09-30T11:42:34.000Z"
  }
}
```

### POST `/api/storage/btrfs-prechecks`
Effectue les pré-vérifications

**Body** :
```json
{
  "source": "/dev/sda6",
  "targets": ["/dev/sdb", "/dev/sdc"]
}
```

**Réponse** :
```json
{
  "success": true,
  "checks": {
    "source": { /* infos source */ },
    "targets": [ /* infos cibles */ ],
    "warnings": [],
    "errors": []
  },
  "canProceed": true
}
```

### POST `/api/storage/btrfs-raid-create`
Crée le RAID Btrfs

**Body** :
```json
{
  "source": "/dev/sda6",
  "targets": [
    { "device": "/dev/sdb", "label": "DATA2" },
    { "device": "/dev/sdc", "label": "DATA3" }
  ],
  "dryRun": false,
  "raidLevel": "raid1"
}
```

**Réponse** :
```json
{
  "success": true,
  "dryRun": false,
  "commands": [ /* liste des commandes */ ],
  "logs": [ /* logs d'exécution */ ],
  "message": "RAID creation completed successfully"
}
```

### GET `/api/storage/btrfs-status`
Récupère l'état actuel du RAID Btrfs

**Réponse** :
```json
{
  "success": true,
  "status": {
    "mounted": true,
    "fstype": "btrfs",
    "source": "/dev/sda6",
    "raidLevel": "raid1",
    "filesystemShow": "...",
    "filesystemDf": "...",
    "deviceUsage": "..."
  }
}
```

## Dépannage

### Le bouton "Create RAID" est désactivé
- Vérifiez que vous avez sélectionné une source ET au moins une cible
- Consultez les messages d'erreur affichés sous la configuration
- Assurez-vous que les pré-checks sont passés (badge vert)

### Les logs ne s'affichent pas
- Vérifiez la connexion au backend
- Consultez la console du navigateur (F12)
- Vérifiez les logs du backend : `journalctl -u ryvie-backend -f`

### L'opération échoue en cours d'exécution
- Consultez les logs détaillés dans la fenêtre de logs
- Copiez les logs avec le bouton "Copy" pour analyse
- Vérifiez les permissions sudo : `sudo -n btrfs --version`

### Les disques ne s'affichent pas
- Vérifiez que `lsblk` fonctionne : `lsblk -J -O`
- Assurez-vous que les disques sont bien connectés
- Rechargez la page pour rafraîchir l'inventaire

## Recommandations

### Avant de commencer
1. ✅ Faites un backup complet de vos données
2. ✅ Vérifiez que `/data` est bien sur Btrfs : `findmnt -no FSTYPE /data`
3. ✅ Assurez-vous que les disques cibles sont vides ou que vous acceptez de les formater
4. ✅ Testez d'abord en mode Dry-run

### Pendant l'opération
1. ⏳ Ne fermez pas la fenêtre pendant l'exécution
2. ⏳ L'opération de balance peut prendre du temps (plusieurs heures pour de gros volumes)
3. ⏳ Surveillez les logs pour détecter d'éventuelles erreurs

### Après l'opération
1. ✅ Vérifiez l'état du RAID : `sudo btrfs filesystem df /data`
2. ✅ Consultez l'utilisation des devices : `sudo btrfs device usage /data`
3. ✅ Optionnel : Lancez un scrub pour vérifier l'intégrité : `sudo btrfs scrub start -Bd /data`

## Support

Pour toute question ou problème :
1. Consultez les logs de l'assistant (bouton Copy)
2. Vérifiez les logs du backend : `journalctl -u ryvie-backend -f`
3. Testez les commandes manuellement pour identifier le problème
4. Contactez le support Ryvie avec les logs complets

---

**Version** : 1.0  
**Date** : 2025-09-30  
**Auteur** : Ryvie Team
