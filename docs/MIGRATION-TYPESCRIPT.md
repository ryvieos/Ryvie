# Migration vers TypeScript - Back-end Ryvie

## Résumé

Le back-end de Ryvie a été entièrement migré de JavaScript vers TypeScript. Cette migration conserve exactement le même comportement fonctionnel.

## Changements effectués

### 1. Structure du projet

- **Fichiers sources** : Tous les fichiers `.js` ont été convertis en `.ts`
- **Fichiers compilés** : Les fichiers JavaScript compilés sont maintenant dans le dossier `dist/`
- **Configuration TypeScript** : Ajout de `tsconfig.json` avec configuration CommonJS

### 2. Fichiers convertis

#### Configuration
- `config/ldap.ts`
- `config/paths.ts`

#### Middleware
- `middleware/auth.ts`

#### Routes (9 fichiers)
- `routes/admin.ts`
- `routes/appStore.ts`
- `routes/apps.ts`
- `routes/auth.ts`
- `routes/settings.ts`
- `routes/storage.ts`
- `routes/system.ts`
- `routes/userPreferences.ts`
- `routes/users.ts`

#### Services (10 fichiers)
- `services/appManagerService.ts`
- `services/appStoreService.ts`
- `services/authService.ts`
- `services/dockerService.ts`
- `services/ldapService.ts`
- `services/realtimeService.ts`
- `services/reverseProxyService.ts`
- `services/systemService.ts`
- `services/updateCheckService.ts`
- `services/updateService.ts`

#### Utils (5 fichiers)
- `utils/network.ts`
- `utils/security.ts`
- `utils/snapshotCleanup.ts`
- `utils/syncBackgrounds.ts`
- `utils/syncNetbirdConfig.ts`

#### Workers
- `workers/installWorker.ts`

#### Fichier principal
- `index.ts`
- `redisClient.ts`

### 3. Package.json

#### Scripts mis à jour
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc && node dist/index.js"
  }
}
```

#### Dépendances ajoutées
```json
{
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/multer": "^1.4.12",
    "@types/node": "^20.11.19",
    "typescript": "^5.3.3"
  }
}
```

### 4. Configuration TypeScript (tsconfig.json)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./",
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true,
    "noImplicitAny": false,
    "strictNullChecks": false,
    "allowJs": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.js"]
}
```

## Utilisation

### Développement

```bash
# Compiler le projet
npm run build

# Démarrer le serveur
npm start

# Compiler et démarrer (mode dev)
npm run dev
```

### Production

Le serveur démarre maintenant avec `node dist/index.js` au lieu de `node index.js`.

## Notes importantes

1. **Compatibilité** : Le code utilise toujours la syntaxe CommonJS (`require()` et `module.exports`) pour une compatibilité maximale
2. **Mode non-strict** : TypeScript est configuré en mode non-strict pour faciliter la migration sans casser le code existant
3. **Typage minimal** : Les types `any` sont utilisés pour les paramètres Express afin de conserver le comportement exact
4. **Pas de changements fonctionnels** : Le comportement du serveur reste identique à la version JavaScript
5. **Script externe** : Le fichier `/opt/Ryvie/generate-manifests.js` a été recompilé depuis TypeScript et fonctionne normalement

## Avertissements de compilation

Certains avertissements TypeScript peuvent apparaître lors de la compilation. Ils sont normaux et n'empêchent pas le fonctionnement du serveur :
- Redéclarations de variables (dues à l'utilisation de `const` dans plusieurs fichiers)
- Propriétés manquantes sur les types `{}` (dues au typage minimal)

Ces avertissements peuvent être corrigés progressivement en ajoutant des types plus précis.

## Prochaines étapes (optionnelles)

Pour améliorer progressivement le typage :
1. Activer `strict: true` dans `tsconfig.json`
2. Créer des interfaces pour les objets métier
3. Remplacer les `any` par des types plus précis
4. Ajouter des types pour les réponses API
