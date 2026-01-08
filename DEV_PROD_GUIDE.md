# Guide Dev/Prod - Ryvie
#V2
## 🎯 Vue d'ensemble

Ryvie dispose maintenant de deux modes de fonctionnement distincts :

| Mode | Backend | Frontend | CPU | RAM | Usage |
|------|---------|----------|-----|-----|-------|
| **Dev** | nodemon + ts-node | webpack-dev-server | ~30% | ~2GB | Développement actif |
| **Prod** | Node.js compilé | serve (statique) | ~5% | ~300MB | Utilisation normale |

---

## 🚀 Commandes Rapides

### Mise à jour Ryvie (via interface web)
- Cliquer sur "Mettre à jour" dans les paramètres
- Télécharge automatiquement la dernière release GitHub
- Sauvegarde automatique (snapshot btrfs)
- Préservation des permissions
- Installation des dépendances
- Build et déploiement en production
- Rollback automatique en cas d'erreur

### Démarrer en mode DEV
```bash
/opt/Ryvie/scripts/dev.sh
```
- Build initial du backend
- Lance `tsc --watch` + `nodemon` (backend)
- Lance `webpack-dev-server` (frontend)
- Hot-reload automatique sur modification

### Démarrer en mode PROD
```bash
/opt/Ryvie/scripts/prod.sh
```
- Build backend (TypeScript → JavaScript)
- Build frontend (webpack production avec `NODE_ENV=production`)
- Lance Node.js (backend)
- Lance `serve` (frontend statique)
- Sauvegarde la config PM2

### Rebuilder en PROD (après modification)
```bash
/opt/Ryvie/scripts/rebuild-prod.sh
```
- Rebuild backend + frontend
- Redémarre les processus prod
- Plus rapide que `prod.sh` (ne supprime pas les processus)

### Basculer entre les modes
```bash
/opt/Ryvie/scripts/switch-mode.sh dev   # Passer en dev
/opt/Ryvie/scripts/switch-mode.sh prod  # Passer en prod
```

### Arrêter tout
```bash
pm2 stop all
```

---

## 📋 Mode DÉVELOPPEMENT

### Caractéristiques
- ✅ **Hot-reload automatique** (backend + frontend)
- ✅ **Sourcemaps** pour le debugging
- ✅ **Logs détaillés**
- ✅ **Pas besoin de rebuild manuel**
- ⚠️ Consommation CPU/RAM élevée

### Workflow
1. Modifier un fichier `.ts` ou `.js`
2. Sauvegarder (Ctrl+S)
3. **Rechargement automatique** !

### Backend (nodemon)
- Surveille `/opt/Ryvie/Ryvie-Back/src/**/*.ts`
- Recompile et redémarre automatiquement
- Logs : `pm2 logs ryvie-backend-dev`

### Frontend (webpack-dev-server)
- Surveille `/opt/Ryvie/Ryvie-Front/src/**/*`
- Hot Module Replacement (HMR)
- Logs : `pm2 logs ryvie-frontend-dev`

### Commandes utiles
```bash
# Voir les logs en temps réel
pm2 logs ryvie-backend-dev --lines 50
pm2 logs ryvie-frontend-dev --lines 50

# Redémarrer manuellement
pm2 restart ryvie-backend-dev
pm2 restart ryvie-frontend-dev

# Arrêter
pm2 stop ryvie-backend-dev ryvie-frontend-dev
```

---

## 🏭 Mode PRODUCTION

### Caractéristiques
- ✅ **Code optimisé et minifié**
- ✅ **Consommation minimale** (CPU ~5%, RAM ~300MB)
- ✅ **Pas de webpack** (serveur statique léger)
- ✅ **Performances maximales**
- ⚠️ Nécessite un rebuild pour chaque modification

### Workflow
1. Modifier un fichier
2. Lancer `npm run build` (backend) ou `npm run build` (frontend)
3. Redémarrer avec `pm2 restart ryvie-backend-prod` ou `ryvie-frontend-prod`

**OU** utiliser le script :
```bash
/opt/Ryvie/scripts/prod.sh  # Build + restart automatique
```

### Backend (Node.js)
- Exécute le code compilé `/opt/Ryvie/Ryvie-Back/dist/index.js`
- Pas de recompilation automatique
- Logs : `pm2 logs ryvie-backend-prod`

### Frontend (serve)
- Sert les fichiers statiques de `/opt/Ryvie/Ryvie-Front/dist`
- Serveur HTTP ultra-léger
- Logs : `pm2 logs ryvie-frontend-prod`

### Build manuel
```bash
# Backend
cd /opt/Ryvie/Ryvie-Back
npm run build
pm2 restart ryvie-backend-prod

# Frontend
cd /opt/Ryvie/Ryvie-Front
npm run build
pm2 restart ryvie-frontend-prod
```

---

## 📊 Comparaison des Performances

### Mode DEV
```
Processus actifs:
- nodemon (watch backend)
- ts-node (exécution TypeScript)
- webpack-dev-server (watch frontend)
- webpack (compilation)

Consommation:
- CPU: ~30% (webpack 17% + nodemon 5% + IDE 19%)
- RAM: ~2GB (webpack 250MB + nodemon 150MB + IDE 2GB)
```

### Mode PROD
```
Processus actifs:
- node (backend compilé)
- serve (serveur statique)

Consommation:
- CPU: ~5% (node 2% + serve 1%)
- RAM: ~300MB (node 150MB + serve 50MB)
```

**Gain en production : -25% CPU, -1.7GB RAM** 🎉

---

## 🔧 Configuration Avancée

### Modifier les ports

**Fichier** : `/opt/Ryvie/ecosystem.config.js`

```javascript
env: {
  PORT: 3002  // Backend
}
```

```javascript
env: {
  PORT: 3000  // Frontend
}
```

### Ajouter des variables d'environnement

```javascript
env: {
  NODE_ENV: 'development',
  PORT: 3002,
  DEBUG: 'true',
  LOG_LEVEL: 'debug'
}
```

### Changer les chemins de logs

```javascript
error_file: '/data/logs/backend-dev-error.log',
out_file: '/data/logs/backend-dev-out.log',
```

---

## 🐛 Dépannage

### Le backend ne redémarre pas en dev
```bash
# Vérifier les logs
pm2 logs ryvie-backend-dev --err

# Redémarrer manuellement
pm2 restart ryvie-backend-dev
```

### Le frontend ne se recharge pas
```bash
# Vérifier que webpack tourne
pm2 logs ryvie-frontend-dev

# Vider le cache webpack
cd /opt/Ryvie/Ryvie-Front
rm -rf node_modules/.cache
pm2 restart ryvie-frontend-dev
```

### Build production échoue
```bash
# Backend
cd /opt/Ryvie/Ryvie-Back
npm run build
# Vérifier les erreurs TypeScript

# Frontend
cd /opt/Ryvie/Ryvie-Front
npm run build
# Vérifier les erreurs webpack
```

### Conflit de ports
```bash
# Vérifier les ports utilisés
lsof -i :3000
lsof -i :3002

# Tuer les processus
kill -9 <PID>
```

---

## 📝 Bonnes Pratiques

### En développement
1. ✅ Utiliser le mode **DEV** pour le confort du hot-reload
2. ✅ Commiter régulièrement
3. ✅ Tester en mode **PROD** avant de déployer
4. ⚠️ Ne jamais commiter les fichiers `dist/`

### En production
1. ✅ Toujours builder avant de déployer
2. ✅ Utiliser le mode **PROD** pour les performances
3. ✅ Monitorer les logs : `pm2 logs`
4. ✅ Configurer PM2 pour démarrer au boot : `pm2 startup`

### Workflow recommandé
```bash
# 1. Développer en mode DEV
/opt/Ryvie/scripts/dev.sh

# 2. Coder et tester (hot-reload automatique)
# ...

# 3. Tester en mode PROD avant commit
/opt/Ryvie/scripts/prod.sh

# 4. Vérifier que tout fonctionne
# ...

# 5. Commiter
git add .
git commit -m "Feature: ..."

# 6. Retourner en mode DEV
/opt/Ryvie/scripts/dev.sh
```

---

## 🎓 Commandes PM2 Utiles

```bash
# Lister tous les processus
pm2 list

# Voir les détails d'un processus
pm2 show ryvie-backend-dev

# Logs en temps réel
pm2 logs

# Logs d'un processus spécifique
pm2 logs ryvie-backend-dev

# Redémarrer
pm2 restart ryvie-backend-dev

# Arrêter
pm2 stop ryvie-backend-dev

# Supprimer
pm2 delete ryvie-backend-dev

# Tout redémarrer
pm2 restart all

# Tout arrêter
pm2 stop all

# Sauvegarder la config PM2
pm2 save

# Restaurer la config PM2
pm2 resurrect
```

---

## 📚 Ressources

- [Documentation PM2](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [Documentation nodemon](https://nodemon.io/)
- [Documentation webpack-dev-server](https://webpack.js.org/configuration/dev-server/)
- [Documentation serve](https://github.com/vercel/serve)

---

**Date** : 10 décembre 2025  
**Version** : 1.0  
**Auteur** : Cascade AI
