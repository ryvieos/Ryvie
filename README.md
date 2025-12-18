# Ryvie
 
 Ryvie est un **OS + une plateforme** qui transforme une machine (mini‑PC, serveur, etc.) en **cloud personnel** simple à piloter.
 
 L'objectif: avoir une page d'accueil type “launcher” (style iOS) pour lancer et administrer tes services (apps Docker), avec:
 
 - **Un launcher en grille** (apps + widgets)
 - **Une gestion centralisée** des apps (manifests, icônes, ports)
 - **Des préférences utilisateur** (layout, fond d’écran, thème, etc.)
 - **Une connexion P2P intégrée** pour l'accès à distance
 - **Un accès local ou distant** selon le mode (public/privé)
 
 ## Fonctionnalités
 - **Launcher**: grille responsive, drag & drop, widgets (météo, CPU/RAM, stockage…)
 - **Connexion P2P intégrée**: accès distant sans configuration réseau complexe
 - **Catalogue d’apps**: les apps présentes sont détectées via des manifests générés
 - **Sauvegarde des préférences** par utilisateur côté backend
 - **Backend temps réel** (Socket.IO) pour état/rafraîchissements
 
 ## Installation (utilisateur final)
 
 1. **Télécharger et installer l’OS Ryvie**
    - Télécharge l’image/installeur fourni pour Ryvie.
    - Installe l’OS sur la machine qui hébergera ton cloud personnel.
 
 2. **Télécharger le client Ryvie**
    - Va sur `https://ryvie.fr`
    - Télécharge le **client Ryvie** (selon ton système)
    - Connecte-toi à ton instance Ryvie
 
 3. **Accéder à l’interface**
    - Une fois connecté, tu arrives sur le launcher et tu peux:
      - Lancer tes apps
      - Organiser la grille
      - Ajouter/supprimer des widgets
      - Changer le fond d’écran et les préférences
 
 ## Développement / contributions
 
 ### Architecture (repo)
 - **Backend** (`Ryvie-Back/`) : API Express, Socket.IO, authentification LDAP + JWT, persistance des préférences utilisateurs dans `/data/config/`.
 - **Frontend** (`Ryvie-Front/`) : React 18 + Electron, grille responsive gérée par `GridLauncher`, consommation des manifests exposés par l'API.
 - **Données** (`/data/`) :
   - `/data/apps/` : dossiers sources des apps (docker-compose, configs…)
   - `/data/config/manifests/` : manifests générés (icône + metadata)
   - `/data/config/user-preferences/` : préférences par utilisateur (`<username>.json`)
   - `/data/images/backgrounds/` : fonds personnalisés uploadés par les utilisateurs
 
 ### Prérequis
 - CPU: **4 cœurs minimum**
 - RAM: **8 Go minimum** (**16 Go recommandé**)
 - Stockage: **50 Go minimum**
