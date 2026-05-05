# Intégration de Caveman dans Ryvie

## Qu'est-ce que Caveman ?

**Caveman** est un plugin/skill pour les agents IA (notamment Claude Code) qui réduit drastiquement l'utilisation des tokens de sortie (~75%) tout en conservant une précision technique complète.

Le principe : faire parler l'agent comme un "homme des cavernes" - en supprimant les articles, les formulations inutiles et le remplissage verbal, tout en gardant l'exactitude technique.

### Avantages

```
┌─────────────────────────────────────┐
│  TOKENS ÉCONOMISÉS     ████████ 75% │
│  PRÉCISION TECHNIQUE   ████████ 100%│
│  VITESSE AUGMENTÉE     ████████ ~3x │
│  LISIBILITÉ            ████████ +++  │
└─────────────────────────────────────┘
```

- **Réponses plus rapides** — moins de tokens à générer = vitesse augmentée
- **Plus facile à lire** — pas de mur de texte, juste la réponse
- **Même précision** — toute l'information technique est conservée
- **Économies** — ~71% de tokens de sortie en moins = coûts réduits
- **Amusant** — chaque revue de code devient une comédie

## Installation pour Ryvie

Caveman a été installé pour le projet Ryvie le **29 avril 2026**.

### Fichiers installés

Les hooks Caveman sont installés dans `~/.claude/hooks/` :

```bash
~/.claude/hooks/
├── package.json              # Marqueur CommonJS
├── caveman-config.js         # Configuration partagée
├── caveman-activate.js       # Hook SessionStart
├── caveman-mode-tracker.js   # Hook UserPromptSubmit
└── caveman-statusline.sh     # Badge de statut
```

### Configuration Claude Code

Le fichier `~/.claude/settings.json` a été configuré automatiquement avec :

1. **Hook SessionStart** : charge les règles Caveman à chaque nouvelle session
2. **Hook UserPromptSubmit** : met à jour le mode actif et renforce les règles
3. **Statusline badge** : affiche `[CAVEMAN]` ou `[CAVEMAN:ULTRA]` dans la barre d'état

## Utilisation

### Activation

Caveman s'active automatiquement au démarrage de chaque session Claude Code.

Vous pouvez également l'activer manuellement avec :
- `/caveman`
- "talk like caveman"
- "caveman mode"
- "less tokens please"

### Désactivation

Pour désactiver temporairement :
- "stop caveman"
- "normal mode"

### Niveaux d'intensité

| Niveau | Commande | Description |
|--------|----------|-------------|
| **Lite** | `/caveman lite` | Supprime le remplissage, garde la grammaire. Professionnel sans superflu |
| **Full** | `/caveman full` | Caveman par défaut. Supprime les articles, utilise des fragments |
| **Ultra** | `/caveman ultra` | Compression maximale. Télégraphique. Tout est abrégé |

### Mode 文言文 (Wenyan)

Compression en chinois classique littéraire - même précision technique, mais dans le langage écrit le plus efficace en tokens jamais inventé.

| Niveau | Commande | Description |
|--------|----------|-------------|
| **Wenyan-Lite** | `/caveman wenyan-lite` | Semi-classique. Grammaire intacte, remplissage supprimé |
| **Wenyan-Full** | `/caveman wenyan` | 文言文 complet. Concision classique maximale |
| **Wenyan-Ultra** | `/caveman wenyan-ultra` | Extrême. Érudit ancien avec budget limité |

## Skills supplémentaires

### caveman-commit

Génère des messages de commit concis suivant les Conventional Commits. Sujet ≤50 caractères. Se concentre sur le "pourquoi" plutôt que le "quoi".

```bash
/caveman-commit
```

### caveman-review

Commentaires de revue de code en une ligne :

```bash
/caveman-review
```

Format : `L42: 🔴 bug: user null. Add guard.`

### caveman-compress

Compresse les fichiers de mémoire (comme `CLAUDE.md`) pour réduire les tokens d'**entrée** à chaque session.

```bash
/caveman:compress CLAUDE.md
```

Crée :
- `CLAUDE.md` ← version compressée (lue par Claude)
- `CLAUDE.original.md` ← backup lisible par l'humain

Économie moyenne : **~46% de tokens d'entrée**

### caveman-help

Carte de référence rapide pour tous les modes, skills et commandes.

```bash
/caveman-help
```

## Exemple Avant/Après

### 🗣️ Claude Normal (69 tokens)

> "The reason your React component is re-rendering is likely because you're creating a new object reference on each render cycle. When you pass an inline object as a prop, React's shallow comparison sees it as a different object every time, which triggers a re-render. I'd recommend using useMemo to memoize the object."

### 🪨 Caveman Claude (19 tokens)

> "New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`."

**Même correction. 75% de mots en moins. Le cerveau reste gros.**

## Documentation de référence

Les fichiers de référence Caveman sont disponibles dans :

```
/opt/Ryvie/docs/caveman/
├── README.md           # Documentation complète
├── CLAUDE.md          # Guide pour les agents IA
└── skills/            # Définitions des skills
    ├── caveman/
    ├── caveman-commit/
    ├── caveman-review/
    └── caveman-help/
```

## Intégration avec le workflow Ryvie

Caveman est particulièrement utile pour :

1. **Développement rapide** : réponses plus courtes = itérations plus rapides
2. **Debugging** : réponses concises et directes sans superflu
3. **Revues de code** : commentaires directs et actionnables
4. **Commits Git** : messages concis et informatifs
5. **Documentation** : compression des fichiers de mémoire pour économiser les tokens

## Maintenance

### Mise à jour

Pour mettre à jour Caveman :

```bash
cd /tmp
git clone https://github.com/juliusbrussee/caveman
cd caveman
bash hooks/install.sh
```

### Désinstallation

Si vous souhaitez désinstaller Caveman :

```bash
cd /tmp/caveman
bash hooks/uninstall.sh
```

## Liens

- **Dépôt GitHub** : https://github.com/juliusbrussee/caveman
- **Écosystème Caveman** :
  - [caveman](https://github.com/JuliusBrussee/caveman) - compression de sortie (vous êtes ici)
  - [cavemem](https://github.com/JuliusBrussee/cavemem) - mémoire persistante multi-agents
  - [cavekit](https://github.com/JuliusBrussee/cavekit) - boucle de build autonome basée sur les specs

## Notes spécifiques à Ryvie

Caveman est installé globalement pour l'utilisateur `ryvie` et s'active automatiquement dans toutes les sessions Claude Code.

Pour l'utiliser dans le contexte du développement Ryvie :
- Les messages de commit pour les changements dans `/opt/Ryvie` peuvent utiliser `/caveman-commit`
- Les revues de code pour les PRs Ryvie peuvent utiliser `/caveman-review`
- La documentation dans `/opt/Ryvie/docs/` peut être compressée avec `/caveman:compress`

## Compatibilité

Caveman fonctionne avec :
- ✅ Claude Code (installé pour Ryvie)
- ✅ Codex
- ✅ Gemini CLI
- ✅ Cursor
- ✅ Windsurf
- ✅ Cline
- ✅ GitHub Copilot
- ✅ 40+ autres agents via `npx skills`

---

**Installation effectuée le : 2026-04-29**
**Installé par : ryvie**
**Version : Latest from main branch**
