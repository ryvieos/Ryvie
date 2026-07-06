# Stratégie de sauvegarde & reprise après sinistre

> Objectif : une **méthode unique** de sauvegarde, valable sur machine physique
> RyvieOS **et** sur VM/VPS, avec sauvegarde **à chaud** (sans coupure des apps),
> vers un disque **hors site** (chez l'utilisateur, hors de la machine Ryvie),
> et une reprise complète possible si la machine Ryvie est détruite.
>
> Ce document est une **proposition de design**, pas encore implémentée. Voir aussi
> `RESILIENCE_REPRISE_DIAGNOSTIC.md` (audit de l'état actuel) et
> `ARCHITECTURE_DOCKER_RYVIE_CHANGES.md` (intentions de design générales).

---

## 1. Le problème de départ

Deux mécanismes de sauvegarde différents selon la cible (BTRFS natif sur
appliance physique, autre chose sur VM/VPS où `/data` n'est souvent pas du
BTRFS) seraient incohérents à maintenir et à documenter. Il faut **une seule
méthode**, qui marche pareil partout.

## 2. Rendre `/data` toujours BTRFS

- **Machine physique** : `/data` est déjà un volume BTRFS natif (RAID/BTRFS
  géré par `install.sh`).
- **VM/VPS** : `/data` est en général sur un disque `ext4` fourni par
  l'hébergeur. Solution : créer un **fichier loopback** formaté en BTRFS et
  monté sur `/data` :

  ```bash
  # exemple de principe (à intégrer dans install.sh)
  fallocate -l 200G /var/lib/ryvie-data.img
  mkfs.btrfs /var/lib/ryvie-data.img
  losetup /dev/loop0 /var/lib/ryvie-data.img
  mount /dev/loop0 /data
  ```

- Conséquence : `/data` est **toujours** BTRFS, que ce soit natif ou en
  loopback. `BTRFS_MODE` peut donc redevenir une constante (toujours 1) plutôt
  qu'une bifurcation de code dans `install.sh`.
- **Compromis accepté** : légère perte de perf sur VM/VPS (double couche COW :
  ext4 hôte + BTRFS dans le fichier loopback), et gestion de la taille du
  fichier image (l'agrandir si `/data` se remplit).

## 3. Où vivent Docker et containerd

Avec `/data` toujours BTRFS, **Docker et containerd restent sur `/data`**
(`/data/docker`, `/data/containerd`), en sous-volumes BTRFS — comme c'est déjà
le cas sur l'appliance physique aujourd'hui. Pas de branche spéciale VM/VPS à
maintenir.

**Pourquoi sur `/data` et pas `/var/lib` :** sur l'appliance, le disque OS est
petit, le disque `/data` est gros (RAID) — Docker (images, layers, souvent
volumineux) a besoin de cet espace. Même logique sur VPS avec le fichier
loopback.

**Point important à corriger en contrepartie** (déjà signalé dans
`ARCHITECTURE_DOCKER_RYVIE_CHANGES.md` et `RESILIENCE_REPRISE_DIAGNOSTIC.md`) :
Docker/containerd sont du **runtime régénérable**, jamais de la donnée à
restaurer. Le mécanisme de sauvegarde doit donc **exclure explicitement** les
sous-volumes `docker`, `containerd` et `snapshot` de ce qui est sauvegardé
(aujourd'hui `snapshot.sh` les inclut par erreur — à corriger).

## 4. Sauvegarde à chaud : snapshot BTRFS

Le snapshot BTRFS (`btrfs subvolume snapshot -r`) est atomique (quelques
millisecondes) : il capture un état cohérent de `/data` sans avoir besoin
d'arrêter les apps longtemps. C'est la **couche de cohérence** de la stratégie.

Le script existant `scripts/snapshot.sh` fait déjà l'essentiel :
1. `docker pause` de tous les conteneurs actifs (fige leur état le temps du
   snapshot, quelques secondes),
2. `sync`,
3. snapshot en lecture seule de chaque sous-volume de donnée sous
   `/data/snapshot/<timestamp>/`,
4. `docker unpause`.

À corriger : exclure `docker`, `containerd`, `snapshot` de la liste des
sous-volumes traités (voir section 3).

## 5. Sauvegarde hors site : `btrfs send` / `btrfs receive`

Une fois le snapshot local pris, il est envoyé **en flux** vers un disque dur
chez l'utilisateur (hors de la machine Ryvie), via SSH :

```bash
# premier envoi (complet)
sudo btrfs send /data/snapshot/<timestamp>/apps \
  | ssh utilisateur@maison "sudo btrfs receive /mnt/backup-ryvie/"

# envois suivants (incrémental, ne transfère que les changements)
sudo btrfs send -p /data/snapshot/<precedent>/apps /data/snapshot/<nouveau>/apps \
  | ssh utilisateur@maison "sudo btrfs receive /mnt/backup-ryvie/"
```

**Condition impérative :** le disque de destination chez l'utilisateur doit
lui aussi être formaté en **BTRFS** (`btrfs receive` ne fonctionne que vers un
volume BTRFS). Un disque externe en ext4/NTFS ne convient pas pour cette
méthode.

**Avantages :**
- Sauvegarde à chaud (pas d'arrêt prolongé des apps).
- Incrémental après le premier envoi (rapide, peu de bande passante).
- Une seule méthode, valable machine physique et VM/VPS.

**Alternative si le disque chez l'utilisateur n'est pas en BTRFS :** `rsync`
ou `restic` vers le snapshot monté en lecture seule — fonctionne sur
n'importe quel filesystem de destination, mais sans le vrai incrémental
atomique de `btrfs send` (restic fait néanmoins de la déduplication par bloc).

## 6. Reprise après sinistre (machine détruite)

Si la machine Ryvie est perdue (incendie, panne matérielle irréversible,
etc.), reconstruction sur une nouvelle machine :

1. **Nouvelle machine** : lancer `install.sh` (crée `/data` en BTRFS natif ou
   loopback selon le type de machine, crée un runtime Docker/containerd
   **neuf** — ne jamais restaurer `/data/docker`/`/data/containerd`).
2. **Restauration de la donnée**, en sens inverse depuis le disque chez
   l'utilisateur :
   ```bash
   ssh utilisateur@maison "sudo btrfs send /mnt/backup-ryvie/<dernier_snapshot>" \
     | sudo btrfs receive /data/
   ```
   Ceci remet `/data/apps`, `/data/config`, `/data/images`, `/data/logs`,
   `/data/netbird` dans l'état du dernier snapshot envoyé.
3. **Code Ryvie** : `git clone`/`pull` de `/opt/Ryvie` sur la version taggée
   correspondant aux schémas DB, puis `bash scripts/prod.sh` (reconstruit
   `node_modules`, build, `.env`, config frontend, PM2 — voir
   `RESILIENCE_REPRISE_DIAGNOSTIC.md` section 4).
4. **Réconciliation automatique** : le backend recrée les réseaux Docker
   manquants, relance LDAP, Keycloak, Caddy, IA, puis les apps SSO. Les apps
   non-SSO nécessitent aujourd'hui encore le réconciliateur "start ALL
   installed apps" décrit comme lacune dans `RESILIENCE_REPRISE_DIAGNOSTIC.md`
   (section 5) — tant qu'il n'existe pas, un `docker compose up -d` manuel par
   app sous `/data/apps/*` peut être nécessaire après une restauration à
   froid.
5. **Vérification** : `pm2 status`, état des conteneurs, accès SSO.

## 7. Ce qu'il reste à implémenter (résumé des travaux)

| Tâche | Fichier concerné |
|---|---|
| Loopback BTRFS pour `/data` sur VM/VPS | `install.sh` |
| Simplifier `BTRFS_MODE` (constante, plus de bifurcation Docker/containerd) | `install.sh` |
| Exclure `docker`, `containerd`, `snapshot` des sous-volumes sauvegardés | `scripts/snapshot.sh` |
| Script d'envoi hors site incrémental (`btrfs send \| ssh receive`) | nouveau `scripts/backup-offsite.sh` |
| Script de restauration hors site (sens inverse) | nouveau `scripts/restore-offsite.sh` |
| Réconciliateur boot "start ALL installed apps" (déjà identifié) | `Ryvie-Back/index.ts` / `services/` |

---

*Document de design établi le 2026-07-03, en complément de
`RESILIENCE_REPRISE_DIAGNOSTIC.md`. Rien de ce document n'est encore
implémenté dans le code.*
