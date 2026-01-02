<p align="center">
   <img src="Ryvie-Front/src/icons/ryvielogo0.png" alt="Ryvie" width="180" />
 </p>
<img width="860" height="526" alt="Capture d’écran 2026-01-02 114848" src="https://github.com/user-attachments/assets/8dae1979-8291-4c29-a459-89aee3315a28" />

# Ryvie
 
 Ryvie est un **OS + une plateforme** qui transforme une machine (mini‑PC, serveur, etc.) en **cloud personnel** simple à utiliser.
 
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

  <img width="5320" height="4243" alt="isoflow-export-2026-01-02T17_59_01 900Z" src="https://github.com/user-attachments/assets/74701ede-9edd-433c-8e9b-c3009b09fff1" />
  
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

## Contributing

Les contributions sont les bienvenues.

- **Issues**: ouvre une issue avec un maximum de détails (contexte, étapes pour reproduire, logs, captures).
- **Pull requests**:
  - crée une branche dédiée
  - explique clairement le problème et la solution
  - évite les changements non liés (un sujet par PR)

## Disclaimer

Ce projet est fourni **"tel quel"**, sans garantie d'aucune sorte.

L'équipe Ryvie ne pourra pas être tenue responsable des dommages, pertes de données, indisponibilités ou autres problèmes résultant de l'utilisation (ou de l'impossibilité d'utiliser) Ryvie.

## Authors

* **Jules Maisonnave** - *Initial work & Lead Development* - [GitHub](https://github.com/votre-username-si-besoin)
