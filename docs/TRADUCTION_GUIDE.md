# Guide d'utilisation du système i18n

## ✅ Système installé et fonctionnel

Le système i18n est **complètement opérationnel**. Le contexte se propage correctement quand vous changez la langue dans Settings.

## ❌ Problème actuel

Les pages utilisent encore des **textes en dur** au lieu d'utiliser les traductions. C'est pourquoi vous ne voyez pas le changement.

## 🔧 Solution : Remplacer les textes en dur

### Exemple dans Settings.tsx (ligne 1618)

**AVANT (texte en dur) :**
```tsx
<h3>Fond d'écran</h3>
<p className="setting-description">
  Personnalisez l'arrière-plan de votre page d'accueil. Vous pouvez ajouter plusieurs fonds d'écran.
</p>
```

**APRÈS (avec traduction) :**
```tsx
<h3>{t('settings.backgroundImage')}</h3>
<p className="setting-description">
  {t('settings.backgroundDescription')}
</p>
```

### Étapes pour chaque page

1. **Ajouter le hook en haut du composant** (déjà fait dans Settings) :
```tsx
const { language, setLanguage, t } = useLanguage();
```

2. **Remplacer TOUS les textes en dur** par `t('key')` :
   - Titres : `<h2>Paramètres</h2>` → `<h2>{t('settings.title')}</h2>`
   - Descriptions : `"Personnalisez..."` → `{t('settings.description')}`
   - Boutons : `"Enregistrer"` → `{t('common.save')}`
   - Messages : `"Succès"` → `{t('common.success')}`

3. **Ajouter les clés manquantes dans les fichiers JSON** si nécessaire

## 📝 Clés de traduction disponibles

Consultez `/opt/Ryvie/Ryvie-Front/src/i18n/fr.json` et `en.json` pour voir toutes les clés disponibles :

- `common.*` - Actions communes (save, delete, cancel, etc.)
- `settings.*` - Tous les paramètres
- `home.*` - Page d'accueil
- `appStore.*` - Magasin d'applications
- `user.*` - Gestion utilisateurs
- etc.

## 🎯 Pages à modifier

Pour que le changement de langue fonctionne partout, modifiez ces pages :

1. ✅ **Settings.tsx** - Partiellement fait (seulement section langue)
2. ❌ **Home.tsx** - À faire
3. ❌ **AppStore.tsx** - À faire
4. ❌ **Welcome.tsx** - À faire
5. ❌ **User.tsx** - À faire
6. ❌ **Login.tsx** - À faire

## 🚀 Test rapide

Pour tester que ça fonctionne, modifiez une section de Settings :

```tsx
// Ligne ~1618 dans Settings.tsx
<h3>{t('settings.backgroundImage')}</h3>
<p className="setting-description">
  {t('settings.backgroundDescription')}
</p>
```

Puis ajoutez dans `fr.json` et `en.json` :
```json
"settings": {
  "backgroundImage": "Fond d'écran",  // ou "Background" en anglais
  "backgroundDescription": "Personnalisez l'arrière-plan..."
}
```

Quand vous changerez la langue, cette section se mettra à jour instantanément !

## 💡 Pourquoi ça ne change pas actuellement ?

Le contexte fonctionne ✅  
Le changement de langue se propage ✅  
MAIS les pages affichent du texte en dur ❌

C'est comme avoir un interrupteur qui fonctionne, mais les ampoules ne sont pas branchées dessus !

## 🔄 Prochaine étape

Remplacez progressivement tous les textes en dur par des appels à `t()` dans chaque page.
Le système est prêt, il suffit de l'utiliser !
