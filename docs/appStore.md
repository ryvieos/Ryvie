# Documentation App Store

## Vue d'ensemble

Le système App Store de Ryvie permet de gérer un catalogue d'applications disponibles pour installation. Il synchronise automatiquement le catalogue depuis un dépôt GitHub et maintient une copie locale pour un accès rapide.

## Architecture

### Services impliqués

1. **[appStoreService.js](cci:7://file:///opt/Ryvie/Back-end-view/services/appStoreService.js:0:0-0:0)** - Service principal de gestion du catalogue
2. **[updateService.js](cci:7://file:///opt/Ryvie/Back-end-view/services/updateService.js:0:0-0:0)** - Gestion des mises à jour du catalogue
3. **[updateCheckService.js](cci:7://file:///opt/Ryvie/Back-end-view/services/updateCheckService.js:0:0-0:0)** - Vérification de nouvelles versions disponibles

### Flux de données
GitHub Release (ryvie-apps) 
	↓ ↓ 
(getLatestRelease) 
	↓ 
Vérification version 
	↓ ↓ 
(checkStoreCatalogUpdate) 
	↓ 
Téléchargement apps.json 
	↓ ↓ 
(fetchAppsFromRelease) 
	↓ 
Stockage local (/data/config/appStore) 
├── apps.json (liste des applications) 
└── metadata.json (version et timestamp)


## Configuration

### Variables d'environnement

```bash
# Dépôt GitHub contenant le catalogue (optionnel)
GITHUB_REPO=Loghin01/ryvie-apps

# Token GitHub pour accès privé (optionnel)
GITHUB_TOKEN=(pas pour l'instant)
Chemins de fichiers
Définis dans 
config/paths.js
 :

STORE_CATALOG : /data/config/appStore - Répertoire de stockage du catalogue
APPS_FILE : /data/config/appStore/apps.json - Liste des applications
METADATA_FILE : /data/config/appStore/metadata.json - Métadonnées de version
Fonctionnement détaillé
1. Initialisation (initialize())
Appelée au démarrage du serveur dans index.js :

javascript:
	const { initialize: initAppStore } = require('./services/appStoreService');
	await initAppStore();

Étapes :
Charge les métadonnées locales depuis metadata.json
Affiche la version actuelle du catalogue (si disponible)
Appelle updateStoreCatalog() pour vérifier et télécharger les mises à jour
Affiche le nombre d'applications disponibles

Logs typiques :
[appStore] Initialisation du service...
 [appStore] GitHub Repo: Loghin01/ryvie-apps
[appStore] Répertoire de données: /data/config/appStore
[appStore] Release actuelle: v1.0.4
[appStore] ✅ Catalogue déjà à jour avec 2 apps
2. Vérification de mise à jour (checkStoreCatalogUpdate())
Compare la version locale avec la dernière release GitHub.

Retourne :

javascript:
	{
	  name: 'App Store Catalog',
	  repo: 'Loghin01/ryvie-apps',
	  currentVersion: 'v1.0.4',      // null si aucune version locale
	  latestVersion: 'v1.0.5',
	  updateAvailable: true,          // true si currentVersion ≠ latestVersion
	  status: 'update-available'      // 'up-to-date' | 'update-available' | 'error'
	}

3. Mise à jour du catalogue (updateStoreCatalog())
Télécharge et installe la dernière version du catalogue.

Processus :

Vérifie si une mise à jour est disponible via checkStoreCatalogUpdate()
Si déjà à jour → retourne immédiatement
Sinon :
Récupère les informations de la dernière release GitHub
Télécharge le fichier apps.json depuis les assets de la release
Sauvegarde apps.json localement
Met à jour metadata.json avec le nouveau tag et timestamp
Retourne :

javascript:
	{
	  success: true,
	  message: 'Catalogue mis à jour vers v1.0.5',
	  version: 'v1.0.5',
	  appsCount: 3,
	  updated: true  // false si déjà à jour
	}

4. Récupération des applications
Toutes les applications
javascript:
	const { getApps } = require('./services/appStoreService');
	const apps = await getApps();
	// Retourne : Array<App> | null
	
Application par ID
javascript:
	const { getAppById } = require('./services/appStoreService');
	const app = await getAppById('nextcloud');
	// Retourne : App | null

5. Santé du service (getStoreHealth())
Retourne l'état actuel du service :

javascript:
	{
	  status: 'ok',
	  timestamp: '2025-11-04T14:30:00.000Z',
	  githubRepo: 'Loghin01/ryvie-apps',
	  storage: {
	    type: 'file',
	    hasData: true,
	    dataFile: '/data/config/appStore/apps.json',
	    releaseTag: 'v1.0.4',
	    lastCheck: '2025-11-04T14:25:00.000Z',
	    timeSinceLastCheck: 5  // minutes
	  }
	}

6. Effacement du cache (clearCache())
Supprime les fichiers locaux et réinitialise les métadonnées en mémoire.

javascript:
	const { clearCache } = require('./services/appStoreService');
	await clearCache();

Structure des données

apps.json
json:
	[
	  {
	    "id": "nextcloud",
	    "name": "Nextcloud",
	    "description": "Plateforme de stockage et collaboration",
	    "version": "28.0",
	    "icon": "https://...",
	    "category": "productivity",
	    "repository": "https://github.com/user/nextcloud-ryvie"
	  },
	  {
	    "id": "jellyfin",
	    "name": "Jellyfin",
	    "description": "Serveur multimédia",
	    "version": "10.8",
	    "icon": "https://...",
	    "category": "media",
	    "repository": "https://github.com/user/jellyfin-ryvie"
	  }
	]

metadata.json
json:
	{
	  "releaseTag": "v1.0.4",
	  "lastCheck": 1730729400000
	}

Gestion des erreurs
Erreurs réseau
Si GitHub est inaccessible :

L'initialisation continue avec le cache local (si disponible)
Les logs affichent un avertissement
Le service reste fonctionnel en mode dégradé
Absence de cache local
Si aucun fichier local n'existe :

getApps() retourne null
L'initialisation tente de télécharger le catalogue
Si échec → service non disponible jusqu'à la prochaine tentative
Asset manquant
Si apps.json n'est pas dans les assets de la release :

Erreur : apps.json non trouvé dans les assets de la release
La mise à jour échoue
Le cache local reste inchangé
Tests manuels
Test d'initialisation
bash
cd /opt/Ryvie/Back-end-view
node -e "require('./services/appStoreService').initialize().then(()=>process.exit(0)).catch(err=>{console.error(err);process.exit(1);});"
Test de mise à jour forcée
bash
# 1. Effacer le cache
rm -f /data/config/appStore/{apps.json,metadata.json}

# 2. Relancer l'initialisation
node -e "require('./services/appStoreService').initialize().then(()=>process.exit(0)).catch(err=>{console.error(err);process.exit(1);});"
Vérification des fichiers
bash
# Métadonnées
cat /data/config/appStore/metadata.json

# Liste des apps
cat /data/config/appStore/apps.json | jq '.[] | {id, name, version}'
Dépannage
Les métadonnées restent à null
Cause : Référence d'objet perdue lors du rechargement

Solution : Utiliser Object.assign(metadata, loadedMetadata) au lieu de metadata = loadedMetadata

Erreur 403 GitHub API
Cause : Rate limit dépassé (60 requêtes/heure sans token)

Solution : Configurer GITHUB_TOKEN dans .env

Catalogue non mis à jour
Vérifications :

Vérifier la connectivité GitHub
Vérifier les permissions d'écriture sur /data/config/appStore
Consulter les logs pour identifier l'erreur
Vérifier que la release contient bien apps.json dans ses assets
Intégration avec le reste de Ryvie
Le service App Store est intégré dans le serveur principal (index.js) :

javascript:
	// Initialisation au démarrage
	const { initialize: initAppStore } = require('./services/appStoreService');
	await initAppStore();

Les routes API (à définir dans routes/) peuvent ensuite utiliser :

javascript:
	const { getApps, getAppById } = require('../services/appStoreService');

	// GET /api/store/apps
	router.get('/apps', async (req, res) => {
	  const apps = await getApps();
	  res.json(apps || []);
	});
	
	// GET /api/store/apps/:id
	router.get('/apps/:id', async (req, res) => {
	  const app = await getAppById(req.params.id);
	  if (!app) return res.status(404).json({ error: 'App not found' });
	  res.json(app);
	});
