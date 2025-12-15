# Système de Mise à Jour Ryvie

## 🎯 Vue d'ensemble

Ryvie utilise un système de mise à jour simple et fiable basé sur **GitHub Releases**.

### Caractéristiques
- ✅ **Releases versionnées** (pas de `git pull`)
- ✅ **Asset auto-généré** (Source code tar.gz de GitHub)
- ✅ **Préservation des configs** (Front/src/config + Back/.env)
- ✅ **Build automatique** (via `prod.sh`)
- ✅ **Rollback automatique** (snapshot btrfs en cas d'erreur)

---

## 📦 Architecture

### Structure des dossiers
```
/opt/Ryvie/
├── .update-staging/               # Dossier temporaire pour l'update
│   ├── v0.1.5.tar.gz             # Archive téléchargée
│   └── extracted/                # Contenu extrait
├── scripts/
│   ├── prod.sh                   # Build + restart (utilisé par l'update)
│   ├── snapshot.sh               # Snapshot btrfs
│   └── rollback.sh               # Rollback btrfs
├── Ryvie-Front/
│   └── src/
│       └── config/               # ⚠️ Préservé lors de l'update
└── Ryvie-Back/
    ├── .env                      # ⚠️ Préservé lors de l'update
    └── services/
        └── updateService.ts      # Service d'update
```

---

## 🔄 Flux de Mise à Jour

### 1. Déclenchement
```
Utilisateur clique "Mettre à jour" dans l'UI Ryvie
→ Backend vérifie la dernière release GitHub
→ Compare version actuelle vs dernière disponible
```

### 2. Snapshot de sécurité
```
Exécute /opt/Ryvie/scripts/snapshot.sh
→ Crée un snapshot btrfs de /opt/Ryvie
→ Permet rollback automatique en cas d'échec
```

### 3. Téléchargement
```
Télécharge l'asset auto-généré "Source code (tar.gz)" depuis GitHub
→ Stocké dans /opt/Ryvie/.update-staging/vX.Y.Z.tar.gz
```

### 4. Extraction
```
Extrait dans /opt/Ryvie/.update-staging/extracted/
→ Dossier temporaire (pas encore actif)
```

### 5. Copie des configurations locales
```
Copie Front/src/config/ depuis /opt/Ryvie vers le staging
→ Préserve app-ports.json, appConfig.js, etc.

Copie Back/.env depuis /opt/Ryvie vers le staging
→ Préserve les variables d'environnement locales
```

### 6. Application de la nouvelle version
```
Utilise rsync pour copier le staging vers /opt/Ryvie
→ Exclut .git, node_modules, .update-staging
→ Remplace le code mais garde les configs
```

### 7. Build et redémarrage
```
Exécute /opt/Ryvie/scripts/prod.sh
→ Build backend (TypeScript → JavaScript)
→ Build frontend (webpack production)
→ Redémarre PM2 (backend + frontend)
```

### 8. Nettoyage
```
Supprime /opt/Ryvie/.update-staging/
→ Libère l'espace disque
```

### 9. Rollback automatique (si erreur)
```
Si échec à n'importe quelle étape:
→ Exécute /opt/Ryvie/scripts/rollback.sh --set <snapshot_path>
→ Restaure l'état avant update
→ Redémarre les services
```

---

## 🛠️ Publier une Nouvelle Version

### Workflow simple
1. **Développer et tester** en mode dev/prod
2. **Commiter** les changements
3. **Créer un tag Git**:
   ```bash
   git tag v0.1.5
   git push origin v0.1.5
   ```
4. **Créer la release sur GitHub**:
   - Interface web: https://github.com/maisonnavejul/Ryvie/releases/new
   - Ou GitHub CLI: `gh release create v0.1.5 --title "v0.1.5" --notes "Release notes"`

**Important**: GitHub génère automatiquement l'asset "Source code (tar.gz)" que Ryvie téléchargera.

---

## 🔐 Sécurité

### Snapshots btrfs
- Créés automatiquement avant chaque update
- Permettent un rollback instantané en cas d'échec
- Nettoyés automatiquement après succès

### Vérification
- **HTTPS**: toutes les requêtes GitHub sont sécurisées
- **GitHub Token**: optionnel (variable `GITHUB_TOKEN` dans `.env`), évite les rate limits API
- **Rollback automatique**: restaure l'état précédent si erreur

---

## 📊 Monitoring

### Vérifier la version actuelle
```bash
cat /opt/Ryvie/package.json | grep version
```

### Logs d'update
```bash
pm2 logs ryvie-backend-prod | grep Update
```

### Vérifier les snapshots disponibles
```bash
ls -lh /data/.snapshots/
```

---

## 🔄 Rollback Manuel

Si une mise à jour pose problème après redémarrage:

```bash
# Lister les snapshots disponibles
ls -lh /data/.snapshots/

# Rollback vers un snapshot
sudo /opt/Ryvie/scripts/rollback.sh --set /data/.snapshots/ryvie_YYYYMMDD_HHMMSS

# Redémarrer les services
pm2 reload all
```

---

## 🐛 Dépannage

### L'update échoue au téléchargement
- Vérifier la connexion internet
- Vérifier que la release existe sur GitHub
- Vérifier les logs: `pm2 logs ryvie-backend-prod --err`

### Le build échoue (prod.sh)
- Vérifier les dépendances: `npm ci` dans Back et Front
- Vérifier les logs de build
- Le rollback automatique devrait restaurer l'état précédent

### Le système ne redémarre pas après update
- Vérifier PM2: `pm2 list`
- Vérifier les logs: `pm2 logs`
- Rollback manuel (voir section ci-dessus)

---

## 📚 Ressources

- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)
- [Semantic Versioning](https://semver.org/)
- [Btrfs Snapshots](https://btrfs.wiki.kernel.org/index.php/SysadminGuide#Snapshots)

---

**Date**: 15 décembre 2025  
**Version**: 1.0  
**Auteur**: Cascade AI
