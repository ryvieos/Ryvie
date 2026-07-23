# Stratégie de Migration Stockage — Ryvie

## Principe fondamental

**La migration de `/data` se fait À CHAUD avec `btrfs device add` + `btrfs device remove`.**

Zéro coupure, zéro rsync, zéro réinstallation d'apps : le filesystem reste monté,
Docker et toutes les apps continuent de tourner, et les subvolume IDs sont préservés
(c'est le même filesystem, rien n'est copié « par-dessus », les blocs sont déplacés
en interne par btrfs).

Validé sur RyvieOS : migration complète de `/data` (14 Go, 18 subvolumes, snapshots
inclus) pendant que 17 conteneurs tournaient — uptimes intacts, reboot vérifié.

## Comment ça marche

`/data` est TOUJOURS un filesystem btrfs dédié, quel que soit le support :

| Contexte | Support de /data |
|---|---|
| VPS / VM (mode `vps`) | image loopback `/data.img` (mkfs.btrfs -L DATA) |
| Machine physique (mode `appliance`) | partition nvme, puis `/dev/md0` (mdadm) après création du RAID |

btrfs étant multi-device nativement, on peut ajouter un nouveau support au pool
et drainer l'ancien, le tout en ligne :

```bash
# 1. Étendre le pool sur le nouveau support (instantané)
btrfs device add -f /dev/md0 /data

# 2. Drainer l'ancien support (les données migrent en arrière-plan)
btrfs device remove /dev/nvme0n1p4 /data   # ou /dev/loop0

# 3. Mettre à jour /etc/fstab (l'UUID du filesystem NE CHANGE PAS)
#    UUID=<fs-uuid> /data btrfs defaults,noatime,compress=zstd:3,nofail 0 0
```

Notes :
- `btrfs device remove` efface le superblock de l'ancien device en sortant — pas de
  signature fantôme.
- Si l'ancien support est une image loopback, supprimer le fichier `.img` après la
  migration pour récupérer l'espace sur le disque système.
- Ne PAS rebooter pendant la fenêtre de migration (fstab pointe encore sur l'ancien
  support tant que l'étape 3 n'est pas faite).
- Vérification de capacité obligatoire avant : le nouveau support doit contenir
  les données utilisées + marge métadonnées (5 % + 2 GiB dans le code).

## Implémentation

`POST /api/storage/mdraid-create` (routes/system/storage.ts) :
1. Prépare les disques + `mdadm --create` (l'array se construit, `/data` intact)
2. Attend la resync initiale (l'array est utilisable, aucune coupure)
3. Si `/data` est déjà en btrfs → **migration à chaud** (device add + remove + fstab)
4. Sinon (machine vierge) → mkfs.btrfs + mount + subvolumes docker/containerd

L'agrandissement d'un array existant (`mdraid-auto-migrate`, `mdraid-grow-size`,
`mdraid-reshape`) reste en mdadm pur : `--add`, `--grow`, reshape en ligne, puis
`btrfs filesystem resize max /data`. Là non plus, aucune coupure.

## À ne PAS faire (méthodes historiques, obsolètes)

- ❌ `rsync` de `/data` vers un nouveau filesystem + réinstallation des apps :
  coupure de service, fragile, inutile depuis la migration à chaud.
- ❌ `btrfs send/receive` pour déplacer `/data` : les subvolumes reçus obtiennent
  de NOUVEAUX IDs → si le driver de stockage Docker est `btrfs`, Docker perd ses
  layers. `device add/remove` n'a pas ce problème (IDs inchangés).
- ❌ RAID5/6 btrfs natif : write hole non résolu. La redondance reste sur mdadm ;
  btrfs reste en single-device au-dessus de md0.

## Endpoint de secours

`POST /api/storage/docker-reinstall-apps` réinstalle toutes les apps depuis
`/data/config/manifests/`. Ce n'est PLUS une étape de migration — c'est un outil
de réparation (corruption Docker, crash) découplé du stockage.

## Pourquoi Docker doit rester sur /data (et non sur /)

- `/` est trop petit pour Docker (images + layers = facilement 50 G+)
- `/` n'est ni en RAID ni en btrfs (pas de redondance, pas de snapshots)
- Les bind-mounts entre `/` et `/data` causent des problèmes de performance
