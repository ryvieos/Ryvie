# Images Requises pour l'Onboarding

Ce document liste toutes les captures d'écran nécessaires pour le système d'onboarding de Ryvie.

## 📍 Emplacements des Images

Les images doivent être placées dans le dossier `/opt/Ryvie/Ryvie-Front/src/assets/onboarding/`

## 📸 Liste des Screenshots Requis

### 1. **Ryvie Desktop** (Page 3 - L'Écosystème Ryvie)
- **Nom du fichier**: `ryvie-desktop.png` ou `ryvie-desktop.jpg`
- **Dimensions recommandées**: 360x240px (ratio 3:2)
- **Contenu**: Capture d'écran de l'application Ryvie Desktop montrant l'interface de connexion sécurisée ou le dashboard principal
- **Description**: Doit montrer clairement comment Ryvie Desktop permet d'accéder à son cloud depuis n'importe où

### 2. **Ryvie Connect** (Page 3 - L'Écosystème Ryvie)
- **Nom du fichier**: `ryvie-connect.png` ou `ryvie-connect.jpg`
- **Dimensions recommandées**: 360x240px (ratio 3:2)
- **Contenu**: Capture d'écran de l'application Ryvie Connect dans l'App Store ou son interface principale
- **Description**: Doit illustrer les fonctionnalités de synchronisation et partage de données

### 3. **Airpicture** (Page 3 - L'Écosystème Ryvie)
- **Nom du fichier**: `airpicture.png` ou `airpicture.jpg`
- **Dimensions recommandées**: 360x240px (ratio 3:2)
- **Contenu**: Capture d'écran de l'application Airpicture montrant la sauvegarde automatique de photos
- **Description**: Doit montrer l'interface de sauvegarde automatique des photos et vidéos

### 4. **Menu Clic Droit** (Page 4 - Gérez Vos Applications)
- **Nom du fichier**: `right-click-menu.png` ou `right-click-menu.jpg`
- **Dimensions recommandées**: 640x480px (ratio 4:3)
- **Contenu**: Capture d'écran du menu contextuel qui apparaît lors d'un clic droit sur une application dans Ryvie
- **Description**: Doit montrer clairement les options:
  - Démarrer / Arrêter
  - Redémarrer
  - Désinstaller
  - Accéder aux paramètres
  - Toute autre option disponible

## 🔧 Intégration des Images

Une fois les images ajoutées dans le dossier `/opt/Ryvie/Ryvie-Front/src/assets/onboarding/`, vous devrez modifier le fichier `Onboarding.tsx` pour remplacer les placeholders par les vraies images.

### Exemple de modification pour Ryvie Desktop:

**Avant:**
```tsx
<div className="app-screenshot-placeholder">
  <div className="placeholder-icon">🖥️</div>
  <span className="placeholder-text">Screenshot Ryvie Desktop</span>
</div>
```

**Après:**
```tsx
<img 
  src={require('../assets/onboarding/ryvie-desktop.png')} 
  alt="Ryvie Desktop" 
  className="app-screenshot"
/>
```

### CSS à ajouter pour les vraies images:

```css
.app-screenshot {
  width: 180px;
  height: 120px;
  object-fit: cover;
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.demo-screenshot {
  width: 320px;
  height: 240px;
  object-fit: cover;
  border-radius: 16px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
```

## 📝 Notes Importantes

- Les images doivent être optimisées pour le web (compression sans perte de qualité)
- Format préféré: PNG pour les captures d'écran avec interface, JPG pour les photos
- Assurez-vous que les images sont claires et lisibles
- Les captures d'écran doivent montrer l'interface en français si possible
- Évitez les informations sensibles ou personnelles dans les captures

## 🎨 Style Visuel

- Les captures doivent avoir un aspect moderne et professionnel
- Privilégiez les interfaces claires avec un bon contraste
- Si possible, utilisez le thème clair de Ryvie pour la cohérence visuelle
- Les captures du menu clic droit doivent montrer le menu ouvert et bien visible
