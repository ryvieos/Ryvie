# Guide : Ajouter une application à Keycloak SSO

## 🚀 Méthode rapide : Script automatique

### Ajouter rPictures
```bash
cd /opt/Ryvie/keycloak
./add-client.sh rpictures "rPictures Application" 3013
```

### Ajouter une autre application
```bash
./add-client.sh <client-id> "<nom-application>" <port> [secret-optionnel]
```

**Exemple** :
```bash
./add-client.sh nextcloud "Nextcloud" 8080
./add-client.sh jellyfin "Jellyfin Media Server" 8096
```

Le script va :
1. ✅ Générer un secret aléatoire sécurisé
2. ✅ Ajouter le client dans `/opt/Ryvie/keycloak/import/ryvie-realm.json`
3. ✅ Afficher les variables d'environnement à utiliser

### Appliquer les changements
```bash
docker compose -f /opt/Ryvie/keycloak/docker-compose.yml restart keycloak
```

---

## 📋 Configuration de l'application

Une fois le client ajouté, configurez votre application avec ces variables :

### Pour rPictures (Node.js/Express)
```bash
# .env de rPictures
OIDC_ISSUER=http://ryvie.local:3005/realms/ryvie
OIDC_CLIENT_ID=rpictures
OIDC_CLIENT_SECRET=<secret-généré>
OIDC_REDIRECT_URI=http://ryvie.local:3013/api/auth/callback
```

### Code d'intégration (exemple Node.js)
```javascript
const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');

const app = express();

// Configuration session
app.use(session({
  secret: 'votre-secret-session',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // true en HTTPS
}));

// Initialisation OIDC
let client;

(async () => {
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
  
  client = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    redirect_uris: [process.env.OIDC_REDIRECT_URI],
    response_types: ['code']
  });
})();

// Route de connexion
app.get('/api/auth/login', (req, res) => {
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  
  req.session.code_verifier = code_verifier;
  
  const authUrl = client.authorizationUrl({
    scope: 'openid email profile',
    code_challenge,
    code_challenge_method: 'S256'
  });
  
  res.redirect(authUrl);
});

// Route de callback
app.get('/api/auth/callback', async (req, res) => {
  try {
    const params = client.callbackParams(req);
    const tokenSet = await client.callback(
      process.env.OIDC_REDIRECT_URI,
      params,
      { code_verifier: req.session.code_verifier }
    );
    
    const userinfo = await client.userinfo(tokenSet.access_token);
    
    req.session.user = {
      id: userinfo.sub,
      username: userinfo.preferred_username,
      name: userinfo.name,
      email: userinfo.email
    };
    
    res.redirect('/');
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect('/login?error=auth_failed');
  }
});

// Route de déconnexion
app.get('/api/auth/logout', (req, res) => {
  const id_token = req.session.id_token;
  req.session.destroy();
  
  const logoutUrl = client.endSessionUrl({
    id_token_hint: id_token,
    post_logout_redirect_uri: 'http://ryvie.local:3013'
  });
  
  res.redirect(logoutUrl);
});

app.listen(3013, () => {
  console.log('rPictures listening on port 3013');
});
```

---

## 🔧 Méthode manuelle : Interface admin

### 1. Accéder à Keycloak
```
URL: http://ryvie.local:3005
Login: admin
Password: admin
```

### 2. Créer le client
1. Sélectionnez le realm **"ryvie"**
2. **Clients** → **Create client**
3. Remplissez :
   - **Client ID** : `rpictures`
   - **Name** : `rPictures Application`
   - **Client authentication** : `ON`

### 3. Configurer les URLs
```
Root URL: http://ryvie.local:3013
Valid redirect URIs:
  - http://ryvie.local:3013/*
  - http://ryvie.local:3013/api/auth/callback
  - http://*:3013/*
  - http://*:3013/api/auth/callback

Web origins:
  - http://ryvie.local:3013
  - http://*:3013
```

### 4. Récupérer le secret
Onglet **Credentials** → Copiez le **Client secret**

### 5. Exporter la configuration
```bash
docker exec keycloak /opt/keycloak/bin/kc.sh export \
  --dir /tmp --realm ryvie --users realm_file

docker cp keycloak:/tmp/ryvie-realm.json /opt/Ryvie/keycloak/import/
```

---

## 📊 Vérifier la configuration

### Tester l'endpoint de découverte
```bash
curl http://ryvie.local:3005/realms/ryvie/.well-known/openid-configuration | jq
```

### Lister les clients configurés
```bash
jq '.clients[] | {clientId, name}' /opt/Ryvie/keycloak/import/ryvie-realm.json
```

---

## 🔐 Flux d'authentification

```
1. Utilisateur → rPictures : Clic sur "Se connecter"
2. rPictures → Keycloak : Redirection vers /auth
3. Keycloak → LDAP : Vérification des identifiants
4. Keycloak → rPictures : Redirection avec code
5. rPictures → Keycloak : Échange code contre token
6. rPictures : Utilisateur connecté ✅
```

---

## 📝 Exemples d'applications

### rPictures (Port 3013)
```bash
./add-client.sh rpictures "rPictures Application" 3013
```

### Nextcloud (Port 8080)
```bash
./add-client.sh nextcloud "Nextcloud" 8080
```

### Jellyfin (Port 8096)
```bash
./add-client.sh jellyfin "Jellyfin Media Server" 8096
```

### Vaultwarden (Port 8000)
```bash
./add-client.sh vaultwarden "Vaultwarden Password Manager" 8000
```

---

## 🔑 Synchronisation automatique des secrets

### Pourquoi ?

Keycloak importe le realm JSON au démarrage avec la stratégie **`IGNORE_EXISTING`** :
- **Premier démarrage** : le realm est importé intégralement, secrets inclus
- **Démarrages suivants** : le realm existe en base, le JSON est **ignoré**

Keycloak stocke les secrets **hashés** en interne. Ce hash peut diverger du secret en clair du realm JSON (régénération via l'admin UI, mise à jour de Keycloak, etc.). Quand ça arrive, le backend envoie le bon secret mais Keycloak le rejette → **boucle d'authentification `invalid_client_credentials`**.

### Comment ça fonctionne

Au démarrage du backend, `keycloakService.ts` exécute `syncClientSecrets()` (étape 7b de `ensureKeycloakRunning()`) :

1. Lit le **realm JSON** (`/data/config/keycloak/import/ryvie-realm.json`) — source de vérité
2. Filtre les clients **custom** (ceux avec un `secret`, hors clients internes Keycloak)
3. Pour chaque client, force le secret dans Keycloak via `kcadm.sh update`

Cela **re-hashe** le secret en base pour qu'il corresponde au secret en clair du JSON.

### Impact sur les clients des apps

La sync concerne **tous les clients custom** présents dans le realm JSON :

| Client | Impacté ? | Pourquoi |
|--------|-----------|----------|
| `ryvie-dashboard` | Oui | Client principal du dashboard |
| `ryvie-rpictures`, `ryvie-*` | Oui | Clients créés par `add-client-oauth.sh` |
| `account`, `admin-cli`, etc. | Non | Clients internes Keycloak (filtrés, pas de secret) |

**C'est sans danger** : la sync écrit le **même secret** que celui déjà dans le realm JSON. Si le secret n'a pas changé en base, l'opération est un no-op fonctionnel (Keycloak re-hashe la même valeur).

### Quand un secret est modifié manuellement dans Keycloak

Si vous changez un secret **uniquement via l'admin UI** sans mettre à jour le realm JSON, la sync **écrasera** ce changement au prochain démarrage du backend. Pour éviter ça :

```bash
# Toujours utiliser le script pour modifier un client :
/opt/Ryvie/scripts/add-client-oauth.sh <client-id> "<nom>" <port> [nouveau-secret]

# Ou mettre à jour manuellement le realm JSON après modification dans l'admin UI
```

### Script de sync manuelle

Un script shell est aussi disponible pour forcer la sync sans redémarrer le backend :

```bash
/opt/Ryvie/scripts/sync-keycloak-secrets.sh
```

### Ordre d'exécution au démarrage

```
ensureKeycloakRunning()
  1. Création des dossiers
  2. Synchronisation .env Keycloak
  3. Synchronisation realm JSON + thèmes
  4. Création réseau Docker
  5. Démarrage Keycloak (si pas déjà lancé)
  6. Attente que Keycloak soit prêt
  7. Vérification/création du client ryvie-dashboard
  7b. ← Synchronisation des secrets (syncClientSecrets)
  8. Application du thème ryvie
  9. Provisioning des clients SSO des apps
```

---

## ⚠️ Important

- **Chaque application** doit avoir un **client_id unique**
- **Le secret** doit être gardé confidentiel (ne jamais le commiter)
- **Les redirect URIs** doivent correspondre exactement aux URLs de callback
- **Redémarrez Keycloak** après modification du fichier JSON
- **Le realm JSON est la source de vérité** pour les secrets — toute modification doit y être reflétée
