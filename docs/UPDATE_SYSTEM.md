# Système de mise à jour Ryvie

Ce document décrit le fonctionnement complet du système de mise à jour de Ryvie, aussi bien pour le système principal que pour les applications individuelles.

---

## Table des matières

1. [Vue d'ensemble](#vue-densemble)
2. [Mise à jour de Ryvie (système)](#mise-à-jour-de-ryvie-système)
3. [Mise à jour des applications](#mise-à-jour-des-applications)
4. [Health check et readiness](#health-check-et-readiness)
5. [Timeouts](#timeouts)
6. [Rollback automatique](#rollback-automatique)
7. [Fichiers impliqués](#fichiers-impliqués)

---

## Vue d'ensemble

Le système de mise à jour repose sur plusieurs composants :

- **Frontend** : détecte les mises à jour disponibles, affiche une bannière, et suit la progression via un modal ou une page HTML dédiée
- **Backend** : expose les API de déclenchement et de suivi, lance les scripts de mise à jour
- **Script shell** (`update-and-restart.sh`) : exécute la mise à jour en arrière-plan, indépendamment du backend (qui sera redémarré)
- **Monitor** (`update-monitor-template.js` + `update-monitor.html`) : serveur Express temporaire sur le port 3001 qui affiche la progression pendant que le backend est arrêté
- **StartupTracker** (`startupTracker.ts`) : suit l'initialisation de chaque service au démarrage du backend pour déterminer quand le serveur est réellement prêt

---

## Mise à jour de Ryvie (système)

### Étape 1 — Détection des mises à jour

Au chargement de la page Home, le frontend appelle :

```
GET /api/settings/updates
```

Le backend vérifie la dernière version disponible sur GitHub via `git ls-remote` (sans API REST, sans token). Si une version plus récente existe, une bannière s'affiche en haut à droite de l'écran avec un bouton qui redirige vers `/settings#updates`.

### Étape 2 — Déclenchement par l'utilisateur

Quand l'admin clique sur "Mettre à jour", le frontend fait **2 appels séquentiels** :

#### 2a. Démarrage du monitor

```
POST /api/settings/start-update-monitor
```

Ce endpoint (`routes/settings.ts`) :
1. Crée le dossier `/tmp/ryvie-update-monitor/`
2. Copie `scripts/update-monitor-template.js` → `/tmp/ryvie-update-monitor/monitor.js`
3. Copie `scripts/update-monitor.html` → `/tmp/ryvie-update-monitor/update-monitor.html`
4. Crée un symlink vers `node_modules` du backend
5. Sauvegarde l'URL de retour dans un fichier `.env`
6. Lance le monitor en arrière-plan avec `setsid` + `nohup` sur le **port 3001**

Le monitor est un processus **indépendant** du backend — il survit au redémarrage PM2.

#### 2b. Lancement de la mise à jour

```
POST /api/settings/update-ryvie
```

Ce endpoint (`routes/settings.ts`) appelle `updateRyvie()` dans `updateService.ts`, qui :
1. Détecte le mode (dev/prod)
2. Récupère le dernier tag GitHub via `git ls-remote`
3. Vérifie si déjà à jour
4. Lance `scripts/update-and-restart.sh` en arrière-plan détaché avec `nohup`
5. Répond immédiatement au frontend

Le frontend est ensuite **redirigé** vers `http://hostname:3001` (le monitor).

### Étape 3 — Exécution du script shell

`scripts/update-and-restart.sh` s'exécute indépendamment du backend. Il écrit sa progression dans `/tmp/ryvie-update-status.json` à chaque étape :

| Progression | Étape | Description |
|---|---|---|
| **5%** | `starting` | Démarrage de la mise à jour |
| **10%** | `snapshot` | Création du snapshot BTRFS de sécurité |
| **30%** | `downloading` | Téléchargement du tarball GitHub |
| **40%** | `extracting` | Extraction de l'archive |
| **50%** | `permissions` | Sauvegarde des permissions |
| **55%** | `applying` | Copie de la nouvelle version dans `/opt/Ryvie` |
| **60%** | `building` | `npm install` + build via `prod.sh` ou `dev.sh` |
| **80%** | `health_check` | Vérification que le backend redémarre correctement |
| **95%** | `restarting` | Système OK, nettoyage du snapshot |
| **100%** | `done` | Mise à jour terminée avec succès |

#### Détail des opérations (5% → 60%)

1. **Snapshot BTRFS** : crée un snapshot de `/data` pour pouvoir rollback
2. **Téléchargement** : `curl` le tarball depuis `api.github.com/repos/ryvieos/Ryvie/tarball/<tag>` (avec token GitHub si disponible)
3. **Extraction** : décompresse dans `.update-staging/extracted/`
4. **Suppression ancien code** : supprime tout dans `/opt/Ryvie` sauf `data/`, `node_modules/`, `.git/`, `.update-staging/`, `netbird-data.json`
5. **Copie** : `cp -rf` de la nouvelle version
6. **Permissions** : restaure le propriétaire original (`chown -R`)
7. **Version** : met à jour `package.json` avec la version cible
8. **Patch prod.sh** : ajoute `--include=dev` aux commandes `npm install` pour garantir les devDependencies
9. **Build** : lance `prod.sh` ou `dev.sh` qui fait `npm install` + `npm run build` + démarrage PM2

### Étape 4 — Health check (80% → 95%)

Voir la section [Health check et readiness](#health-check-et-readiness) ci-dessous.

### Étape 5 — Suivi de la progression (côté client)

Deux mécanismes parallèles suivent la progression :

#### Page monitor HTML (port 3001)

`scripts/update-monitor.html` poll `GET /status` sur le monitor (port 3001) toutes les 2 secondes. Le monitor lit `/tmp/ryvie-update-status.json` et retourne le contenu. Quand `progress >= 100`, la page redirige vers le frontend Ryvie puis appelle `POST /cleanup` pour que le monitor s'auto-détruise.

#### UpdateModal React (si l'utilisateur reste sur le frontend)

`components/UpdateModal.tsx` fait deux phases de polling :

1. **Phase status** : poll `GET /api/settings/update-status` toutes les secondes (tant que le backend répond)
2. **Phase health** : quand le backend tombe (erreur réseau) ou que la progression atteint 95%, passe en mode health check sur `GET /api/health` toutes les 2 secondes. Après 2 réponses 200 consécutives, considère la mise à jour terminée et recharge la page.

### Étape 6 — Nettoyage

Après une mise à jour réussie :
- Le snapshot BTRFS est supprimé
- Le dossier `.update-staging` est nettoyé
- Le monitor s'auto-détruit via `POST /cleanup`

---

## Mise à jour des applications

### Déclenchement

```
POST /api/settings/update-app
Body: { "appName": "rdrop" }
```

Le backend (`routes/settings.ts`) :
1. Vérifie qu'aucune mise à jour n'est déjà en cours pour cette app
2. Répond immédiatement au client
3. Lance un worker (`workers/updateWorker.js`) dans un processus enfant séparé

### Exécution du worker

Le worker appelle `updateApp(appName)` dans `updateService.ts` qui :

| Progression | Étape |
|---|---|
| **0-5%** | Snapshot BTRFS de sécurité |
| **10-15%** | `git fetch --tags` + `git pull` |
| **25-40%** | Téléchargement des fichiers |
| **45-50%** | `docker compose -f <compose-file> up -d --build` |
| **75-85%** | Vérification du statut des containers |
| **95%** | Finalisation |
| **100%** | Terminé |

### Suivi en temps réel

La progression est envoyée via **Server-Sent Events (SSE)** :

```
GET /api/settings/update-progress/:appName
```

Le worker envoie des messages au processus parent via IPC, qui les retransmet au `updateProgressEmitter`, qui les envoie aux clients SSE connectés.

---

## Health check et readiness

### StartupTracker (`services/startupTracker.ts`)

Au démarrage du backend, chaque service est enregistré dans le tracker :

| Service | Description |
|---|---|
| `redis` | Vérification/redémarrage de Redis |
| `network` | Attente d'une interface réseau valide |
| `caddy` | Démarrage du reverse proxy |
| `keycloak` | Démarrage de Keycloak (SSO) |
| `snapshots` | Nettoyage des snapshots en attente |
| `realtime` | Initialisation Socket.IO + Docker events |
| `manifests` | Génération des manifests d'applications |
| `appstore` | Initialisation du catalogue App Store |
| `backgrounds` | Synchronisation des fonds d'écran |
| `netbird` | Synchronisation de la config Netbird |

Chaque service est marqué `done` ou `error` individuellement. Le flag `global.serverReady` n'est mis à `true` que quand **tous** les services sont terminés (done ou error). Un service en erreur ne bloque pas le démarrage — il est considéré comme terminé.

### Endpoints

- **`GET /api/health`** — Retourne toujours 200 si le serveur HTTP écoute (liveness check)
- **`GET /api/health/ready`** — Retourne 200 uniquement quand tous les services sont initialisés (readiness check)
  - **200** : `{ status: "ready", services: [...] }`
  - **503** : `{ status: "initializing", pending: ["keycloak", "appstore"], services: [...] }`

### Health check dans `update-and-restart.sh` (80% → 95%)

La fonction `perform_health_check()` boucle toutes les 3 secondes et fait 3 vérifications :

1. **Logs d'erreur** : cherche des patterns critiques dans les logs récents uniquement (après le timestamp de début du health check) :
   - `Cannot find module dist/index.js`, `EADDRINUSE`, `Segmentation fault`, `Fatal error`
   - PM2 : `too many unstable restarts`, `stopped`, `errored`
   - Si trouvé → **rollback immédiat**

2. **Statut PM2** : via `pm2 jlist`
   - Si `stopped` ou `errored` → **rollback**
   - Si `restart_count > 5` → **rollback** (crash loop)

3. **HTTP `/api/health/ready`** : via `curl` (après 5s minimum)
   - **200** → tous les services sont prêts → **succès**
   - **503** → en cours d'initialisation → on continue d'attendre
   - **500/502** → erreur serveur → on continue d'attendre
   - **000** → pas de réponse → on continue d'attendre

#### Timeout (10 minutes)

Si le timeout est atteint :
- Backend `online` dans PM2 → tente un dernier appel sur `/api/health` (le endpoint basique)
  - Si 200 → on accepte (certains services peuvent encore s'initialiser)
  - Sinon → **rollback**
- Backend pas `online` → **rollback**

#### Fallback sans curl

Si `curl` n'est pas disponible : après 60s avec un statut PM2 `online`, on considère que c'est OK.

---

## Timeouts

| Composant | Timeout | Description |
|---|---|---|
| `update-and-restart.sh` | **10 min** | Health check du backend après rebuild |
| `update-monitor-template.js` | **10 min** | Auto-destruction du serveur monitor |
| `update-monitor.html` | **10 min** | Redirection forcée si rien ne se passe |
| `UpdateModal.tsx` | **10 min** | Health polling frontend (300 tentatives × 2s) |
| `settings.ts` SSE | **30 min** | Timeout SSE pour les mises à jour d'apps |

---

## Rollback automatique

Le rollback est déclenché automatiquement si :
- Le script `prod.sh` ou `dev.sh` échoue (exit code non-0)
- Les `node_modules` ne sont pas installés après le build
- Le health check échoue (erreur critique, crash loop, ou timeout)

### Processus de rollback

1. Si un snapshot BTRFS existe → appelle `scripts/rollback.sh --set <snapshot_path>`
2. Si pas de snapshot → arrête PM2, relance `dev.sh` ou `prod.sh` avec le code actuel
3. Le snapshot est conservé après un rollback (pas supprimé)

---

## Fichiers impliqués

### Scripts

| Fichier | Rôle |
|---|---|
| `scripts/update-and-restart.sh` | Script principal de mise à jour (exécution indépendante) |
| `scripts/update-monitor-template.js` | Serveur Express temporaire (port 3001) pour afficher la progression |
| `scripts/update-monitor.html` | Page HTML de suivi de progression |
| `scripts/snapshot.sh` | Création de snapshots BTRFS |
| `scripts/rollback.sh` | Restauration d'un snapshot |
| `scripts/prod.sh` | Build et démarrage en mode production |
| `scripts/dev.sh` | Build et démarrage en mode développement |

### Backend

| Fichier | Rôle |
|---|---|
| `Ryvie-Back/services/updateService.ts` | Logique de mise à jour (Ryvie + apps) |
| `Ryvie-Back/services/updateCheckService.ts` | Vérification des versions disponibles |
| `Ryvie-Back/services/startupTracker.ts` | Suivi de l'initialisation des services au démarrage |
| `Ryvie-Back/routes/settings.ts` | API endpoints (déclenchement, statut, monitor, SSE) |
| `Ryvie-Back/routes/health.ts` | Endpoints `/api/health` et `/api/health/ready` |
| `Ryvie-Back/index.ts` | Enregistrement des services dans le startupTracker |

### Frontend

| Fichier | Rôle |
|---|---|
| `Ryvie-Front/src/components/UpdateModal.tsx` | Modal de suivi de progression (polling status + health) |
| `Ryvie-Front/src/components/GlobalUpdateModal.tsx` | Portal React pour afficher le modal au-dessus de tout |
| `Ryvie-Front/src/contexts/UpdateContext.tsx` | Context React pour l'état de mise à jour global |
| `Ryvie-Front/src/pages/Home.tsx` | Détection des mises à jour + bannière de notification |

### Fichiers temporaires (pendant la mise à jour)

| Fichier | Rôle |
|---|---|
| `/tmp/ryvie-update-status.json` | Progression écrite par le script shell, lue par le monitor et le backend |
| `/tmp/ryvie-update-monitor/` | Dossier temporaire du service monitor (auto-supprimé) |
| `/opt/Ryvie/.update-staging/` | Dossier temporaire pour le téléchargement et l'extraction |

---

## Schéma du flux

```
Utilisateur clique "Mettre à jour"
        │
        ▼
  POST /api/settings/start-update-monitor
        │  → Lance monitor.js sur port 3001 (indépendant)
        ▼
  POST /api/settings/update-ryvie
        │  → Lance update-and-restart.sh en arrière-plan (nohup)
        ▼
  Redirection vers http://hostname:3001
        │
        ▼
  ┌─────────────────────────────────────────────────┐
  │  update-and-restart.sh                          │
  │                                                 │
  │  5%   Snapshot BTRFS                            │
  │  30%  Téléchargement tarball GitHub             │
  │  40%  Extraction                                │
  │  55%  Copie nouvelle version                    │
  │  60%  npm install + build + PM2 restart         │
  │       ← Le backend redémarre ici                │
  │  80%  Health check (boucle toutes les 3s)       │
  │       → curl /api/health/ready                  │
  │       → Attend que startupTracker dise "ready"  │
  │  95%  Succès, nettoyage snapshot                │
  │  100% Terminé                                   │
  └─────────────────────────────────────────────────┘
        │
        │  Écrit progression dans
        │  /tmp/ryvie-update-status.json
        │
        ▼
  ┌─────────────────────────────────┐
  │  Monitor (port 3001)            │
  │  Poll /status toutes les 2s    │
  │  Affiche barre de progression  │
  │  progress >= 100 → redirige    │
  │  vers le frontend Ryvie        │
  │  puis POST /cleanup            │
  └─────────────────────────────────┘
```
