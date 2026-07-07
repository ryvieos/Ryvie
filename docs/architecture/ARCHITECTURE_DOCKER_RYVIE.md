# Etat des lieux complet - Architecture Docker Ryvie

Ce document resume l'etat actuel de la machine et du depot pour preparer la migration de stockage/RAID sans casser l'installation.

## Etat actuel de la machine

- `/data` est monte sur `/dev/md0` en `btrfs`.
- `DockerRootDir` pointe sur `/data/docker`.
- Le driver Docker actif est `overlayfs`.
- `pm2` tourne en mode `dev` pour Ryvie au moment de l'inspection.
- Les services visibles dans Docker sont actuellement en ligne: `caddy`, `keycloak`, `keycloak-postgres`, `openldap`, `portainer`, `rdrive`, `rdrop`, `rpictures`, `rtransfer` et leurs sous-services.

Etat de conformité constate apres correction:

- Caddy et Keycloak utilisent deja des bind mounts persistants dans `/data/config`.
- Portainer utilise deja `/data/portainer` comme persistance.
- OpenLDAP a ete normalise pour utiliser `/data/config/ldap/data`.
- OpenLDAP doit rester connecte aux deux reseaux: `ldap_my_custom_network` pour compatibilite legacy et `ryvie-network` pour la pile Ryvie moderne.

### Moteur Docker

- Le moteur Docker tourne sur l'hote Linux, pas dans un conteneur.
- Il est lance par `systemd` via `docker.service` avec `dockerd -H fd:// --containerd=/run/containerd/containerd.sock`.
- `docker.socket` fournit le point d'entree `/var/run/docker.sock` pour les clients locaux.
- `containerd.service` est le runtime bas niveau utilise par Docker.
- `LiveRestoreEnabled=false`, donc une coupure du daemon Docker coupe aussi les conteneurs avant redemarrage.

## Ou tourne quoi

### Runtime applicatif Ryvie

- Le backend et le frontend Ryvie ne tournent pas dans Docker; ils tournent via PM2 sur l'hote.
- Le mode detecte actuellement est `dev`.
- Les scripts `dev.sh` et `prod.sh` synchronisent leurs configs depuis `/data/config/backend-view` et `/data/config/frontend-view`.
- `prod.sh` genere aussi les configs frontend, construit l'app, puis demarre PM2 en mode production.

### Architecture cible robuste

La version la plus solide est celle qui separe clairement:

- le moteur Docker sur l'hote,
- le plan de controle Ryvie dans `/opt/Ryvie`,
- les donnees metier dans `/data`,
- les secrets et configs persistantes dans `/data/config`,
- les apps composees dans `/data/apps`.

Objectif pratique:

- `/opt/Ryvie` pilote l'orchestration et l'interface d'administration,
- `/data` peut etre remplace ou remonte rapidement,
- les services reviennent par reconstruction des compose et non par copie du runtime Docker.

Si un stockage hors migration est disponible, le plus robuste est de garder le runtime Docker hors du volume migrable `/data`. Si ce n'est pas possible, `DockerRootDir` sur `/data/docker` reste acceptable mais doit etre traite comme un cache/repertoire regenerable, jamais comme une source de verite.

### Architecture cible ultra solide

Pour rendre l'installation la moins cassable possible, la cible ideale est:

- `/opt/Ryvie` contient uniquement le code de l'application de pilotage, les scripts, la doc et les build tools.
- `/data` contient uniquement les donnees persistantes, les configs, les manifests, les logs et les donnees d'apps.
- Docker Engine reste un service system de l'hote, independant du contenu de `/data`.
- Les compose des services critiques sont centralises et versionnes.
- Les volumes Docker nommes sont limites au minimum, et les bind mounts vers `/data` sont privilegies pour la persistance.

Objectif de conception:

1. Un changement de disque doit se limiter a remonter un nouveau `/data` et a relancer les services.
2. Une panne Docker ne doit pas effacer les donnees metier.
3. Une reprise doit fonctionner a partir des compose et des configs versionnees, pas a partir d'un runtime Docker recopie.
4. L'application Ryvie doit rester le point d'entree de controle unique pour voir l'etat, relancer les services et diagnostiquer les ecarts.

### Decoupage recommande

#### A garder dans `/opt/Ryvie`

- l'app de controle Ryvie
- les scripts `dev.sh`, `prod.sh`, `update-and-restart.sh`
- les composants backend/frontend
- la doc d'architecture et de reprise
- les fichiers de build et orchestration

#### A garder dans `/data`

- les compose et manifests de service
- les `.env` persistants
- les configs Caddy, Keycloak, LDAP et Netbird
- les donnees applicatives
- les logs
- les sauvegardes et snapshots utiles

#### A recreer automatiquement

- le runtime Docker sous `/data/docker`
- le runtime containerd sous `/data/containerd`
- les reseaux Docker externes si absents
- les conteneurs issus des compose

### Ordre de reprise systemique

1. Monter `/data`.
2. Verifier le montage et le type de FS.
3. Demarrer Docker Engine.
4. Recréer les reseaux externes attendus.
5. Demarrer LDAP.
6. Demarrer Keycloak et sa base.
7. Demarrer Caddy.
8. Demarrer PM2 pour l'application Ryvie.
9. Demarrer les stacks applicatives dans `/data/apps`.
10. Verifier l'etat depuis l'interface Ryvie.

### Principe de non-cassure

Une architecture est considerée solide si elle respecte ces regles:

- aucune donnee metier critique ne depend de `/data/docker`
- aucun service critique ne depend d'un chemin non documente
- aucun reseau Docker externe n'est implicite
- aucun compose critique n'est uniquement dans un dossier temporaire
- aucun demarrage n'est manuel sans script ou sans documentation de reprise

### Ce que l'app Ryvie doit piloter

L'interface de `/opt/Ryvie` doit permettre de:

- voir l'etat des services Docker et PM2
- detecter les reseaux manquants
- identifier les volumes et configs persistants
- lancer les compose dans le bon ordre
- signaler les ecarts entre l'etat attendu et l'etat reel
- relancer une reprise propre apres migration

### Point important pour la migration future

Si tu changes de `/data` rapidement, la meilleure strategie n'est pas de conserver un runtime Docker historique, mais de garantir que tout ce qui est critique est reconstructible depuis:

- `/opt/Ryvie`
- `/data/config`
- `/data/apps`
- `/data/config/manifests`
- les compose versionnes

Tout le reste doit etre considere comme temporaire ou regenerable.

### Reverse proxy

- Caddy est le reverse proxy principal.
- Son compose est dans `/data/config/reverse-proxy/docker-compose.yml`.
- Son fichier de config est `/data/config/reverse-proxy/Caddyfile`.
- En HTTP 80, Caddy proxifie vers le frontend sur `3000`, le backend sur `3002`, et redirige vers le monitor de mise a jour si le flag `/tmp/ryvie-updating` existe.
- En HTTP 3005, Caddy proxifie vers Keycloak sur `keycloak:8080`.

### Authentification

- Keycloak a son compose dedie dans `/opt/Ryvie/keycloak/docker-compose.yml`.
- Keycloak utilise un PostgreSQL dedie dans le meme compose.
- LDAP a son compose persistent dans `/data/config/ldap/docker-compose.yml`.
- LDAP stocke ses donnees persistantes dans `/data/config/ldap/data`.
- LDAP doit rester sur `ldap_my_custom_network` et `ryvie-network` pour ne pas casser les anciennes apps qui pointent encore vers le reseau legacy.
- Le backend Ryvie s'appuie sur Keycloak et LDAP pour le SSO.

### Applications Docker

- Les applications installees vivent sous `/data/apps`.
- Chaque app a en general un `docker-compose.yml` et un `ryvie-app.yml`.
- Les manifests d'installation vivent sous `/data/config/manifests/<app>/manifest.json`.

Applications trouvees:

- `/data/apps/rdrive/docker-compose.yml`
- `/data/apps/rdrop/docker-compose.yml`
- `/data/apps/rpictures/docker-compose.yml`
- `/data/apps/rtransfer/docker-compose.yml`

## Reseaux Docker importants

Reseaux presents sur la machine:

- `ryvie-network`
- `ldap_my_custom_network`
- `tdrive_default`
- `rdrive_tdrive_network`
- `rdrop_default`
- `rpictures_default`

Dependances observees au runtime:

- `caddy` est sur `ryvie-network`.
- `keycloak` et `keycloak-postgres` sont sur `ryvie-network`.
- `openldap` est sur `ldap_my_custom_network` et `ryvie-network`.
- `rdrive` utilise `tdrive_default`, `ldap_my_custom_network` et `ryvie-network`.
- `rdrop` utilise `rdrop_default`.
- `rpictures` utilise `rpictures_default`, `ldap_my_custom_network` et `ryvie-network`.
- `rtransfer` utilise `ldap_my_custom_network`.

Point d'attention: certaines anciennes installations peuvent encore avoir un compose LDAP legacy. Le backend Ryvie doit normaliser ce compose au demarrage et rattacher OpenLDAP aux deux reseaux requis si necessaire.

## Stockage persistant sous /data

### A migrer

- `/data/apps` - code et compose des apps
- `/data/config` - configs persistantes de Ryvie
- `/data/images` - images et fonds d'ecran
- `/data/logs` - historiques de logs
- `/data/netbird` - configuration Netbird
- `/data/portainer` - donnees Portainer
- `/data/config/ldap/data` - donnees OpenLDAP persistantes
- `/data/config/keycloak/postgres` - base PostgreSQL de Keycloak
- `/data/config/reverse-proxy/data` et `/data/config/reverse-proxy/config` - etat runtime persistant de Caddy

### A recreer, ne pas copier brutement

- `/data/docker` - runtime Docker, layers, metadata, volumes internes
- `/data/containerd` - runtime containerd
- `/data/snapshot` - snapshots BTRFS

Le point critique pour la migration est la difference entre donnees metier et runtime Docker. Les configs applicatives et les bind mounts doivent etre migres; le runtime Docker doit etre recree proprement.

## Ce qui controlle le demarrage

### Backend / Frontend

- `ecosystem.config.js` definit quatre processus PM2: backend dev/prod et frontend dev/prod.
- `dev.sh` demarre les versions dev.
- `prod.sh` demarre les versions production.
- Les logs PM2 vont dans `/data/logs`.

### Health / readiness

- `startupTracker.ts` suit l'initialisation des services internes.
- Les services suivis sont notamment `redis`, `network`, `caddy`, `keycloak`, `snapshots`, `realtime`, `manifests`, `appstore`, `backgrounds` et `netbird`.
- Le backend applique aussi des corrections d'architecture au demarrage: verification des dossiers persistants, creation des reseaux Docker critiques, normalisation du compose LDAP legacy et rattachement runtime d'OpenLDAP si besoin.
- `/api/health` renvoie juste que le serveur HTTP repond.
- `/api/health/ready` renvoie `503` tant que tous les services ne sont pas termines.

### Mise a jour

- Le script de mise a jour utilise un snapshot BTRFS de `/data`.
- Il attend ensuite un redemarrage complet du backend avant de valider l'upgrade.
- Le monitor temporaire tourne hors PM2 dans `/tmp/ryvie-update-monitor`.

## Flux de stockage / RAID

Le code de stockage est dans `Ryvie-Back/routes/storage.ts`.

Ce que fait cette partie:

- inventaire des disques et points de montage
- pre-checks avant ajout de disque RAID
- creation/ajout/retrait de disques mdadm
- suivi de resynchronisation
- creation de nouveaux arrays RAID

Regle centrale observee dans le code:

- `/data` doit etre monte en `btrfs` sur l'array attendu, sinon les operations RAID sont refusees.

Pour les scenarios de migration, le plan de pre-checks generique vise:

- `mdadm --create /dev/md0 ...`
- `mkfs.btrfs -f /dev/md0`
- montage temporaire sur `/mnt/new_raid`
- `rsync` de `/data/` en excluant `/docker/`, `/containerd/` et `/snapshot/`
- remontage final de `/data`
- reinstallation des apps depuis `/data/config/manifests/`

## Ce qui peut casser pendant la migration

1. `/data` ne remonte pas avec le bon UUID ou le bon device.
2. Les reseaux Docker externes ne sont pas recrees avant le redemarrage des compose.
3. Les volumes/app data sous `/data/apps` ou `/data/config` sont omis.
4. Le runtime Docker est copie brutement au lieu d'etre recree.
5. Les chemins `host-gateway` ou les aliases reseau manquent, ce qui casse Caddy, Keycloak ou les stacks apps.
6. Les fichiers `.env` persistant sous `/data/config/...` manquent ou ne correspondent plus.
7. Le mode PM2 est dev alors que la migration suppose prod, ou l'inverse.

## Inventaire a migrer ou recreer

### Compose Docker a conserver

- [Keycloak](../keycloak/docker-compose.yml) : compose present dans `/opt/Ryvie/keycloak/docker-compose.yml`
- [Caddy](../docs/ARCHITECTURE_DOCKER_RYVIE.md) : compose present dans `/data/config/reverse-proxy/docker-compose.yml`
- [LDAP](../docs/ARCHITECTURE_DOCKER_RYVIE.md) : compose present dans `/data/config/ldap/docker-compose.yml`
- [rDrive](../docs/ARCHITECTURE_DOCKER_RYVIE.md) : compose present dans `/data/apps/rdrive/docker-compose.yml`
- [rDrop](../docs/ARCHITECTURE_DOCKER_RYVIE.md) : compose present dans `/data/apps/rdrop/docker-compose.yml`
- [rPictures](../docs/ARCHITECTURE_DOCKER_RYVIE.md) : compose present dans `/data/apps/rpictures/docker-compose.yml`
- [rTransfer](../docs/ARCHITECTURE_DOCKER_RYVIE.md) : compose present dans `/data/apps/rtransfer/docker-compose.yml`

### Donnees a migrer absolument

- `/data/config/keycloak/import/ryvie-realm.json`
- `/data/config/keycloak/themes/`
- `/data/config/keycloak/.env`
- `/data/config/keycloak/apps-oauth.json`
- `/data/config/keycloak/postgres/`
- `/data/config/ldap/.env`
- `/data/config/reverse-proxy/Caddyfile`
- `/data/config/reverse-proxy/data/`
- `/data/config/reverse-proxy/config/`
- `/data/config/manifests/`
- `/data/config/appStore/`
- `/data/config/frontend-view/`
- `/data/config/backend-view/.env`
- `/data/config/netbird/`
- `/data/config/rdrive/`
- `/data/config/rdrop/`
- `/data/config/rtransfer/`
- `/data/images/`
- `/data/logs/`
- `/data/portainer/`

### Donnees a recreer proprement

- `/data/docker/`
- `/data/containerd/`
- `/data/snapshot/`

### Points a verifier avant reprise

1. Le compose LDAP est bien present, mais le nom du reseau runtime doit etre aligne avec celui attendu par les autres stacks.
2. Le compose Keycloak est independant du compose Caddy, donc il faut remettre le reseau externe commun avant de redemarrer.
3. Les stacks d'apps sous `/data/apps` doivent etre lances depuis leurs propres dossiers, pas depuis un autre emplacement.
4. Portainer ne semble pas avoir de compose dans le depot; si la stack a ete installee via Portainer, il faut exporter son compose ou la recreer avant migration.

### Conclusion pratique

Rien ne manque dans l'inventaire compose principal: Keycloak et LDAP existent deja. Le risque principal n'est pas l'absence d'un fichier compose, mais la perte des volumes, des reseaux Docker et des chemins persistants qui relient ces compose entre eux.

## Priorite pratique pour redemarrer vite apres migration

1. Remonter le nouveau RAID sur `/data`.
2. Verifier les entrees `fstab` et l'UUID du nouveau volume.
3. Restaurer `/data/apps`, `/data/config`, `/data/images`, `/data/logs`, `/data/netbird` et `/data/portainer`.
4. Recréer les reseaux Docker requis.
5. Redemarrer Docker, puis Caddy, Keycloak et LDAP.
6. Redemarrer PM2 en mode choisi.
7. Rejouer les compose des apps depuis `/data/apps`.

## Procedure recommandee de migration

### Avant de toucher aux disques

1. Verifier que `/data` est bien le point critique unique pour les donnees persistantes.
2. Sauvegarder au minimum `/data/apps`, `/data/config`, `/data/images`, `/data/logs`, `/data/netbird` et `/data/portainer`.
3. Noter l'etat runtime actuel: `pm2 list`, `docker ps`, `docker network ls`, `findmnt /data`, `lsblk -f`.
4. Verifier que les services externes existent deja ou seront recrees: `ryvie-network`, `ldap_my_custom_network`, `tdrive_default`, `rdrop_default`, `rpictures_default`.

### Pendant la migration stockage

1. Arreter proprement PM2 et Docker.
2. Monter le nouveau volume temporairement ailleurs, par exemple `/mnt/new_raid`.
3. Copier les donnees metier avec exclusion du runtime Docker:

```bash
rsync -aHAX --numeric-ids \
	--exclude='/docker/' \
	--exclude='/containerd/' \
	--exclude='/snapshot/' \
	/data/ /mnt/new_raid/
```

4. Rebasculer le point de montage vers `/data`.
5. Mettre a jour `fstab` et les references de montage si l'UUID a change.
6. Ne pas recopier `/data/docker` ni `/data/containerd`; laisser Docker recreer ces arborescences au prochain demarrage.

### Ordre de redemarrage apres migration

1. Monter `/data`.
2. Verifier `findmnt /data` et `docker info`.
3. Recréer les reseaux Docker manquants.
4. Demarrer le runtime Docker.
5. Demarrer Keycloak, LDAP, Caddy et Portainer.
6. Relancer PM2 via `dev.sh` ou `prod.sh` selon le mode voulu.
7. Relancer les apps Docker une par une depuis leurs dossiers sous `/data/apps`.

### Ordre de reprise des services

1. `openldap`
2. `keycloak-postgres`
3. `keycloak`
4. `caddy`
5. `portainer`
6. `rdrive`
7. `rpictures`
8. `rtransfer`
9. `rdrop`

L'ordre LDAP puis Keycloak est important parce que les flux SSO en dependent directement. Note: dans le code (`index.ts`), Caddy est demarre avant Keycloak car il peut temporairement retourner 502 en attendant que Keycloak soit pret. Les deux ordres fonctionnent; l'important est que LDAP soit disponible avant Keycloak.

## Matrice des stacks Docker

### Base commune

- `caddy` : reverse proxy global et redirection de mise a jour.
- `openldap` : annuaire LDAP.
- `keycloak` + `keycloak-postgres` : SSO.
- `portainer` : administration Docker.

### Apps

- `rdrive` : stack la plus complexe, avec Mongo, Node, Frontend et OnlyOffice.
- `rpictures` : serveur photo avec Redis, PostgreSQL et machine learning.
- `rtransfer` : partage de fichiers, plus simple, avec bind mounts locaux.
- `rdrop` : stack legere avec node et nginx.

## Points de vigilance specifiques

### Keycloak

- Le compose est dans `/opt/Ryvie/keycloak/docker-compose.yml`.
- Le stockage postgres est sur `/data/config/keycloak/postgres`.
- Les imports de realm sont dans `/data/config/keycloak/import`.
- Les themes sont dans `/data/config/keycloak/themes`.

### LDAP

- Le compose est dans `/data/config/ldap/docker-compose.yml`.
- Le volume nomme `openldap_data` doit etre conserve.
- Le reseau runtime vu sur la machine est `ldap_my_custom_network`, alors que le compose declare `my_custom_network`.

### Caddy

- Le compose et le Caddyfile sont dans `/data/config/reverse-proxy`.
- Le volume `/data/config/reverse-proxy/data` contient les donnees runtime de Caddy.
- Le volume `/data/config/reverse-proxy/config` contient la config runtime de Caddy.

### Apps

- Les manifests sous `/data/config/manifests` sont la source de verite pour la detection des apps installees.
- Les `.env` persistants sont sous `/data/config/<app>/`.
- Les apps peuvent avoir des bind mounts relatifs ou des chemins locaux a ne pas perdre pendant la migration.

## Ce que je recommande de faire ensuite

1. Faire un inventaire exact des volumes et des chemins persistants par app.
2. Valider le plan de copie avec un dry-run `rsync`.
3. Preparer un script de reprise qui relance les compose dans le bon ordre.
4. Tester le cas d'echec le plus probable: reseaux manquants ou `openldap` non joint.

## Fichiers de reference

- `Ryvie-Back/routes/storage.ts`
- `Ryvie-Back/routes/settings.ts`
- `Ryvie-Back/services/updateService.ts`
- `Ryvie-Back/services/startupTracker.ts`
- `Ryvie-Back/config/paths.ts`
- `ecosystem.config.js`
- `scripts/dev.sh`
- `scripts/prod.sh`
- `scripts/generate-frontend-config.sh`
- `/opt/Ryvie/keycloak/docker-compose.yml`
- `/data/config/reverse-proxy/docker-compose.yml`
- `/data/config/reverse-proxy/Caddyfile`
- `/data/config/ldap/docker-compose.yml`
- `/data/apps/rdrive/docker-compose.yml`
- `/data/apps/rdrop/docker-compose.yml`
- `/data/apps/rpictures/docker-compose.yml`
- `/data/apps/rtransfer/docker-compose.yml`