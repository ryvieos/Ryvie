# Thème personnalisé Ryvie pour Keycloak

## 🎨 Activation du thème

### Méthode 1 : Via l'interface admin (Recommandé)

1. Accédez à l'interface admin Keycloak :
   ```
   http://ryvie.local:3005
   ```

2. Connectez-vous avec :
   - **Username** : `admin`
   - **Password** : `changeme123`

3. Sélectionnez le realm **"ryvie"** (menu déroulant en haut à gauche)

4. Allez dans **Realm settings** (menu de gauche)

5. Onglet **Themes**

6. Dans **Login theme**, sélectionnez **"ryvie"** dans le menu déroulant

7. Cliquez sur **Save**

8. Videz le cache de votre navigateur (Ctrl + Shift + R)

### Méthode 2 : Via l'API

```bash
# Obtenir un token admin
TOKEN=$(curl -s -X POST "http://ryvie.local:3005/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin" \
  -d "password=changeme123" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | jq -r '.access_token')

# Configurer le thème
curl -X PUT "http://ryvie.local:3005/admin/realms/ryvie" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"loginTheme":"ryvie"}'
```

## 🖼️ Personnalisation

### Changer les couleurs

Modifiez `/opt/Ryvie/keycloak/themes/ryvie/login/resources/css/ryvie-custom.css` :

```css
/* Fond dégradé */
body {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
}

/* Bouton de connexion */
#kc-login {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
}
```

Remplacez `#667eea` et `#764ba2` par vos couleurs.

### Ajouter une image de fond

1. Placez votre image dans :
   ```
   /opt/Ryvie/keycloak/themes/ryvie/login/resources/img/background.jpg
   ```

2. Modifiez le CSS :
   ```css
   body {
       background: url('../img/background.jpg') no-repeat center center fixed !important;
       background-size: cover !important;
   }
   ```

### Ajouter votre logo

1. Placez votre logo dans :
   ```
   /opt/Ryvie/keycloak/themes/ryvie/login/resources/img/logo.png
   ```

2. Ajoutez dans le CSS :
   ```css
   #kc-header-wrapper::before {
       content: '';
       display: block;
       background: url('../img/logo.png') no-repeat center;
       background-size: contain;
       height: 80px;
       margin-bottom: 20px;
   }
   ```

## 🔄 Appliquer les modifications

Après toute modification CSS ou ajout d'images :

```bash
docker compose -f /opt/Ryvie/keycloak/docker-compose.yml restart keycloak
```

Puis videz le cache du navigateur (Ctrl + Shift + R).

## 📁 Structure du thème

```
/opt/Ryvie/keycloak/themes/ryvie/
├── login/
│   ├── theme.properties          # Configuration du thème
│   └── resources/
│       ├── css/
│       │   └── ryvie-custom.css  # Styles personnalisés
│       └── img/                  # Images (logo, fond, etc.)
```

## ⚠️ Dépannage

### Le thème n'apparaît pas

1. Vérifiez que le thème est bien configuré dans l'interface admin
2. Videz complètement le cache du navigateur (Ctrl + Shift + R)
3. Essayez en navigation privée
4. Redémarrez Keycloak complètement :
   ```bash
   docker compose -f /opt/Ryvie/keycloak/docker-compose.yml restart keycloak
   ```

### Vérifier que le thème est chargé

```bash
docker exec keycloak ls -la /opt/keycloak/themes/ryvie/login/
```

Vous devriez voir `theme.properties` et le dossier `resources/`.
