# Caveman - Guide de démarrage rapide pour Ryvie

## 🚀 Démarrage en 30 secondes

Caveman est **déjà installé et configuré** pour Ryvie. Il s'active automatiquement à chaque session Claude Code.

### Vérification rapide

1. **Ouvrez Claude Code** dans `/opt/Ryvie`
2. **Regardez la barre d'état** : vous devriez voir `[CAVEMAN]`
3. **Posez une question** : la réponse sera en mode caveman par défaut

## 🎯 Commandes essentielles

### Changer de mode

```bash
/caveman lite     # Mode professionnel (garde la grammaire)
/caveman full     # Mode complet (par défaut)
/caveman ultra    # Mode ultra-compressé
```

### Skills utiles pour Ryvie

```bash
/caveman-commit              # Message de commit concis
/caveman-review              # Revue de code en une ligne
/caveman:compress CLAUDE.md  # Compresse un fichier de doc
```

### Désactiver temporairement

```bash
stop caveman     # Revenir au mode normal
normal mode      # Alternative
```

## 📋 Cas d'usage Ryvie

### 1. Commits Git

**Avant Caveman :**
```
git commit -m "Added new feature to handle user authentication with JWT tokens and implemented middleware for validating tokens on protected routes, also updated the documentation to reflect these changes"
```

**Avec `/caveman-commit` :**
```
feat(auth): JWT middleware for protected routes

Add token validation middleware. Update docs.
```

### 2. Debugging

**Question :**
> "Why is the Docker container not starting?"

**Réponse Caveman :**
> "Network `ryvie-network` missing. Create first:
> ```bash
> docker network create ryvie-network
> ```"

### 3. Revue de code

**Utilisation :**
```bash
/caveman-review
```

**Résultat :**
```
L42: 🔴 bug: user null. Add guard.
L89: 🟡 perf: N+1 query. Use eager loading.
L156: 🟢 style: var → const.
```

## 🎨 Modes expliqués

### Lite - Pour la documentation formelle

```
Input: "Explain the RAID migration process"

Output: "RAID migration requires stopping services, backing up /data,
creating new array, restoring data, updating /etc/fstab. Takes 2-4h
depending on data size."
```

**Usage :** Communications formelles, documentation utilisateur

### Full - Pour le développement (défaut)

```
Input: "Explain the RAID migration process"

Output: "Stop services. Backup /data. Create new array. Restore.
Update fstab. 2-4h based on data size."
```

**Usage :** Développement quotidien, debugging, réponses techniques

### Ultra - Pour les sessions intensives

```
Input: "Explain the RAID migration process"

Output: "Stop svcs → backup /data → new array → restore → fstab. 2-4h."
```

**Usage :** Sessions avec beaucoup d'interactions, besoin de vitesse maximale

## 💡 Astuces Ryvie

### Compresser la documentation

Les gros fichiers de doc chargent des tokens à chaque session. Compressez-les :

```bash
/caveman:compress /opt/Ryvie/docs/ARCHITECTURE_DOCKER_RYVIE.md
```

Résultat :
- `ARCHITECTURE_DOCKER_RYVIE.md` ← version compressée (lue par Claude)
- `ARCHITECTURE_DOCKER_RYVIE.original.md` ← backup lisible

**Économie moyenne : ~46% de tokens d'entrée**

### Workflow recommandé

```bash
# 1. Session normale en mode full (automatique)
# Développement, debugging, questions techniques

# 2. Commits
/caveman-commit
# Génère un message concis et conforme

# 3. Revue de PR
/caveman-review
# Commentaires directs et actionnables

# 4. Documentation formelle
/caveman lite
# Communication professionnelle si nécessaire

# 5. Session intensive (beaucoup de questions)
/caveman ultra
# Réponses ultra-rapides
```

## 🔧 Configuration

### Fichiers de configuration

```
~/.config/caveman/config.json      # Préférences Caveman
~/.claude/hooks/                   # Hooks installés
~/.claude/settings.json            # Configuration Claude Code
~/.claude/.caveman-active          # Mode actif (créé automatiquement)
```

### Mode par défaut

Le mode par défaut est `full` (configuré dans `~/.config/caveman/config.json`).

Pour changer :

```json
{
  "defaultMode": "lite"  // ou "ultra"
}
```

## 🐛 Dépannage

### Caveman ne s'active pas

```bash
# 1. Vérifier l'installation
ls -la ~/.claude/hooks/caveman-*

# 2. Vérifier settings.json
cat ~/.claude/settings.json | grep caveman

# 3. Réinstaller si nécessaire
cd /tmp/caveman && bash hooks/install.sh
```

### Le badge ne s'affiche pas

```bash
# Vérifier la configuration statusline
cat ~/.claude/settings.json | grep statusLine

# Le badge devrait apparaître après redémarrage de Claude Code
```

### Mode ne change pas

```bash
# Vérifier le fichier de mode actif
cat ~/.claude/.caveman-active

# Forcer un mode
/caveman full
```

## 📊 Métriques pour Ryvie

Sur un projet de la taille de Ryvie, les économies sont significatives :

| Activité | Tokens normaux | Tokens Caveman | Économie |
|----------|---------------:|---------------:|---------:|
| Session de debugging (10 questions) | ~12,000 | ~3,000 | 75% |
| Revue de PR (50 commentaires) | ~8,000 | ~2,000 | 75% |
| Documentation d'architecture | ~15,000 | ~4,000 | 73% |
| **Total session type** | **~35,000** | **~9,000** | **~74%** |

**Sur un mois de développement :**
- Sessions moyennes par jour : 4-6
- Tokens économisés par mois : ~3,000,000
- Coût économisé : significatif selon votre plan

## 🎓 Pour aller plus loin

### Documentation complète

- [CAVEMAN_INTEGRATION.md](CAVEMAN_INTEGRATION.md) - Documentation complète
- [DEVELOPER_TOOLS.md](DEVELOPER_TOOLS.md) - Tous les outils de dev Ryvie
- [docs/caveman/README.md](caveman/README.md) - README officiel Caveman

### Ressources externes

- [GitHub Caveman](https://github.com/juliusbrussee/caveman)
- [Écosystème Caveman](https://github.com/juliusbrussee) (cavemem, cavekit)

## 🆘 Support

**Problème avec Caveman ?**
- Issues Caveman : https://github.com/juliusbrussee/caveman/issues

**Problème avec l'intégration Ryvie ?**
- Issues Ryvie : [Votre repo]/issues
- Contact : L'équipe Ryvie

---

**🪨 Happy coding avec Caveman!**

*"Why use many token when few do trick"*
