# Ryvie - Ce qu'il faut changer

Ce document liste les changements à faire pour obtenir une architecture plus propre, plus robuste, et plus simple à reprendre après une migration de `/data`.

## Ce qui ne va pas actuellement, et comment le corriger

### 1. Le runtime Docker est dans `/data`

Ce qui ne va pas:

- `DockerRootDir` pointe sur `/data/docker`.
- Si `/data` bouge, le moteur Docker perd son état de runtime.
- Une copie brute de `/data/docker` ou `/data/containerd` casse la reprise des layers et des conteneurs.

Comment corriger:

- garder `/data/docker` comme runtime regenerable seulement,
- ne jamais le restaurer comme donnee metier,
- reconstruire les conteneurs depuis les compose et les manifests apres migration,
- si possible a terme, sortir le runtime Docker du volume migrable.

### 2. Le mode d'execution Ryvie est encore en dev

Ce qui ne va pas:

- `pm2` tourne en `dev`.
- Le frontend et le backend utilisent des scripts de dev au lieu d'une reprise prod stabilisee.
- Une migration en cours de production peut donc redemarrer dans un mode pas aligné avec l'exploitation normale.

Comment corriger:

- basculer explicitement vers `prod.sh` pour l'exploitation normale,
- garder `dev.sh` uniquement pour le developpement,
- documenter quel mode doit etre utilise apres reprise,
- verifier que les configs viennent bien de `/data/config` avant de lancer PM2.
Ce qui ne va pas:

- le compose LDAP declarait `my_custom_network`, mais le runtime utilise `ldap_my_custom_network`.
- les stacks legacy perdent la connectivite LDAP si le compose n'est pas aligne.

Comment corriger:

- aligner le compose LDAP sur les deux reseaux: `ldap_my_custom_network` (legacy) et `ryvie-network` (moderne).
- recreer ou rattacher ces reseaux avant de redemarrer les services.
- **FAIT**: `architectureService.ts` normalise automatiquement le compose LDAP au demarrage.

### 4. Portainer n'est pas versionne comme les autres stacks

Ce qui ne va pas:

- Portainer peut avoir ete installe en standalone (docker run) sans compose versionne.
- Une migration risque de perdre sa configuration si le compose n'existe pas.

Comment corriger:

- Detecter un Portainer standalone au boot et le convertir en stack compose sous `/data/config/portainer/docker-compose.yml`.
- **FAIT**: `architectureService.ts` stabilise Portainer en compose automatiquement.

### 5. Certaines dependances reseau sont implicites

Ce qui ne va pas:

- les reseaux Docker externes (`ryvie-network`, `ldap_my_custom_network`) ne sont pas crees automatiquement par Docker.
- si un reseau manque apres migration, les compose echouent silencieusement.

Comment corriger:

- creer les reseaux manquants au demarrage du backend.
- **FAIT**: `architectureService.ts` cree `ryvie-network` et `ldap_my_custom_network` si absents.

### 6. Le plan de reprise depend encore trop de l'etat precedent

Ce qui ne va pas:

- certains services supposent que l'etat Docker precedent existe encore (volumes, reseaux, containers).
- une reprise apres migration ne peut pas reposer sur un runtime Docker copie.

Comment corriger:

- reconstruire systematiquement les conteneurs depuis les compose apres migration.
- ne jamais copier `/data/docker` ou `/data/containerd` comme donnees metier.


### 7. Le montage `/data` doit être vérifié avant tout redémarrage

Ce qui ne va pas:

- si `/data` n'est pas monté avec le bon device BTRFS, la pile ne peut pas repartir proprement,
- les configs, manifests et données d'apps peuvent alors être absents au démarrage.

Comment corriger:

- vérifier `findmnt /data` et `lsblk -f` avant de lancer Docker,
- ne jamais démarrer la pile sans confirmation du montage attendu,
- ajouter ce contrôle dans la procédure de reprise.

## Priorité 1 - Rendre la reprise possible sans ambiguïté

1. Centraliser la source de vérité des services dans `/opt/Ryvie` et dans `/data/config`.
2. Considérer `/data/docker` et `/data/containerd` comme du runtime régénérable, jamais comme des données à restaurer.
3. Documenter noir sur blanc l'ordre de redémarrage:
   - `openldap`
   - apps sous `/data/apps`
   - `pm2` pour Ryvie
4. Vérifier que tous les réseaux Docker externes existent avant toute reprise.

## Priorité 2 - Séparer clairement ce qui est migré de ce qui est régénéré

### À garder dans `/opt/Ryvie`

- les scripts d'orchestration: `scripts/lifecycle/dev.sh`, `scripts/lifecycle/prod.sh`, `scripts/update/update-and-restart.sh`
- le backend et le frontend Ryvie
- la documentation de reprise

### À migrer depuis `/data`

- `/data/config/`
- `/data/apps/`
- `/data/images/`
- `/data/logs/`
- `/data/netbird/`
- `/data/portainer/`

### À sortir du périmètre migré

- `/data/docker/`
- `/data/containerd/`
- `/data/snapshot/`

## Priorité 3 - Corriger les points fragiles déjà identifiés

1. Aligner le réseau LDAP déclaré dans le compose avec le réseau réellement utilisé par les conteneurs.
2. Vérifier que Keycloak, Caddy et LDAP partagent bien le même plan réseau attendu.
3. Éviter les chemins implicites dans les compose des apps.
4. Vérifier que Portainer est bien exporté ou recréable, car son compose n'est pas versionné dans le dépôt.
5. Réduire au minimum les volumes Docker nommés non documentés.
3. Documenter `DockerRootDir=/data/docker` comme état actuel, mais prévoir qu'il soit recréé proprement lors d'une migration.
4. Ne pas dépendre d'un état Docker historique pour redémarrer l'ensemble.

## Priorité 5 - Renforcer l'app Ryvie comme point de contrôle unique

- détecter les réseaux manquants
- détecter les volumes et les configs absents
- lancer les compose dans le bon ordre

## Changements à faire dans le code

- Faire de `/data` le seul point d'entrée pour les opérations de stockage.
- Garder les pré-checks RAID stricts sur le type de montage et l'array cible.

### Démarrage

- S'assurer que `ecosystem.config.js` reste la référence unique des processus PM2.
- Clarifier les scripts de démarrage dev/prod pour qu'ils n'utilisent que les configs persistantes.

### Config générée

- Garder les fichiers de config frontend dans `/data/config/frontend-view`.
- Garder les secrets et réglages Keycloak dans `/data/config/keycloak`.
- Garder la config Caddy dans `/data/config/reverse-proxy`.
3. Standardiser les bind mounts vers `/data`.
4. Prévoir un export clair de chaque stack critique.
5. Valider un runbook de reprise après changement de disque.

## Résultat attendu

Après ces changements, un basculement de stockage doit permettre:

- de remonter un nouveau `/data`
- de recréer le runtime Docker
- de relancer Keycloak, LDAP, Caddy, Portainer et les apps
- de redémarrer l'interface Ryvie rapidement
- de retrouver l'état fonctionnel sans dépendre d'un ancien runtime Docker copié
