# Ryvie - Resume architecture ultra solide

Ce document condense l'objectif, l'etat actuel du code et la regle de base pour qu'une migration de stockage ou de RAID reste reproductible.

## Objectif

L'objectif est simple:

- pouvoir remplacer ou deplacer `/data` sans casser Ryvie;
- reconstruire les services a partir du code et des compose, pas a partir d'un runtime Docker copie;
- garder `/opt/Ryvie` comme plan de controle;
- garder `/data/config` et `/data/apps` comme source de verite des donnees persistantes.

## Ce que le code fait deja

Au demarrage, le backend Ryvie lance une verification architecturale dans `Ryvie-Back/index.ts` via `services/architectureService.ts`.

Cette verification couvre deja:

- la presence du reseau `ryvie-network`;
- la correction du compose LDAP legacy quand il utilise encore `my_custom_network`;
- le maintien de la compatibilite LDAP legacy via `ldap_my_custom_network`;
- la stabilisation de Portainer en stack compose si une installation brute est detectee;
- le demarrage controle de Caddy via `reverseProxyService`;
- le demarrage controle de Keycloak via `keycloakService`;
- la reprise des apps Docker depuis leurs compose et manifests apres migration RAID.

## Regle de migration importante

Le point crucial est le suivant:

- `DockerRootDir` et le runtime `containerd` ne doivent pas etre traites comme des donnees metier;
- `/data/docker` et `/data/containerd` doivent etre recrees, pas copies;
- les vrais elements a migrer sont les configs, les manifests, les apps et les donnees persistantes.

Pourquoi:

- Docker stocke des metadonnees internes et des IDs de layers;
- une copie brute du runtime casse souvent les volumes, overlays et references internes;
- lors d'un changement de disque ou de baie, il faut reconstruire les conteneurs depuis les compose, pas restaurer l'etat Docker brut.

## Ce qui doit partir dans la migration

Ce qui doit etre migre:

- `/data/config`
- `/data/apps`
- `/data/images`
- `/data/logs`
- `/data/netbird`
- `/data/portainer`
- `/data/config/ldap/data`
- `/data/config/keycloak/postgres`
- `/data/config/reverse-proxy/data`
- `/data/config/reverse-proxy/config`

Ce qui doit etre exclu ou recree:

- `/data/docker`
- `/data/containerd`
- `/data/snapshot`

## Vue service par service

| Service | A migrer | A reconstruire | A exclure |
| --- | --- | --- | --- |
| OpenLDAP | `/data/config/ldap/data`, `/data/config/ldap/docker-compose.yml` | Le conteneur `openldap` | Le volume Docker nomme `openldap_data` et tout ancien volume Compose legacy |
| Keycloak | `/data/config/keycloak/postgres`, `/data/config/keycloak/import`, `/data/config/keycloak/themes`, `/opt/Ryvie/keycloak/docker-compose.yml` | Les conteneurs `keycloak` et `keycloak-postgres` | Le runtime Docker utilise par Keycloak |
| Caddy | `/data/config/reverse-proxy/Caddyfile`, `/data/config/reverse-proxy/data`, `/data/config/reverse-proxy/config`, `/data/config/reverse-proxy/docker-compose.yml` | Le conteneur `caddy` | Aucun volume Docker critique a conserver en source de verite |
| Portainer | `/data/config/portainer` et `/data/portainer` | Le conteneur `portainer` via compose | Le conteneur standalone non versionne |
| Applications Docker | `/data/apps`, `/data/config/manifests`, les `.env` persistants par app | Les conteneurs issus des compose de chaque app | Les volumes internes Docker non documentes |
| Ryvie (PM2) | `/opt/Ryvie`, `/data/config/backend-view`, `/data/config/frontend-view`, `/data/logs` | Les processus PM2 `dev` ou `prod` selon le mode | Le runtime Docker, qui n'est pas la source de verite de Ryvie |

Regle pratique: si la donnee doit survivre a un changement de disque sans redeploiement manuel, elle doit vivre dans `/data/config`, `/data/apps` ou un bind mount documente. Si elle appartient au moteur Docker lui-meme, elle doit etre recreee, pas copiee comme une donnee metier.

## Services critiques et ordre de reprise

Ordre de reprise recommande:

1. Monter `/data`.
2. Verifier que le montage est bien le bon.
3. Demarrer Docker Engine.
4. Recréer `ryvie-network` et `ldap_my_custom_network` si besoin.
5. Demarrer OpenLDAP.
6. Demarrer Caddy (peut temporairement retourner 502 tant que les backends ne sont pas prets).
7. Demarrer Keycloak et sa base PostgreSQL.
8. Demarrer Portainer.
9. Relancer PM2 pour Ryvie.
10. Relancer les apps sous `/data/apps`.

Note: dans le code (`index.ts`), l'ordre est Caddy puis Keycloak. Caddy accepte les connexions immediatement et retourne 502 temporairement pour les backends pas encore prets. L'important est que LDAP soit disponible avant Keycloak.

## Pourquoi ce decoupage est solide

Il separe trois roles differents:

- le code d'orchestration dans `/opt/Ryvie`;
- les donnees persistantes dans `/data`;
- le runtime regenerable de Docker et containerd.

Cette separation permet de:

- reconstruire les stacks apres migration;
- limiter les dependances sur l'etat precedent;
- reduire le risque qu'un disque ou un runtime corrompu empeche toute reprise.

## Limites actuelles a garder en tete

Le code fait deja beaucoup de remise en etat, mais la robustesse ultime repose encore sur:

- des compose propres et versionnes;
- des reseaux externes explicites, y compris la compatibilite legacy LDAP;
- une discipline stricte sur ce qui est copie ou non lors d'une migration;
- un demarrage apres verification du montage `/data`.

## Fichier a retenir

- [Etat detaille de l'architecture](ARCHITECTURE_DOCKER_RYVIE.md)
- [Liste des changements et points faibles](ARCHITECTURE_DOCKER_RYVIE_CHANGES.md)
- [Resume ultra solide](ARCHITECTURE_DOCKER_RYVIE_RESUME.md)
