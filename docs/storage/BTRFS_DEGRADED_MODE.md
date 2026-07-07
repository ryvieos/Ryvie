# Mode Dégradé Btrfs RAID

## Problème

Lorsqu'un disque d'un RAID Btrfs est retiré ou défaillant, systemd tente de monter `/data` par son UUID. Sans configuration appropriée, le système attend indéfiniment le périphérique manquant et peut entrer en **emergency mode** au démarrage.

## Solution : Option de montage `degraded`

L'option `degraded` permet à Btrfs de monter un RAID même si un ou plusieurs disques sont manquants. Cela garantit que le système peut démarrer normalement et continuer à fonctionner en mode dégradé.

### Exemple de configuration `/etc/fstab`

**Avant :**
```
UUID=xxxxx-xxxx  /data  btrfs  defaults  0  0
```

**Après :**
```
UUID=xxxxx-xxxx  /data  btrfs  defaults,degraded  0  0
```

## Implémentation Automatique

Le système Ryvie configure automatiquement cette option lors de la création du RAID :

### Lors de la création du RAID

L'endpoint `POST /api/storage/btrfs-raid-create` inclut maintenant une **Étape 5** qui :

1. Lit le fichier `/etc/fstab`
2. Trouve la ligne de montage pour `/data`
3. Ajoute l'option `degraded` aux options de montage
4. Sauvegarde le fichier modifié

### Activation manuelle

Si vous avez déjà un RAID configuré sans cette option, vous pouvez l'activer via :

**API :**
```bash
POST /api/storage/btrfs-enable-degraded
```

**Réponse :**
```json
{
  "success": true,
  "message": "Degraded mode enabled in /etc/fstab",
  "logs": [...]
}
```

## Comportement en Mode Dégradé

### Avec un disque manquant

- ✅ Le système démarre normalement
- ✅ `/data` est monté en mode dégradé
- ⚠️ Les données restent accessibles
- ⚠️ La redondance RAID1 est temporairement perdue
- ⚠️ Les performances peuvent être réduites

### Logs système

Vous verrez des messages dans les logs système :
```
BTRFS warning (device sda): devid X uuid Y is missing
BTRFS info (device sda): allowing degraded mounts
```

### Vérification de l'état

Pour vérifier l'état du RAID en mode dégradé :

```bash
# Afficher les devices du filesystem
sudo btrfs filesystem show /data

# Afficher l'utilisation détaillée
sudo btrfs device usage /data

# Vérifier l'état du RAID
sudo btrfs filesystem df /data
```

## Récupération après Remplacement du Disque

Une fois le disque remplacé, vous pouvez le rajouter au RAID :

```bash
# Scanner les nouveaux devices
sudo btrfs device scan

# Formater le nouveau disque
sudo mkfs.btrfs -L DATA2 /dev/sdX

# Ajouter au RAID
sudo btrfs device add /dev/sdX /data

# Supprimer l'ancien disque (si détectable)
sudo btrfs device remove missing /data

# Ou forcer la suppression
sudo btrfs device delete missing /data

# Rebalancer pour restaurer la redondance
sudo btrfs balance start -dconvert=raid1 -mconvert=raid1 /data
```

## Sécurité

### Permissions

La modification de `/etc/fstab` nécessite des privilèges root. Le système utilise :
- `sudo -n` pour exécuter les commandes avec élévation
- Un fichier temporaire (`/tmp/fstab.new`) pour la sécurité
- Validation des chemins de périphériques

### Validation

Le code valide :
- ✅ Que la ligne concerne bien `/data`
- ✅ Que le système de fichiers est `btrfs`
- ✅ Que l'option n'est pas déjà présente (évite les doublons)

## Logs de l'Opération

Exemple de logs lors de l'activation :

```
[INFO] Updating /etc/fstab to enable degraded mode for /data
[INFO] Adding degraded option to mount options
[SUCCESS] Successfully updated /etc/fstab with degraded option
[INFO] The system will now be able to boot even if one RAID disk is missing
```

## Références

- [Btrfs Wiki - Using Btrfs with Multiple Devices](https://btrfs.wiki.kernel.org/index.php/Using_Btrfs_with_Multiple_Devices)
- [Btrfs Documentation - Mount Options](https://btrfs.readthedocs.io/en/latest/Administration.html#mount-options)
- [systemd fstab documentation](https://www.freedesktop.org/software/systemd/man/systemd.mount.html)

## Notes Importantes

⚠️ **Le mode dégradé ne doit être qu'une solution temporaire**
- Remplacez le disque défaillant dès que possible
- En mode dégradé, vous n'avez plus de redondance
- Une défaillance d'un second disque entraînerait une perte de données

⚠️ **Surveillance recommandée**
- Configurez des alertes pour détecter les disques manquants
- Vérifiez régulièrement l'état du RAID avec `btrfs device stats`
- Utilisez `smartctl` pour surveiller la santé des disques
