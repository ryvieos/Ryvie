# Contributing to Ryvie

Merci de votre intérêt pour contribuer à **Ryvie** ! 🎉

Nous accueillons les contributions de tous types : corrections de bugs, nouvelles fonctionnalités, améliorations de documentation, traductions, etc.

## 📋 Table des matières

- [Code de conduite](#code-de-conduite)
- [Avant de commencer](#avant-de-commencer)
- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
- [Comment contribuer](#comment-contribuer)
- [Standards de code](#standards-de-code)
- [Process de Pull Request](#process-de-pull-request)
- [Signaler un bug](#signaler-un-bug)
- [Proposer une fonctionnalité](#proposer-une-fonctionnalité)

---

## Code de conduite

En participant à ce projet, vous vous engagez à maintenir un environnement respectueux et professionnel. Soyez courtois, constructif et bienveillant envers les autres contributeurs.

---

## Avant de commencer

### Prérequis techniques

Assurez-vous d'avoir installé :
- **Node.js** (v18 ou supérieur)
- **Docker** et **Docker Compose**
- **Git**

### Configuration de l'environnement de développement

1. **Forkez le repository** sur GitHub
2. **Clonez votre fork** :
   ```bash
   git clone https://github.com/VOTRE-USERNAME/Ryvie.git
   cd Ryvie
   ```
3. **Ajoutez le repository upstream** :
   ```bash
   git remote add upstream https://github.com/maisonnavejul/Ryvie.git
   ```
4. **Installez les dépendances** :
   ```bash
   # Backend
   cd Ryvie-Back
   npm install
   
   # Frontend
   cd ../Ryvie-Front
   npm install
   ```

---

## Contributor License Agreement (CLA)

**⚠️ IMPORTANT** : Avant que nous puissions accepter votre contribution, vous devez signer notre **Contributor License Agreement (CLA)**.

### Pourquoi un CLA ?

Le CLA protège à la fois :
- **Vous** : Vous conservez la propriété de votre code
- **Ryvie** : Nous pouvons maintenir et faire évoluer le projet, y compris d'éventuels changements de licence futurs
- **Les utilisateurs** : Garantit que toutes les contributions sont correctement licenciées

### Comment signer le CLA

Lorsque vous soumettrez votre première Pull Request, notre **CLA Assistant bot** commentera automatiquement avec un lien pour signer électroniquement le CLA via votre compte GitHub.

**Processus** :
1. Soumettez votre Pull Request
2. Le bot CLA Assistant commente avec un lien
3. Cliquez sur le lien et signez avec votre compte GitHub
4. Votre PR sera automatiquement débloquée pour review

📄 **Lisez le CLA complet** : [CLA.md](./CLA.md)

### Contributions corporatives

Si vous contribuez au nom de votre employeur, contactez-nous à **contact@ryvie.fr** pour un Corporate CLA.

---

## Comment contribuer

### 1. Choisissez ou créez une issue

- Consultez les [issues existantes](https://github.com/maisonnavejul/Ryvie/issues)
- Cherchez les labels `good first issue` ou `help wanted` pour débuter
- Si vous avez une nouvelle idée, créez d'abord une issue pour en discuter

### 2. Créez une branche

```bash
git checkout -b feature/ma-nouvelle-fonctionnalite
# ou
git checkout -b fix/correction-bug-xyz
```

**Convention de nommage des branches** :
- `feature/description` : Nouvelle fonctionnalité
- `fix/description` : Correction de bug
- `docs/description` : Documentation
- `refactor/description` : Refactoring
- `test/description` : Ajout de tests

### 3. Développez votre contribution

- Écrivez du code clair et maintenable
- Suivez les [standards de code](#standards-de-code)
- Ajoutez des tests si applicable
- Mettez à jour la documentation si nécessaire

### 4. Committez vos changements

Utilisez des messages de commit clairs et descriptifs :

```bash
git commit -m "feat: ajout du widget météo personnalisable"
# ou
git commit -m "fix: correction du bug de connexion LDAP"
```

**Convention de messages de commit** (Conventional Commits) :
- `feat:` Nouvelle fonctionnalité
- `fix:` Correction de bug
- `docs:` Documentation
- `style:` Formatage, points-virgules manquants, etc.
- `refactor:` Refactoring de code
- `test:` Ajout de tests
- `chore:` Maintenance, dépendances, etc.

### 5. Synchronisez avec upstream

Avant de soumettre, assurez-vous d'être à jour :

```bash
git fetch upstream
git rebase upstream/main
```

### 6. Poussez vers votre fork

```bash
git push origin feature/ma-nouvelle-fonctionnalite
```

---

## Standards de code

### Backend (Node.js/TypeScript)

- Utilisez **TypeScript** pour le nouveau code
- Suivez les conventions ESLint configurées
- Documentez les fonctions complexes avec JSDoc
- Gérez les erreurs de manière appropriée (try/catch, error handlers)
- Utilisez des noms de variables descriptifs en anglais

### Frontend (React)

- Utilisez des **composants fonctionnels** avec hooks
- Suivez la structure de dossiers existante
- Utilisez **TailwindCSS** pour le styling
- Évitez les inline styles sauf cas exceptionnels
- Optimisez les re-renders (useMemo, useCallback)

### Général

- **Pas de console.log** en production (utilisez un logger approprié)
- **Pas de code commenté** (utilisez Git pour l'historique)
- **Tests** : Ajoutez des tests pour les nouvelles fonctionnalités
- **Sécurité** : Ne committez jamais de secrets, tokens, ou credentials

---

## Process de Pull Request

### Checklist avant soumission

- [ ] Le code compile sans erreurs
- [ ] Les tests passent (`npm test`)
- [ ] Le code suit les standards du projet
- [ ] La documentation est à jour
- [ ] Les commits sont propres et bien nommés
- [ ] Le CLA est signé (le bot vous guidera)

### Créer la Pull Request

1. Allez sur GitHub et créez une Pull Request depuis votre branche
2. Remplissez le template de PR avec :
   - **Description** : Qu'est-ce que cette PR fait ?
   - **Motivation** : Pourquoi ce changement est nécessaire ?
   - **Type de changement** : Bug fix, feature, docs, etc.
   - **Tests** : Comment avez-vous testé ?
   - **Screenshots** : Si changement UI

3. Liez l'issue correspondante (ex: `Closes #123`)

### Review et merge

- Un mainteneur reviewera votre PR
- Répondez aux commentaires et effectuez les modifications demandées
- Une fois approuvée, votre PR sera mergée ! 🎉

---

## Signaler un bug

Pour signaler un bug, [créez une issue](https://github.com/maisonnavejul/Ryvie/issues/new) avec :

- **Titre clair** : Résumé du problème
- **Description détaillée** :
  - Comportement attendu vs comportement observé
  - Étapes pour reproduire
  - Version de Ryvie
  - Environnement (OS, navigateur, etc.)
  - Logs d'erreur si disponibles
  - Screenshots si applicable

**Template** :
```markdown
**Description du bug**
[Description claire du problème]

**Reproduction**
1. Aller sur '...'
2. Cliquer sur '...'
3. Voir l'erreur

**Comportement attendu**
[Ce qui devrait se passer]

**Screenshots**
[Si applicable]

**Environnement**
- OS: [ex: Ubuntu 22.04]
- Version Ryvie: [ex: 1.0.0]
- Navigateur: [ex: Chrome 120]
```

---

## Proposer une fonctionnalité

Pour proposer une nouvelle fonctionnalité :

1. **Vérifiez** qu'elle n'existe pas déjà ou n'est pas en cours
2. **Créez une issue** avec le label `enhancement`
3. **Décrivez** :
   - Le problème que cela résout
   - La solution proposée
   - Les alternatives considérées
   - L'impact sur les utilisateurs

**Attendez un retour** avant de commencer le développement pour éviter le travail inutile.

---

## Structure du projet

```
Ryvie/
├── Ryvie-Back/          # Backend Express + Socket.IO
│   ├── routes/          # Routes API
│   ├── services/        # Logique métier
│   ├── middleware/      # Middlewares Express
│   └── utils/           # Utilitaires
├── Ryvie-Front/         # Frontend React
│   ├── src/
│   │   ├── components/  # Composants React
│   │   ├── pages/       # Pages principales
│   │   ├── hooks/       # Custom hooks
│   │   └── utils/       # Utilitaires frontend
├── docs/                # Documentation
└── scripts/             # Scripts utilitaires
```

---

## Ressources utiles

- **Documentation** : [docs/](./docs/)
- **Architecture** : Voir le README principal
- **Sécurité** : [SECURITY.md](./SECURITY.md)
- **License** : [LICENSE](./LICENSE) (RSAL v1.1)

---

## Questions ?

- **Issues GitHub** : Pour les questions techniques
- **Email** : contact@ryvie.fr
- **Discussions** : Utilisez les GitHub Discussions pour les questions générales

---

## Remerciements

Merci de contribuer à Ryvie ! Chaque contribution, petite ou grande, aide à améliorer le projet pour toute la communauté. ❤️

---

**Fait avec ❤️ par la communauté Ryvie**
