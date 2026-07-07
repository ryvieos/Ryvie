# Migration Ryvie : Electron vers Web

## 🎯 Objectif
Migration de l'application Ryvie d'une application Electron pure vers une application hybride supportant à la fois le web et Electron.

## ✅ Fonctionnalités migrées

### 1. Détection automatique du mode d'accès
- **Fichier**: `src/utils/detectAccessMode.js`
- **Fonctionnalité**: Détection automatique privé/public avec fallback
- **Test**: Ping vers `/api/server-info` avec timeout de 2s
- **Fallback**: Bascule automatique vers public si privé inaccessible

### 2. Gestion des plateformes
- **Fichier**: `src/utils/platformUtils.js`
- **Fonctionnalité**: Détection Electron vs Web avec utilitaires
- **Composants**: WindowManager, StorageManager, NotificationManager

### 3. Gestion des sessions
- **Fichier**: `src/utils/sessionManager.js`
- **Fonctionnalité**: Sessions unifiées avec JWT et cookies
- **Persistance**: localStorage + cookies pour le web, sessions Electron

### 4. Composants adaptés
- **Home.js**: Socket.io avec fallback automatique privé→public
- **connexion.js**: Authentification avec détection de mode automatique
- **index.js**: Routage adapté selon la plateforme

## 🚀 Scripts disponibles

```bash
# Démarrer en mode hybride (web + Electron)
npm start

# Démarrer uniquement le serveur web
npm run web

# Build pour production web
npm run build:web

# Build Electron
npm run dist
```

## 🔧 Configuration requise côté serveur

### CORS
Le serveur doit autoriser les requêtes CORS pour le domaine web :
```javascript
app.use(cors({
  origin: ['http://localhost:3000', 'https://votre-domaine.com'],
  credentials: true
}));
```

### Endpoints requis
- `/api/server-info` - Pour la détection de connectivité
- `/api/users` - Pour la liste des utilisateurs
- `/api/authenticate` - Pour l'authentification JWT

### HTTPS (recommandé)
Pour éviter les problèmes de mixed content, activer HTTPS sur :
- Le serveur local (`https://ryvie.local:3002`)
- L'application web remote

## 🌐 Fonctionnement Web vs Electron

### Mode Web
- Détection automatique privé/public au démarrage
- Gestion des sessions via JWT + cookies
- Ouverture d'applications dans de nouveaux onglets
- Fallback automatique si serveur local indisponible

### Mode Electron
- Utilise le mode d'accès stocké
- Gestion des sessions via partitions Electron
- Ouverture d'applications dans de nouvelles fenêtres
- Communication IPC maintenue

## 📱 Interface utilisateur

### Indicateurs visuels
- Badge de mode (Local/Public) dans la page de connexion
- Badge "Web" affiché uniquement en mode navigateur
- Statut de connexion avec mode et plateforme dans Home

### Expérience utilisateur
- Chargement avec indication du mode de détection
- Messages d'erreur adaptés selon la plateforme
- Transitions fluides entre les modes

## 🔍 Débogage

### Logs importants
- `[AccessMode]` - Détection du mode d'accès
- `[Connexion]` - Authentification et chargement des utilisateurs
- `[Home]` - Connexion Socket.io et fallback
- `[SessionManager]` - Gestion des sessions

### Tests de connectivité
```javascript
import { testServerConnectivity } from './utils/detectAccessMode';

// Tester la connectivité privée
const isPrivateOk = await testServerConnectivity('private');

// Tester la connectivité remote  
const isPublicOk = await testServerConnectivity('public');
```

## 🚨 Points d'attention

1. **Mixed Content**: Si l'app web est en HTTPS, le serveur local doit aussi être en HTTPS
2. **CORS**: Bien configurer les origines autorisées côté serveur
3. **Cookies**: Les cookies de session ne fonctionnent qu'en web
4. **Fallback**: Le fallback privé→public ne fonctionne qu'en mode web

## 📋 Prochaines étapes

- [ ] Tester la compatibilité complète des deux modes
- [ ] Optimiser les performances de détection
- [ ] Ajouter des tests unitaires
- [ ] Documenter l'API serveur requise
