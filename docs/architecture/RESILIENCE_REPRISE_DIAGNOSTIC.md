# Résilience & reprise — Diagnostic « cloud incassable »

> Objectif visé : un système où l'on peut **supprimer `/opt/Ryvie` et le remettre**, ou
> **restaurer un `/data` sain**, et où l'ensemble se **relance tout seul** sans perdre
> les apps, les users ni les données.
>
> Ce document est un **audit de l'état actuel** (ce qui marche, ce qui manque), pas une
> procédure figée. Voir aussi `ARCHITECTURE_DOCKER_RYVIE_CHANGES.md` (intentions de design).

---

## 1. Où vit réellement l'état (carte de la donnée)

Vérifié par inspection des montages réels des conteneurs (`docker inspect`), pas d'après les
`docker volume ls`.

### La donnée métier est en **bind-mount** sous `/data` (donc portable)

| Domaine | Emplacement réel | Type |
|---|---|---|
| **Users / mots de passe (OpenLDAP)** | `/data/config/ldap/data` → `/bitnami/openldap` | bind |
| **Keycloak (SSO) + sa DB** | `/data/config/keycloak/{postgres,import,themes}` | bind |
| **rPictures** (photos + Postgres) | `/data/apps/Ryvie-rPictures/docker/{library,postgres}` | bind |
| **rDrive** (fichiers + Mongo + OnlyOffice PG + RabbitMQ) | `/data/apps/Ryvie-rDrive/tdrive/docker-data/*` | bind |
| **rTransfer** | `/data/apps/rtransfer/data` | bind |
| **Twenty** (Postgres + storage) | `/data/apps/twenty/{pg_data,server-local-data}` | bind |
| **Paperclip** (Postgres) | `/data/apps/paperclip/data/{pgdata,paperclip}` | bind |
| **n8n / LibreChat / open-notebook / fossflow** | `/data/apps/<app>/…` | bind |
| **Caddy** (reverse proxy, certs/config) | `/data/config/reverse-proxy/{config,data}` | bind |
| Clés de chiffrement, JWT, mdp LDAP admin | `/data/config/backend-view/.env` | fichier |

### Ce qui reste en **volumes Docker nommés** = jetable / régénérable

Redis des apps (cache/queues), `configdb` Mongo (recréée seule), `rpictures_model-cache`
(modèles ML re-téléchargés), polices OnlyOffice, état buildkit.
**Aucune donnée user, aucune base métier, aucun fichier** n'est dans un volume nommé.

> ⚠️ Des volumes nommés « historiques » subsistent (`ldap_openldap_data`,
> `appflowy_postgres_data`, `immich-prod_*`, `app-rpictures_pgvecto-rs`…). Ce sont des
> **résidus d'anciennes versions de compose** ; les conteneurs actifs n'y sont plus montés.
> Ne pas les confondre avec la donnée vivante.

### Conséquence directe

Échanger `/data` (avec `/data/apps` + `/data/config`) **et reconstruire les conteneurs via
les docker-compose** ⇒ on retrouve **mêmes apps, mêmes users, même data**.
Le **moteur Docker + containerd + images + volumes nommés** n'ont **pas** besoin d'être
transférés : images re-pullées/rebuildées, conteneurs recréés depuis les compose, re-pointant
sur les binds `/data/...`.

C'est pourquoi sortir Docker/containerd de `/data` (`/var/lib` sur VM/VPS, voir `install.sh`)
est **sans risque pour la portabilité** : on ne déplace que du runtime régénérable.

---

## 2. Frontière migré / régénéré

| Catégorie | Chemins | Traitement |
|---|---|---|
| **À migrer / sauvegarder** (donnée) | `/data/config/`, `/data/apps/`, `/data/images/`, `/data/logs/`, `/data/netbird/` | **restaurer** |
| **Runtime régénérable** (jamais restaurer comme donnée) | `/data/docker/`, `/data/containerd/`, `/data/snapshot/` | **recréer** |
| **Code + orchestration** | `/opt/Ryvie/` | re-cloner + `prod.sh` |

---

## 3. Ce que fait déjà la reprise automatique

Au boot :

1. **`pm2-ryvie.service`** (systemd, activé) ressuscite `ryvie-backend` + `ryvie-frontend`
   depuis `~/.pm2/dump.pm2`.
2. Le backend (`Ryvie-Back/index.ts`) exécute une **séquence de réconciliation** suivie par
   `startupTracker` :
   `architecture → redis → network → caddy → ldap → keycloak → ai → realtime → manifests →
   oauth-sync → appstore → backgrounds → netbird`.

Détails utiles :

- `enforceArchitectureBase` (`services/architectureService.ts`) : **crée les réseaux Docker
  manquants** (`ryvie-network`, `ldap_my_custom_network`), **normalise le compose LDAP**,
  stabilise Portainer, et fait `docker compose up -d` pour LDAP + Portainer.
- `caddyService`, `ldapService`, `keycloakService`, `aiService` : chacun fait son propre
  `docker compose up -d` (avec `composeUpWithRecovery`).
- `syncAllAppsOAuth` (`services/appsOAuthService.ts`) : **relance les apps SSO** via
  `docker compose up -d`.
- `prod.sh` : garde-fou **refuse de démarrer si `/data` n'est pas monté** ; synchronise le
  `.env` depuis `/data/config/backend-view/`, régénère la config frontend
  (`generate-frontend-config.sh`), symlink `dist/config → /data/config/frontend-view`.

---

## 4. Scénario 1 — supprimer `/opt/Ryvie` et le remettre

| Méthode | Résultat |
|---|---|
| `git clone` **nu** + reboot | ❌ **Insuffisant** |
| clone + `bash scripts/lifecycle/prod.sh` | ✅ Fonctionne |

**Pourquoi le clone nu ne suffit pas :** `/opt/Ryvie` contient des **artefacts dérivés non
versionnés**, régénérés à l'installation :

- `Ryvie-Back/node_modules/`, `Ryvie-Front/node_modules/`
- `Ryvie-Front/dist/` (build)
- `Ryvie-Back/.env` (copié depuis `/data/config/backend-view/`)
- configs frontend générées, `Ryvie-Front/src/config/netbird-data.json`
- le **dump PM2** dans `/home/ryvie/.pm2/dump.pm2` (**hors `/opt` ET `/data`**)

Un clone laisse tout ça vide ⇒ PM2 n'a rien à ressusciter.

**Bonne nouvelle :** `prod.sh` reconstruit **tout** depuis `/data/config` (npm install + build +
génération config + `.env` sync + symlinks + `pm2 start` + `pm2 save`). `/opt` est donc
réellement *stateless* vis-à-vis des secrets.

**Manque :** une **commande de reprise unique** (`clone/pull → prod.sh`) + runbook.

> ⚠️ Vérifier qu'il ne reste **pas de modifs non commitées** dans `/opt/Ryvie` : au moment du
> diagnostic, des fichiers étaient modifiés localement (`routes/ai.ts`, `routes/storage.ts`,
> `services/aiService.ts`, plusieurs `Ryvie-Front/…`). En production, le code doit être
> **commité / taggé**, sinon il est perdu au re-clone.

---

## 5. Scénario 2 — restaurer `/data`, laisser `/opt` tout relancer

| Composant | Relancé au boot ? |
|---|---|
| Infra core : LDAP, Keycloak, Caddy, IA (LiteLLM) | ✅ oui (services dédiés) |
| Apps **SSO** : rDrive, rPictures, rDrop, rTransfer | ✅ oui (`oauth-sync`) |
| Apps **non-SSO** : n8n, Twenty, LibreChat, Paperclip, open-notebook, fossflow… | ⚠️ **NON explicitement** |

**Le point faible :** il **n'existe pas de réconciliateur de boot qui fasse
`docker compose up -d` sur *toutes* les apps installées** dans `/data/apps/*`.

- `appStoreService.initialize()` ne fait que **détecter** les apps installées (enrichit les
  versions), il ne les démarre pas.
- `realtimeService.initializeActiveContainers()` ne suit que les conteneurs **déjà actifs**.

Aujourd'hui ça « marche » au **reboot normal** uniquement parce que les conteneurs ont
`restart: unless-stopped` **et** que le runtime `/data/docker` persiste ⇒ Docker les relance
seul. Mais dans une **vraie restauration `/data` sur runtime Docker neuf** (le cas cible, car
`/data/docker` ne doit **pas** être restauré), **les apps non-SSO ne remontent pas
automatiquement.**

---

## 6. État hors `/data` **et** hors `/opt` (à assumer)

| État | Emplacement | Impact | Régénérable ? |
|---|---|---|---|
| Définitions PM2 | `~/.pm2/dump.pm2` | ce qui relance backend/frontend au boot | ✅ par `prod.sh` (`pm2 save`) |
| **Redis hôte** | `/var/lib/redis` | secrets d'app / sessions / queues | ⚠️ oui, mais peut forcer re-logins / re-saisie credentials |
| Identité machine | `/etc/machine-id` | enregistrement NetBird / Ryvie Connect | l'appareil se ré-enregistre |
| Services systemd | `pm2-ryvie`, `netbird`, `docker`, `redis`, `avahi` | démarrage au boot | recréés par `install.sh` |
| Config moteur | `/etc/docker/daemon.json`, `/etc/containerd/config.toml` | data-root Docker/containerd | recréés par `install.sh` |
| sudo NOPASSWD | `/etc/sudoers.d/ryvie` | droits `ryvie` | recréé par `install.sh` |

---

## 7. Verdict

Architecture **~80 % « incassable »** : l'intention et la mécanique de reprise existent déjà
(séquence de réconciliation backend, garde-fou `/data`, doc de design). Il manque **2 briques**
pour fermer la boucle, plus 3 fuites d'état non bloquantes.

### Brèches à combler

1. **Reprise `/opt` en une commande** *(ferme le scénario 1)*
   Formaliser `ryvie-reprise` (ou faire de `prod.sh` l'entrée officielle) :
   `git clone/pull → prod.sh`. Documenter le runbook. S'assurer que le code est commité.

2. **Réconciliateur boot « start ALL installed apps »** *(ferme le scénario 2)*
   Au démarrage backend, boucler sur `/data/apps/*` (+ manifests) et faire
   `composeUpWithRecovery` dans le bon ordre (LDAP → Keycloak → apps), pour **ne pas dépendre
   du runtime Docker restauré**.

### Fuites d'état à traiter (non bloquantes)

- `~/.pm2/dump.pm2` → couvert si `prod.sh` est l'entrée de reprise.
- **Redis `/var/lib/redis`** → envisager `dir /data/config/redis` dans `redis.conf` pour le
  ramener dans le périmètre migrable, ou l'accepter comme régénérable.
- `/etc/machine-id` + identité NetBird → ré-enregistrement automatique.

### Ordre de reprise recommandé (runbook cible)

1. Vérifier le montage : `findmnt /data` (bon device attendu).
2. Runtime Docker **neuf** (ne pas restaurer `/data/docker` / `/data/containerd`).
3. `/opt/Ryvie` : `git clone/pull` de la **version taggée correspondant aux schémas DB**.
4. `bash /opt/Ryvie/scripts/lifecycle/prod.sh` (reconstruit `/opt` + relance PM2).
5. Laisser le backend réconcilier : réseaux → LDAP → Keycloak → Caddy → IA → **toutes les apps**.
6. Contrôler `pm2 status` + l'état des conteneurs.

---

*Diagnostic établi le 2026-07-03 sur une instance RyvieOS (`/data` = md0 Btrfs). Les chemins et
comportements décrits ont été vérifiés en direct (montages conteneurs, `index.ts`, `prod.sh`,
`architectureService.ts`, PM2, systemd).*
