# Système de Widgets Ryvie

## Vue d'ensemble

Le système de widgets permet aux utilisateurs d'ajouter des widgets système (CPU/RAM, Stockage) directement dans la grille du launcher. Les widgets sont **scalables** et peuvent être facilement étendus.

## Architecture

### Composants

#### 1. **BaseWidget** (`src/components/widgets/BaseWidget.js`)
Composant de base pour tous les widgets. Fournit :
- Header avec icône et titre
- Bouton de suppression
- Container pour le contenu
- Styles de base

#### 2. **CpuRamWidget** (`src/components/widgets/CpuRamWidget.js`)
Widget affichant l'utilisation CPU et RAM en temps réel :
- Mise à jour toutes les 3 secondes
- Barres de progression colorées (vert/jaune/rouge)
- Affichage du pourcentage et de la RAM totale

#### 3. **StorageWidget** (`src/components/widgets/StorageWidget.js`)
Widget affichant l'utilisation du stockage :
- Mise à jour toutes les 10 secondes
- Affiche jusqu'à 3 disques
- Barres de progression avec espace utilisé/total

#### 4. **WidgetAddButton** (`src/components/WidgetAddButton.js`)
Bouton flottant en bas à droite permettant d'ajouter des widgets :
- Menu avec liste des widgets disponibles
- Design moderne avec animations
- Portal pour s'afficher au-dessus de tout

### Intégration dans la grille

Les widgets sont intégrés dans le système de grille existant :
- Taille : **2×2 slots** (252px × 252px)
- Draggables comme les apps et le widget météo
- Gestion automatique des collisions
- Persistance sur le backend

### Flux de données

```
Home.js (état widgets)
    ↓
GridLauncher (rendu + handlers)
    ↓
Widget components (affichage)
```

### Persistance

Les widgets sont sauvegardés dans le backend avec le launcher :
```json
{
  "launcher": {
    "layout": { ... },
    "anchors": { ... },
    "widgets": [
      { "id": "widget-cpu-ram-0", "type": "cpu-ram" },
      { "id": "widget-storage-1", "type": "storage" }
    ],
    "apps": [ ... ]
  }
}
```

## Ajouter un nouveau widget

### 1. Créer le composant widget

```javascript
// src/components/widgets/MonWidget.js
import React, { useState, useEffect } from 'react';
import BaseWidget from './BaseWidget';

const MonWidget = ({ id, onRemove, accessMode }) => {
  const [data, setData] = useState(null);

  useEffect(() => {
    // Charger les données
    const fetchData = async () => {
      // ... votre logique
    };
    
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [accessMode]);

  return (
    <BaseWidget id={id} title="Mon Widget" icon="🎯" onRemove={onRemove} w={2} h={2}>
      <div className="mon-widget-content">
        {/* Votre contenu */}
      </div>
    </BaseWidget>
  );
};

export default MonWidget;
```

### 2. Ajouter dans le menu de sélection

Modifier `src/components/WidgetAddButton.js` :

```javascript
const widgets = [
  { id: 'cpu-ram', name: 'CPU & RAM', icon: '💻', description: '...' },
  { id: 'storage', name: 'Stockage', icon: '💾', description: '...' },
  { id: 'mon-widget', name: 'Mon Widget', icon: '🎯', description: 'Description' } // ← Ajouter ici
];
```

### 3. Ajouter le rendu dans GridLauncher

Modifier `src/components/GridLauncher.js` :

```javascript
import MonWidget from './widgets/MonWidget'; // ← Import

// Dans la fonction renderWidget()
const renderWidget = () => {
  switch (widget.type) {
    case 'cpu-ram':
      return <CpuRamWidget ... />;
    case 'storage':
      return <StorageWidget ... />;
    case 'mon-widget': // ← Ajouter ici
      return <MonWidget id={widget.id} onRemove={onRemoveWidget} accessMode={accessMode} />;
    default:
      return null;
  }
};
```

### 4. Ajouter les styles (optionnel)

Ajouter vos styles spécifiques dans `src/styles/Widgets.css` :

```css
.mon-widget-content {
  /* Vos styles */
}
```

## API Backend requise

Les widgets utilisent l'endpoint `/api/server-info` (même que Settings.js) :

### Endpoint unique
```
GET /api/server-info
Response: {
  cpu: "12.8%" ou 12.8,
  ram: "45.2%" ou 45.2,
  ramTotal: 17179869184,
  stockage: {
    utilise: "450.5 GB",
    total: "1000.0 GB"
  }
}
```

Les widgets parsent automatiquement les formats string et number pour extraire les valeurs.

## Styles

Les widgets utilisent un design moderne avec :
- Fond blanc semi-transparent avec blur
- Bordures arrondies (20px)
- Ombres douces
- Animations d'apparition
- Hover effects

## Performance

- Mise à jour asynchrone des données
- Debounce sur les sauvegardes (300ms)
- Nettoyage des intervals au démontage
- Optimisation du drag & drop

## Accessibilité

- Curseur grab/grabbing pour le drag
- Boutons avec titres explicites
- Contraste suffisant pour les textes
- Animations respectueuses

## Notes

- Les widgets occupent toujours **2×2 slots**
- Maximum recommandé : 4-6 widgets simultanés
- Les données sont mises en cache côté backend
- Le système est conçu pour être facilement extensible
