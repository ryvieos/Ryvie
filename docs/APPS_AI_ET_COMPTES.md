# Apps Ryvie — IA & réinitialisation des comptes

Ce document décrit, **pour chaque app du store**, deux mécanismes indépendants :

1. **IA** — comment l'app est branchée au point central IA de Ryvie (LiteLLM).
2. **Comptes / réinitialisation de mot de passe** — comment Ryvie liste les comptes
   d'une app, réinitialise leur mot de passe, et provisionne le compte par défaut.

Les deux se déclarent dans le manifeste de l'app (`ryvie-app.yml`), via les blocs
`ai:` et `accounts:`. Le cœur (`Ryvie-Back`) n'exécute **jamais** de code livré par
le store : il interprète une poignée de stratégies connues, paramétrées par la recette.

- Moteur comptes : `Ryvie-Back/services/appAccountsService.ts`
- Moteur IA : bloc `ai:` interprété au connect/disconnect (voir point central IA)
- Recettes : `opt/Ryvie-Apps/<app>/ryvie-app.yml` + fiche `accounts/ryvie-accounts.*`

---

## 1. Mécanisme IA (`ai:`)

Une app est « connectable à l'IA » si son manifeste contient un bloc `ai:`. À la
connexion (Réglages → IA), Ryvie écrit la clé + l'URL du LiteLLM Ryvie dans l'app :

```yaml
ai:
  set:
    apiKey: RYVIE_AI_KEY        # nom de la variable .env à écrire (clé LiteLLM)
    baseUrl: RYVIE_AI_BASE_URL  # nom de la variable .env à écrire (URL OpenAI-compat)
  containers:
    - app-<id>                  # conteneur(s) rattachés au réseau ryvie-ai (DNS ryvie-litellm)
  restart: true                 # recréer/redémarrer l'app pour prendre l'env
  hooks:                        # (optionnel) scripts app-fournis exécutés au connect/disconnect
    connect: ai/connect.sh
    disconnect: ai/disconnect.sh
```

**Ce qu'il faut regarder pour l'IA :**
- Le bloc `ai.set` : quelles variables `.env` l'app consomme pour son endpoint OpenAI-compatible.
- `containers` : le conteneur doit rejoindre le réseau `ryvie-ai` pour résoudre `ryvie-litellm` par DNS.
- `restart: true` si l'app fige l'env à la création (la plupart des cas).
- `hooks` : quand l'endpoint « Ryvie AI » doit apparaître/disparaître dynamiquement
  dans l'UI de l'app (ex. LibreChat édite `librechat.yaml`).

---

## 2. Mécanisme comptes (`accounts:`)

Le bloc `accounts:` porte deux choses distinctes, chacune optionnelle :

- **`default:`** — le compte par défaut Ryvie (`changeme@ryvie.fr`), provisionné à
  l'install et affiché dans l'UI tant qu'il est inchangé. Champ `provision:` = comment le créer.
- **`strategy:`** — comment **lister + réinitialiser** les comptes depuis l'UI Ryvie.

Sans `strategy`, l'UI n'offre **pas** de bouton « réinitialiser le mot de passe »
(au mieux elle affiche le compte par défaut). Sans `default`, aucun compte n'est
pré-créé.

### Modes de provisioning (`default.provision`)

| Mode            | Ce que ça fait                                                        |
|-----------------|----------------------------------------------------------------------|
| `shipped`       | Compte déjà présent dans l'image (rien à faire).                      |
| `installScript` | Compte créé par le `install.sh` de l'app.                            |
| `api`           | Ryvie crée le compte via l'API REST de l'app (bloc `signup`/`login`). |
| `sql-update`    | Ryvie transforme un compte embarqué en compte Ryvie via SQL (bcrypt). |
| `adapter`       | Ryvie crée le compte via la fiche (`provision` → `DONE`).             |

### Stratégies de reset (`strategy`)

| Stratégie          | Comment Ryvie liste/réinitialise                                          | Fiche |
|--------------------|--------------------------------------------------------------------------|-------|
| `container-exec`   | Fiche `ryvie-accounts.*` exécutée DANS le conteneur de l'app (`list`/`reset`/`verify`/`provision`). Le cœur ne connaît ni schéma ni hash. | oui |
| `hermes-webui`     | Mot de passe unique écrit dans `settings.json` puis restart conteneur.    | non |
| `hermes-dashboard` | Mot de passe unique réécrit dans `.env` puis recréation du conteneur.     | non |
| `unsupported`      | Reset explicitement non disponible (avec `reason`).                       | non |
| *(absente)*        | Pas de listing/reset ; éventuellement `ownerReset` ou provisioning seul.  | — |

**`ownerReset:`** (à part) — pour les apps sans reset par compte : rejoue une
commande CLI native de l'app qui remet le compte propriétaire à zéro sans détruire
les données (ex. n8n `user-management:reset`), avec `restart` si nécessaire.

### La fiche `container-exec`

Script embarqué avec l'app (dans le langage de l'app), monté en `/ryvie/ryvie-accounts.*`
via le compose, et exécuté dans le conteneur `app-<id>`. Convention de sous-commandes :

```
<runtime> <script> list      -> stdout = JSON [{id,email,username,isAdmin}]
<runtime> <script> reset     -> env RESET_ID/RESET_PWD ; stdout contient "OK"
<runtime> <script> verify    -> env RESET_ID/RESET_PWD ; stdout "OK" si le mdp matche
<runtime> <script> provision -> env DEFAULT_EMAIL/USER/PWD ; stdout "DONE"
```

Sécurité : la fiche ne s'exécute QUE dans un conteneur `app-<id>` (jamais le cœur,
jamais le socket Docker). Les mots de passe transitent par l'environnement, jamais
sur la ligne de commande. Ne JAMAIS logger un mot de passe ni un hash.

---

## 3. Matrice par app

| App           | Catégorie    | IA  | Provisioning | Reset (strategy)         | Fiche                 |
|---------------|--------------|-----|--------------|--------------------------|-----------------------|
| affine        | Productivity | oui | installScript| `container-exec` (Node/Prisma/argon2) | `ryvie-accounts.cjs` |
| docuseal      | Productivity | —   | adapter      | `container-exec` (rails/Devise bcrypt) | `ryvie-accounts.rb` |
| fossflow      | Diagrams     | —   | —            | aucun                    | —                     |
| hermes        | AI           | oui | shipped      | `hermes-dashboard`       | —                     |
| jellyfin      | Multimédia   | —   | api          | aucun (provisioning seul)| —                     |
| **librechat** | AI           | oui | adapter      | `container-exec` (Node/mongodb/bcryptjs) | `ryvie-accounts.cjs` |
| linkwarden    | Organization | oui | —            | aucun                    | —                     |
| mealie        | Planners     | oui | sql-update   | `container-exec` (python3/sqlite bcrypt) | `ryvie-accounts.py` |
| memos         | Productivity | —   | api          | aucun (provisioning seul)| —                     |
| n8n           | Automation   | oui | api          | aucun + `ownerReset` (CLI) | —                   |
| open-notebook | Productivity | oui | —            | aucun                    | —                     |
| paperclip     | AI           | —   | installScript| `container-exec` (Node)  | `ryvie-accounts.mjs`  |
| rdrive        | Storage      | oui | —            | SSO (Keycloak)           | —                     |
| rdrop         | Sharing      | —   | —            | aucun                    | —                     |
| rpictures     | Storage      | —   | —            | SSO (Keycloak)           | —                     |
| rtransfer     | Sharing      | —   | —            | aucun                    | —                     |
| twenty        | Productivity | oui | —            | `container-exec` (Node)  | `ryvie-accounts.mjs`  |
| vaultwarden   | Security     | —   | —            | aucun                    | —                     |

> Apps **SSO** (rdrive, rpictures) : les comptes sont gérés par Keycloak, pas par
> `appAccountsService` — le reset se fait dans l'admin Keycloak. Le bloc `accounts:`
> est refusé côté cœur pour ces apps (`sso: true`).

---

## 4. Par app — ce qu'il faut regarder / faire

- **affine** — Reset OK (fiche Node réutilise Prisma + argon2 d'AFFiNE). IA OK.
- **docuseal** — Reset OK (fiche Ruby via `rails runner`, Devise/bcrypt). Compte par défaut créé à l'install (adapter). Pas d'IA.
- **fossflow** — Pas de comptes (diagrammes locaux). Rien à faire.
- **hermes** — Auth par mot de passe unique (basic auth `.env`), reset = recréation conteneur. IA OK.
- **jellyfin** — Compte par défaut provisionné par API à l'install, mais **pas de reset** par compte (à ajouter : fiche `container-exec` sur la base SQLite Jellyfin si besoin).
- **librechat** — **Nouveau** : reset via fiche `ryvie-accounts.cjs` (MongoDB + bcryptjs), compte par défaut créé à l'install (adapter). IA OK (endpoint dynamique dans `librechat.yaml`).
- **linkwarden** — IA OK, mais **pas de reset** (à ajouter : Linkwarden = Postgres + Prisma/argon2 ; fiche `container-exec` possible).
- **mealie** — Reset OK (fiche python/sqlite bcrypt, déverrouille le compte). IA OK.
- **memos** — Compte par défaut par API, **pas de reset** (memos = Go sans python/sqlite dans l'image → fiche difficile ; envisager l'API memos si elle expose un reset).
- **n8n** — Pas de reset par compte mais **`ownerReset`** (CLI native, non destructif) + provisioning API. IA OK.
- **open-notebook** — IA OK, pas de comptes multi-utilisateurs à réinitialiser côté Ryvie.
- **paperclip** — Reset OK (fiche Node). Pas d'IA déclarée.
- **rdrive** — **SSO** (Keycloak). Reset via Keycloak. IA OK.
- **rdrop** — Partage éphémère, pas de comptes.
- **rpictures** — **SSO** (Keycloak). Reset via Keycloak.
- **rtransfer** — Transfert éphémère, pas de comptes.
- **twenty** — Reset OK (fiche Node). IA OK.
- **vaultwarden** — Coffre-fort : comptes gérés en interne (master password E2E), **volontairement pas de reset** côté Ryvie (le reset casserait le chiffrement).

---

## 5. Checklist — ajouter le reset à une app

1. **Identifier le stockage des comptes** : SQLite ? Postgres/MySQL ? MongoDB ?
   fichier ? Et le **format de hash** (bcrypt, argon2, scrypt…).
2. **Choisir la stratégie** :
   - App avec un runtime + sa lib de hash dans l'image → `container-exec` (recommandé,
     réutilise le hasher exact de l'app → login garanti compatible).
   - App exposant une API de reset → provisioning/`api` (mais rarement un reset admin).
   - App à mot de passe unique via `.env` → modèle `hermes-dashboard`.
   - App avec CLI de reset propriétaire non destructive → `ownerReset`.
3. **Écrire la fiche** `accounts/ryvie-accounts.<ext>` (sous-commandes `list`/`reset`/
   `verify`/`provision`). Résoudre les deps depuis les `node_modules`/libs de l'app.
   Ne jamais interpoler un mot de passe dans la ligne de commande (utiliser l'env).
4. **Monter la fiche** dans le compose : `./accounts/ryvie-accounts.<ext>:/ryvie/ryvie-accounts.<ext>:ro`.
5. **Déclarer la recette** `accounts:` dans `ryvie-app.yml` (`strategy`, `container`,
   `runtime`/`exec`, `script`, `reset.expect`, `default`).
6. **Redéployer l'app** (réinstall ou `docker compose up -d` pour prendre le nouveau
   montage), puis **redémarrer le backend** Ryvie pour recharger le manifeste.
7. **Vérifier** : `list` renvoie les comptes ; `reset` renvoie `OK` ; le login avec le
   nouveau mot de passe passe réellement dans l'app ; le compte par défaut s'affiche
   tant qu'il est inchangé.
