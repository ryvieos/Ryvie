# Stratégie de Migration Stockage — Ryvie

## Principe fondamental

**Ne jamais copier `/data/docker` ni `/data/containerd` lors d'une migration RAID.**

Ces répertoires contiennent des sous-volumes BTRFS avec des IDs internes que Docker/containerd utilisent pour gérer les layers d'images, les conteneurs et les snapshots. Copier ces données (même via `btrfs send/receive`) casse la correspondance entre les IDs BTRFS et la base interne de Docker.

## Comment Synology gère ça

Synology utilise la même stratégie : lors d'une migration vers un nouveau pool de stockage, les paquets Docker sont **réinstallés**, pas copiés. Les données utilisateur (configs, volumes bind-mount) sont migrées, mais le runtime Docker est recréé proprement.

## Architecture de `/data`

```
/data/
├── apps/          ✅ COPIER — Code source, docker-compose.yml, configs des apps
├── config/        ✅ COPIER — Configs backend, frontend, manifests, reverse-proxy, Keycloak
├── images/        ✅ COPIER — Backgrounds, uploads utilisateurs
├── logs/          ✅ COPIER — Historique des logs
├── netbird/       ✅ COPIER — Configuration réseau VPN
├── portainer/     ✅ COPIER — Configuration Portainer
├── docker/        ❌ EXCLURE — Runtime Docker (images, layers, conteneurs)
├── containerd/    ❌ EXCLURE — Runtime containerd (snapshots, metadata)
└── snapshot/      ❌ EXCLURE — Snapshots BTRFS (sous-volumes read-only)
```

## Flux de migration RAID

1. Créer le nouveau RAID (mdadm --create)
2. Formater en BTRFS (mkfs.btrfs)
3. Monter temporairement sur `/mnt/new_raid`
4. **Stopper Docker et containerd**
5. **rsync** de `/data/` vers `/mnt/new_raid/` en excluant `docker/`, `containerd/`, `snapshot/`
6. Vérifier que les dossiers critiques (`config/`, `apps/`) sont bien copiés
7. Démonter l'ancien `/data`, monter le nouveau RAID sur `/data`
8. Mettre à jour `/etc/fstab` et `/etc/mdadm/mdadm.conf`
9. **Redémarrer Docker** (il recrée `/data/docker` et `/data/containerd` vides)
10. **Réinstaller toutes les apps** depuis `/data/config/manifests/` via `docker compose up -d`
11. Vérifier l'état final

## Pourquoi Docker casse avec btrfs send/receive

Docker avec le driver de stockage BTRFS crée des sous-volumes imbriqués :
```
/data/docker/btrfs/subvolumes/<layer-id>/   — un sous-volume par layer
```

Chaque sous-volume a un **subvolume ID** unique attribué par BTRFS. Docker stocke ces IDs dans sa base (`/data/docker/image/btrfs/`). Quand on fait `btrfs send | btrfs receive`, les sous-volumes reçus obtiennent de **nouveaux IDs**. Docker ne retrouve plus ses layers → erreur au démarrage.

## Endpoint de secours

`POST /api/storage/docker-reinstall-apps` permet de réinstaller toutes les apps Docker depuis leurs manifests à tout moment, sans migration RAID. Utile :
- Après une corruption Docker
- Après un crash système
- Comme bouton de secours dans l'interface

## Pourquoi Docker doit rester sur /data (et non sur /)

- `/` fait ~18G — trop petit pour Docker (images + layers = facilement 50G+)
- `/` n'est pas en RAID — pas de redondance
- `/` n'est pas en BTRFS — pas de snapshots
- Les bind-mounts entre `/` et `/data` causent des problèmes de performance
- La stratégie "ne jamais copier Docker" élimine 100% des bugs de migration
