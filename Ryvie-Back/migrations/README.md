# Migrations de données (`/data`)

Ce dossier contient les **migrations de données**, exécutées au démarrage du backend
par `services/system/migrationRunner.ts` (brique `migrations` du `startupTracker`).

## Pourquoi

Le système de mise à jour de Ryvie remplace le **code** d'un seul coup : un utilisateur
peut sauter directement de `v0.0.30` à `v1.0.0` sans passer par les versions
intermédiaires (comme un iPhone). Mais les **données** dans `/data` survivent à la mise à
jour et peuvent être à un ancien format.

Les migrations garantissent que, quel que soit le chemin de versions emprunté, les
données sont amenées au format attendu par le code courant.

## Comment ça marche

- L'état est stocké dans `/data/config/data-version.json` → `{ "dataVersion": N }`.
  Ce numéro n'a **aucun rapport** avec la version de Ryvie ; c'est un compteur interne
  du format des données.
- Au démarrage, le runner applique **dans l'ordre croissant** toutes les migrations dont
  `version > dataVersion`, puis avance `dataVersion` après chaque succès.
- Un échec est **bloquant** : le démarrage s'arrête → le health check de
  `update-and-restart.sh` déclenche le **rollback BTRFS** automatique.

## Écrire une migration

1. Créer un fichier `NNN-description-courte.ts` (numéro **unique**, croissant) :

```ts
// migrations/001-exemple.ts
export = {
  version: 1,
  description: 'Décrit ce que fait la migration',
  async up() {
    // ...transformation...
  }
};
```

2. **Règle d'or — idempotent et basé sur l'ÉTAT, jamais sur la version de Ryvie.**
   Écrivez « **si** les données sont à l'ancien format, convertis-les », pas
   « en passant de la version X à Y ». Conséquences :
   - Sûre sur une **installation neuve** (l'ancien format n'existe pas → no-op).
   - Sûre si **rejouée** (déjà migrée → no-op).
   - Sûre quel que soit le **point de départ** (saut de plusieurs versions).

### Exemple concret

```ts
// migrations/001-encrypt-app-secrets.ts
const fs = require('fs');
const SECRETS = '/data/config/appSecrets.json';

export = {
  version: 1,
  description: 'Chiffre appSecrets.json s\'il est encore en clair',
  async up() {
    if (!fs.existsSync(SECRETS)) return;              // rien à migrer
    const raw = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
    if (raw.__encrypted) return;                      // déjà migré → no-op
    // ...chiffrer puis réécrire avec { __encrypted: true, ... }...
  }
};
```

> Les fichiers `.ts` de ce dossier sont compilés vers `dist/migrations/` par `tsc`
> (comme le reste du backend) et chargés à l'exécution depuis là.
