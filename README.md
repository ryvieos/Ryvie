# Ryvie - v0.1.0

Plateforme tout-en-un (backend Node.js + frontend React/Electron) pour piloter un parc d'applications Ryvie. L'interface « launcher » reproduit une grille de type iOS avec météo, widgets et gestion dynamique des apps via manifests.

## Architecture
- **Backend** (`Back-end-view/`) : API Express, Socket.IO, authentification LDAP + JWT, persistance des préférences utilisateurs dans `/data/config/`.
- **Frontend** (`Ryvie-Front/`) : React 18 + Electron, grille responsive gérée par `GridLauncher`, consommation des manifests exposés par l'API.
- **Données** (`/data/`) :
  - `/data/apps/` : dossiers sources des apps (docker-compose, configs…)
  - `/data/config/manifests/` : manifests générés (icône + metadata)
  - `/data/config/user-preferences/` : préférences par utilisateur (`<username>.json`)
  - `/data/images/backgrounds/` : fonds personnalisés uploadés par les utilisateurs

## Prérequis
- Node.js 18+
- npm 9+
- Redis (optionnel) : utilisé pour l'allowlist JWT si activée

## Installation rapide
1. **Installer les dépendances**
   - Backend :
     ```bash
     cd Back-end-view
     npm install
     ```
   - Frontend :
     ```bash
     cd Ryvie-Front
     npm install
     ```
2. **Configurer les `.env`** : voir [Configuration backend](#configuration-backend).
3. **Préparer les données**
   - Monter `/data/apps/` avec vos apps Docker.
   - Lancer `node generate-manifests.js` (ou démarrer le backend) pour générer `/data/config/manifests/` et `Ryvie-Front/src/config/app-ports.json`. Les manifests orphelins sont supprimés automatiquement.
4. **Lancer les services**
   - Backend : `npm start` dans `Back-end-view/` (écoute par défaut sur `http://localhost:3002`).
   - Frontend : `npm start` dans `Ryvie-Front/` (dev-server + fenêtre Electron, accessible aussi via navigateur sur `http://localhost:3000`).

## Configuration backend
Fichier : `Back-end-view/.env`

```env
# Réseau API
PORT=3002

# LDAP
LDAP_URL=ldap://ldap.example.org:389
LDAP_BIND_DN=cn=admin,dc=example,dc=org
LDAP_BIND_PASSWORD=change_me
LDAP_BASE_DN=dc=example,dc=org

# JWT
JWT_SECRET=chainez-ici-une-cle-longue-aleatoire
JWT_EXPIRES_MINUTES=60

# Redis (facultatif)
REDIS_URL=redis://127.0.0.1:6379
```

**Notes**
- `JWT_SECRET` doit être fort et stocké hors dépôt.
- Ajustez `JWT_EXPIRES_MINUTES` selon votre politique de session.
- Si Redis n'est pas disponible, désactivez l'allowlist côté code ou fournissez une configuration valide.
- Le backend met à jour `Ryvie-Front/src/config/netbird-data.json` et synchronise les fonds d'écran depuis `/data/config/netbird/` et `/data/images/backgrounds/`.

## Configuration frontend
- Pas de `.env` obligatoire. Les URLs sont dérivées de `Ryvie-Front/src/config/urls.js` à partir de `netbird-data.json` et `app-ports.json`.
- Les flux réseau basculent entre mode public/privé selon `window.location` ou l'`accessMode` stocké.
- Préchargement des manifests et du launcher dans `Settings` pour éviter les flashs lors du retour sur `Home` (cache `localStorage`: `appsConfig_cache`, `launcher_<username>`).
- Thème : `darkMode` et `autoTheme` sont synchronisés avec le backend, stockés par utilisateur (`ryvie_dark_mode_<username>`).

## Gestion du launcher et des manifests
- **Manifests** : générés via `generate-manifests.js`. Chaque app possède un dossier `manifest.json` + icône dans `/data/config/manifests/<appId>/`.
- **Nettoyage automatique** : au démarrage, les manifests sans app correspondante dans `/data/apps/` sont supprimés (`fs.rmSync(...)`), garantissant que l'API n'expose que les apps présentes.
- **Preferences utilisateur** :
  - Stockées dans `/data/config/user-preferences/<username>.json`.
  - Contiennent `launcher.layout`, `launcher.anchors`, `launcher.widgets`, `launcher.apps`, `backgroundImage`, etc.
  - Sur chaque `GET /api/user/preferences`, le backend ajoute les apps manquantes (détectées dans les manifests) et retire celles qui n'existent plus.
  - Le frontend mêle la disposition sauvegardée et les apps nouvellement détectées pour afficher automatiquement les nouveautés.

## Commandes de développement
- **Backend** :
  - `npm start` : démarrage production (avec génération des manifests, synchronisation fonds/netbird).
  - `npm run dev` (si défini) : mode développement avec rechargement.
- **Frontend** :
  - `npm start` : lance le dev-server React + Electron.
  - `npm run build` : build production React.
- **Générateur de manifests** : `node generate-manifests.js` (peut être lancé à chaud après ajout/suppression d'une app).

## Dépannage
- **Manifests manquants** : relancer `node generate-manifests.js` ou redémarrer le backend. Vérifier que le dossier existe dans `/data/apps/` avec un `docker-compose.yml` valide.
- **App fantôme** : supprimer le dossier dans `/data/apps/`, relancer le générateur. Le manifest est maintenant supprimé automatiquement, puis le backend nettoie les préférences.
- **Connexion impossible** : vérifier la configuration LDAP et `JWT_SECRET`. Les logs du backend (`Back-end-view/index.js`) détaillent les erreurs de bind LDAP ou JWT.
- **Socket / statut apps** : le socket partagé est géré via `Ryvie-Front/src/contexts/SocketContext.js`. Si vous observez des déconnexions, assurez-vous que le backend est accessible en WebSocket (`/socket.io`).
- **Grille qui ne s'affiche pas** : vérifier que `appsConfig` contient vos apps (`localStorage.appsConfig_cache`). Un `Ctrl+F5` force un rechargement complet.

## Sécurité
- Stockez les secrets (`JWT_SECRET`, credentials LDAP, Redis) hors dépôt et utilisez des gestionnaires de secrets.
- Activez le HTTPS en production (Netbird fournit les domaines publics). Les icônes sont servies via `GET /api/apps/:id/icon` avec cache 24h.
- Pensez à limiter les tentatives de login et surveiller les journaux d'authentification.

## Structure du dépôt
- `Back-end-view/` : API Node.js, routes (dont `routes/userPreferences.js`, `routes/apps.js`), services Docker/Socket, synchronisation netbird/fonds.
- `Ryvie-Front/` : application React/Electron (pages `Home.js`, `Settings.js`, composants `GridLauncher.js`, widgets…).
- `generate-manifests.js` : outil CLI pour générer et nettoyer les manifests.
- `data/` (externe au dépôt git) : monté en volume sur la machine de prod (apps, manifests, préférences, backgrounds, netbird).

## Aller plus loin
- Documentation interne : `Ryvie-Front/ARCHITECTURE.md`, `Ryvie-Front/WIDGETS.md` détaillent la grille et le système de widgets.
- Pour ajouter une nouvelle app : déposer le dossier dans `/data/apps/`, lancer `node generate-manifests.js`, redémarrer le backend si nécessaire. L'app apparaîtra automatiquement sur le launcher.

Bon développement !
