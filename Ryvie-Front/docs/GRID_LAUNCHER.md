# Grid Launcher - Documentation

Système de grille type iOS pour Ryvie avec drag & drop, gestion des collisions et persistance.

## ✨ Fonctionnalités

- ✅ **Grille responsive** : 12 cols (desktop), 8 (tablette), 4 (mobile)
- ✅ **Drag & drop fluide** : Souris + tactile avec Pointer Events
- ✅ **Collisions gérées** : Refuse les placements invalides avec animation shake
- ✅ **Persistance** : Sauvegarde automatique dans localStorage
- ✅ **Animations** : Fade + scale à l'arrivée, stagger entre tuiles
- ✅ **Widget météo 2×2** : Déplaçable comme une app
- ✅ **Accessibilité** : Focus visible, navigation clavier possible
- ✅ **Performance** : 60fps garanti, debounce localStorage

## 🏗️ Architecture

### Fichiers créés

```
/src
  /hooks
    useGridLayout.js  # Gestion layout + collisions + persistance
    useDrag.js        # Gestion drag & drop Pointer Events
  /components
    GridLauncher.js   # Composant principal
  /styles
    GridLauncher.css  # Styles responsive + animations
```

### Hooks

**`useGridLayout(items, cols)`**
```javascript
const { layout, moveItem, isPositionValid, pixelToGrid } = useGridLayout(items, 12);
```
- `layout`: Object `{itemId: {col, row, w, h}}`
- `moveItem(id, col, row, w, h)`: Déplace un item avec validation
- `isPositionValid(id, col, row, w, h)`: Vérifie si position valide
- `pixelToGrid(x, y, slotSize, gap)`: Convertit pixels → grille

**`useDrag(onDragEnd)`**
```javascript
const { isDragging, dragPosition, handlers } = useDrag(handleDragEnd);
```
- `isDragging`: Boolean état drag
- `dragPosition`: `{x, y}` position du ghost
- `handlers`: `{onPointerDown, onPointerMove, onPointerUp}`

## 📐 Responsive

| Breakpoint | Colonnes | Taille slot | Gap |
|-----------|----------|-------------|-----|
| ≥1280px   | 12       | 120px       | 12px|
| 769-1279px| 8        | 96px        | 10px|
| ≤768px    | 4        | 84px        | 8px |

## 🎨 Personnalisation

### Variables CSS

```css
:root {
  --grid-cols: 12;
  --slot-size: 120px;
  --slot-gap: 12px;
  --slot-radius: 16px;
  --tile-radius: 24px;
  --slot-bg: rgba(255, 255, 255, 0.08);
}
```

### Modifier les animations

```css
@keyframes tileAppear {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
```

Ajuster le stagger dans `.grid-tile:nth-child(n)`.

## 🔧 Utilisation

### 1. Importer le composant

```javascript
import GridLauncher from '../components/GridLauncher';
```

### 2. Utiliser dans le JSX

```javascript
<GridLauncher
  apps={['app1', 'app2', 'app3']}
  weather={weatherData}
  weatherImages={weatherImages}
  weatherIcons={weatherIcons}
  iconImages={iconImages}
  appsConfig={appsConfig}
  handleClick={handleClick}
  // ... autres props
/>
```

### 3. Format des données

**Apps** : Array de string (IDs)
```javascript
['nextcloud', 'jellyfin', 'photoprism']
```

**Weather** : Object
```javascript
{
  location: 'Lille',
  temperature: 14,
  humidity: 94,
  wind: 23,
  icon: 'cloudy.png'
}
```

## 💾 Persistance

### Format localStorage

```json
{
  "weather": { "col": 0, "row": 0, "w": 2, "h": 2 },
  "nextcloud": { "col": 2, "row": 0, "w": 1, "h": 1 },
  "jellyfin": { "col": 3, "row": 0, "w": 1, "h": 1 }
}
```

### Réinitialiser le layout

```javascript
localStorage.removeItem('ryvie_grid_layout');
// Puis recharger la page
```

## 🎯 Comportements

### Drag & Drop

1. **Clic/Touch down** : Démarre le drag, crée le ghost
2. **Move** : Ghost suit le pointeur
3. **Release** : Snap sur la grille, validation collisions
4. **Succès** : Item se place à la nouvelle position
5. **Échec** : Animation shake, retour position initiale

### Gestion des collisions

- Vérifie overlap des rectangles avant placement
- Si collision : refuse le drop
- Trouve automatiquement position libre pour nouveaux items
- Algo : itère row par row, col par col jusqu'à trouver espace libre

### Widget météo 2×2

- Occupe 4 cases (2 colonnes × 2 lignes)
- Snap en unités 2×2
- Réserve l'espace pendant le drag
- Même logique de collision que les apps 1×1

## 🐛 Débogage

### Vérifier le layout

```javascript
console.log(localStorage.getItem('ryvie_grid_layout'));
```

### Forcer recalcul positions

Supprimer l'item du localStorage puis recharger :
```javascript
const layout = JSON.parse(localStorage.getItem('ryvie_grid_layout'));
delete layout['item-id'];
localStorage.setItem('ryvie_grid_layout', JSON.stringify(layout));
```

### Performance

Si lag pendant le drag :
- Vérifier que `pointer-events: none` est sur les slots
- Vérifier que le ghost utilise `position: fixed`
- Désactiver temporairement backdrop-filter si GPU faible

## 📱 Support tactile

Le système utilise **Pointer Events** qui unifient souris et tactile :

- `pointerdown` : Début drag (souris clic ou touch)
- `pointermove` : Déplacement
- `pointerup` : Fin drag
- `setPointerCapture` : Capture les events même hors élément

Fonctionne sur :
- Desktop (souris)
- Tablette (touch)
- Mobile (touch)
- Stylet

## ♿ Accessibilité

- **Focus visible** : Outline bleu sur focus clavier
- **Tab navigation** : Toutes les tuiles sont focusables
- **ARIA** : Ajouter `aria-label` si besoin pour lecteurs d'écran
- **Keyboard drag** (TODO) : Flèches pour déplacer, Entrée pour saisir/poser

## 🚀 Améliorations futures

- [ ] Navigation clavier complète
- [ ] Animation de réorganisation automatique
- [ ] Multi-sélection pour déplacer plusieurs items
- [ ] Zones droppables spéciales (dossiers, groupes)
- [ ] Tailles variables (1×2, 2×1, 3×3)
- [ ] Export/import layout
- [ ] Undo/redo
