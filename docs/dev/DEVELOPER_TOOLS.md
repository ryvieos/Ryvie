# Outils de développement - Ryvie

Ce document centralise tous les outils et intégrations disponibles pour faciliter le développement de Ryvie.

## 🤖 Intégrations IA

### Caveman - Optimisation Claude Code

**Caveman** optimise les interactions avec Claude Code en réduisant l'utilisation des tokens tout en conservant la précision technique.

- **Documentation** : [CAVEMAN_INTEGRATION.md](CAVEMAN_INTEGRATION.md)
- **Source** : https://github.com/juliusbrussee/caveman
- **Installation** : Déjà installé globalement pour l'utilisateur `ryvie`
- **Activation** : Automatique à chaque session Claude Code

#### Métriques

```
┌─────────────────────────────────────┐
│  TOKENS ÉCONOMISÉS     ████████ 75% │
│  PRÉCISION TECHNIQUE   ████████ 100%│
│  VITESSE AUGMENTÉE     ████████ ~3x │
└─────────────────────────────────────┘
```

#### Commandes principales

| Commande | Description |
|----------|-------------|
| `/caveman` | Active le mode caveman |
| `/caveman lite` | Mode léger (garde la grammaire) |
| `/caveman full` | Mode complet (par défaut) |
| `/caveman ultra` | Compression maximale |
| `/caveman-commit` | Génère des messages de commit concis |
| `/caveman-review` | Revue de code en une ligne |
| `/caveman:compress <file>` | Compresse les fichiers de mémoire |

#### Utilisation avec Ryvie

```bash
# Messages de commit pour Ryvie
/caveman-commit

# Revue de code
/caveman-review

# Compression de la documentation
/caveman:compress /opt/Ryvie/docs/ARCHITECTURE_DOCKER_RYVIE.md
```

## 📝 Documentation du projet

### Documents d'architecture

| Document | Description |
|----------|-------------|
| [ARCHITECTURE_DOCKER_RYVIE.md](ARCHITECTURE_DOCKER_RYVIE.md) | Architecture Docker complète |
| [ARCHITECTURE_DOCKER_RYVIE_RESUME.md](ARCHITECTURE_DOCKER_RYVIE_RESUME.md) | Résumé de l'architecture |
| [ARCHITECTURE_DOCKER_RYVIE_CHANGES.md](ARCHITECTURE_DOCKER_RYVIE_CHANGES.md) | Changements à apporter |

### Documents de migration

| Document | Description |
|----------|-------------|
| [STORAGE_MIGRATION_STRATEGY.md](STORAGE_MIGRATION_STRATEGY.md) | Stratégie de migration du stockage |
| [RAID_MIGRATION_CHECKLIST.md](RAID_MIGRATION_CHECKLIST.md) | Checklist pour la migration RAID |
| [BTRFS_DEGRADED_MODE.md](BTRFS_DEGRADED_MODE.md) | Mode dégradé BTRFS |

### Autres documents importants

| Document | Description |
|----------|-------------|
| [API_RYVIE_DOMAINS.md](API_RYVIE_DOMAINS.md) | Documentation des domaines API |
| [appStore.md](appStore.md) | Documentation de l'App Store |
| [UPDATE_SYSTEM.md](UPDATE_SYSTEM.md) | Système de mise à jour |
| [KEYCLOAK_SSO_MIGRATION.md](KEYCLOAK_SSO_MIGRATION.md) | Migration Keycloak SSO |
| [CLA_SYSTEM_OVERVIEW.md](CLA_SYSTEM_OVERVIEW.md) | Vue d'ensemble du système CLA |

## 🛠️ Scripts de développement

### Scripts principaux

```bash
# Développement
/opt/Ryvie/scripts/dev.sh         # Lance Ryvie en mode développement
/opt/Ryvie/scripts/prod.sh        # Lance Ryvie en mode production

# Mise à jour
/opt/Ryvie/scripts/update-and-restart.sh  # Met à jour et redémarre
```

### Structure des scripts

```
/opt/Ryvie/scripts/
├── dev.sh                    # Mode développement
├── prod.sh                   # Mode production
└── update-and-restart.sh     # Update et redémarrage
```

## 🐳 Docker & Conteneurs

### Gestion des stacks Docker

Les stacks Docker sont gérées via des compose files et des manifests :

```
/data/apps/              # Applications Docker
/data/config/            # Configurations
/data/manifests/         # Manifests d'applications
```

### Commandes Docker utiles

```bash
# Lister les conteneurs
docker ps -a

# Lister les réseaux
docker network ls

# Inspecter un réseau
docker network inspect ryvie-network

# Logs d'un conteneur
docker logs <container-name>

# Redémarrer une stack
docker compose -f /data/apps/<app>/docker-compose.yml up -d
```

## 🔧 Outils PM2

### Gestion des processus

```bash
# Lister les processus
pm2 list

# Logs
pm2 logs

# Redémarrer
pm2 restart all

# Recharger la config
pm2 reload ecosystem.config.js
```

### Configuration PM2

Le fichier de configuration principal est `/opt/Ryvie/ecosystem.config.js`.

## 📊 Monitoring et debugging

### Logs système

```bash
# Logs du système
journalctl -f

# Logs Docker
docker logs -f <container>

# Logs PM2
pm2 logs
```

### Vérifications de santé

```bash
# Vérifier le montage /data
findmnt /data
lsblk -f

# Vérifier les réseaux Docker
docker network ls
docker network inspect ryvie-network

# Vérifier l'état RAID
cat /proc/mdstat
mdadm --detail /dev/md0
```

## 🔐 Sécurité

### Bonnes pratiques

1. **Ne jamais commiter de secrets** dans le dépôt Git
2. **Utiliser des variables d'environnement** pour les informations sensibles
3. **Vérifier les permissions** des fichiers de configuration
4. **Auditer régulièrement** les dépendances npm

### Fichiers sensibles à exclure

```
.env
.env.local
credentials.json
*.key
*.pem
```

## 🧪 Tests et qualité

### Linting et formatage

```bash
# Frontend
cd /opt/Ryvie/Ryvie-Front
npm run lint

# Backend
cd /opt/Ryvie/Ryvie-Back
npm run lint
```

## 📦 Gestion des dépendances

### NPM

```bash
# Installer les dépendances
npm install

# Mettre à jour
npm update

# Audit de sécurité
npm audit
npm audit fix
```

### Vérification des versions

```bash
# Node.js
node --version

# NPM
npm --version

# Docker
docker --version

# Docker Compose
docker compose version
```

## 🚀 Workflow de développement recommandé

### 1. Configuration initiale

```bash
# Cloner le dépôt
git clone <repo-url> /opt/Ryvie
cd /opt/Ryvie

# Installer les dépendances
cd Ryvie-Back && npm install
cd ../Ryvie-Front && npm install
```

### 2. Développement quotidien

```bash
# Lancer en mode dev
/opt/Ryvie/scripts/dev.sh

# Utiliser Caveman pour les interactions IA
# (automatique avec Claude Code)

# Commiter avec des messages concis
/caveman-commit
```

### 3. Avant de commiter

```bash
# Vérifier le statut Git
git status

# Vérifier les changements
git diff

# Linter le code
npm run lint

# Commiter
git add .
git commit -m "..."  # ou utiliser /caveman-commit
```

### 4. Déploiement

```bash
# Basculer en mode production
/opt/Ryvie/scripts/prod.sh

# Vérifier l'état
pm2 list
docker ps
```

## 📚 Ressources supplémentaires

### Liens utiles

- **Dépôt principal** : https://github.com/[votre-org]/Ryvie
- **Documentation Caveman** : https://github.com/juliusbrussee/caveman
- **Documentation Docker** : https://docs.docker.com
- **Documentation PM2** : https://pm2.keymetrics.io
- **Documentation React** : https://react.dev
- **Documentation Express** : https://expressjs.com

### Communauté

- Signaler un bug : [GitHub Issues](https://github.com/[votre-org]/Ryvie/issues)
- Contribuer : Voir [CONTRIBUTING.md](../CONTRIBUTING.md)
- CLA : Voir [CLA.md](../CLA.md)

---

**Dernière mise à jour** : 2026-04-29
**Maintenu par** : L'équipe Ryvie
