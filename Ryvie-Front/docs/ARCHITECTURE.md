# Architecture Ryvie - Frontend

## 🎯 Configuration Centralisée

### Fichier unique : `/src/config/appConfig.js`

**Toute la configuration de Ryvie est maintenant centralisée dans un seul fichier !**

#### Configuration de la grille (`GRID_CONFIG`)

- `BASE_COLS`: 10 (nombre de colonnes en plein écran)
- `BASE_ROWS`: 4 (nombre de lignes minimum)
- `SLOT_SIZE`: 120px (taille fixe d'un slot - ne change JAMAIS)
- `GAP`: 12px (espacement entre slots)
- `MIN_COLS`: 3 (nombre minimum de colonnes sur petit écran)
- `HORIZONTAL_PADDING`: 80px (marges latérales)

### Composants

1. **`GridLauncher.js`** : Composant principal de la grille
   - Responsive automatique (calcul des colonnes selon la largeur)
   - Drag & drop natif via `useDrag` hook
   - Layout sauvegardé sur le backend par utilisateur

2. **Hooks personnalisés** :
   - `useGridLayout` : Gestion du layout, collisions, snapping
   - `useDrag` : Gestion du drag & drop (souris + tactile)

3. **Persistance** :
   - Les positions sont sauvegardées par utilisateur dans `/api/user/preferences/launcher`
   - Format: `{ anchors: {}, layout: {}, widgets: {}, apps: [] }`

#### Configuration des applications

**Fonction principale** : `generateAppConfigFromManifests(accessMode)`

- Charge les apps depuis `/api/apps/manifests`
- Génère automatiquement les icônes depuis le backend
- Chaque app contient un **champ `id` obligatoire** pour les actions start/stop/restart
- Ajoute automatiquement les icônes de la taskbar (locales)

### Exemple de config générée :
```javascript
{
  'app-rdrive': {
    id: 'rdrive',              // ⚠️ OBLIGATOIRE pour restart
    name: 'Rdrive',
    description: 'Stockage cloud',
    category: 'productivity',
    icon: 'https://server/api/apps/rdrive/icon',
    showStatus: true,
    ports: [3010]
  },
  'task-settings.svg': {
    name: 'Settings',
    showStatus: false,
    isTaskbarApp: true,
    route: '/settings'
  }
}
```

## 📦 Système de Grille (GridLauncher)

## 🔧 Actions sur les Apps

### Menu contextuel (clic droit)

Géré dans **`Icon.js`** :
1. Vérifie que l'utilisateur est admin (`isAdmin`)
2. Vérifie que l'app a un champ `id` valide
3. Appelle `/api/apps/{id}/{action}` (start/stop/restart)
4. Mise à jour optimiste du badge de statut

### Backend

Routes dans **`/Ryvie-Back/routes/apps.ts`** :
- `POST /api/apps/:id/start` - Démarre une app
- `POST /api/apps/:id/stop` - Arrête une app
- `POST /api/apps/:id/restart` - Redémarre une app

Services dans **`/Ryvie-Back/services/`** :
- `appManagerService.js` : Gestion via manifests (système principal)
- `dockerService.js` : Fallback si manifests indisponibles

## ⚠️ Fonctions DEPRECATED

### Anciennes fonctions conservées pour compatibilité :

- `generateAppConfig()` - Génération depuis icônes locales (DEPRECATED)
- `generateDefaultZones()` - Génération de zones fixes (DEPRECATED)
- `generateDefaultZonesFromManifests()` - Zones depuis manifests (DEPRECATED)

**Ces fonctions ne sont plus utilisées avec le nouveau système de grille.**
Le layout est désormais géré dynamiquement et sauvegardé sur le backend.

## 🐛 Correctifs récents

### Bug restart (21/10/2025)
**Problème** : Clic droit → Redémarrer ne faisait rien.

**Cause** : Les apps générées par `generateAppConfig()` n'avaient pas de champ `id`.

**Solution** : Ajout du champ `id` dans `generateAppConfig()` ligne 60 :
```javascript
id: appName.toLowerCase(), // ID basé sur le nom de l'app
```

## 📝 Migration depuis l'ancien système

### Ancien système (zones fixes)
- 12 zones prédéfinies (left, right, bottom1-10)
- Position fixe des apps
- Pas de drag & drop

### Nouveau système (grille dynamique)
- Grille responsive avec calcul automatique des colonnes
- Drag & drop complet (apps + météo)
- Persistance par utilisateur sur le backend
- Tailles fixes (120px) avec débordement automatique

## 🚀 Pour ajouter une nouvelle app

1. Créer un manifest dans `/data/config/manifests/{app-id}/manifest.json`
2. Ajouter une icône dans le même dossier (icon.svg, icon.png, etc.)
3. L'app apparaîtra automatiquement dans la grille
4. L'utilisateur peut la déplacer où il veut

Pas besoin de modifier le code frontend ! 🎉
