# Documentation Keycloak SSO - Ryvie

## 📋 Vue d'ensemble

Keycloak est un serveur d'authentification et d'autorisation open-source qui fournit du **Single Sign-On (SSO)** pour Ryvie. Il permet aux utilisateurs de se connecter une seule fois et d'accéder à toutes les applications de l'écosystème Ryvie sans avoir à se reconnecter.

---

## 🏗️ Architecture actuelle

```
┌─────────────────────────────────────────────────────────────┐
│                         Utilisateur                          │
│                    (jules@gmail.com)                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Frontend Ryvie                            │
│              (http://ryvie.local:3000)                       │
│                                                              │
│  • Détecte l'origine de la requête                          │
│  • Redirige vers /api/auth/login                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend Ryvie                             │
│              (http://ryvie.local:3002)                       │
│                                                              │
│  Routes OIDC (/api/auth/*):                                 │
│  • /login  - Génère l'URL d'auth Keycloak                  │
│  • /callback - Reçoit le code d'autorisation                │
│  • /logout - Déconnexion OIDC                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      Keycloak                                │
│              (http://ryvie.local:8080)                       │
│                                                              │
│  Realm: ryvie                                               │
│  Client: ryvie-dashboard                                    │
│                                                              │
│  • Authentifie via LDAP                                     │
│  • Génère des tokens JWT (access_token, id_token)          │
│  • Gère les sessions utilisateur                            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      LDAP Server                             │
│              (ldap://localhost:389)                          │
│                                                              │
│  Base DN: dc=example,dc=org                                 │
│  Users: ou=users,dc=example,dc=org                          │
│  Groups: ou=users,dc=example,dc=org                         │
│                                                              │
│  Groupes:                                                    │
│  • cn=admins,ou=users,dc=example,dc=org                     │
│  • cn=users,ou=users,dc=example,dc=org                      │
│  • cn=guests,ou=users,dc=example,dc=org                     │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔐 Flux d'authentification SSO (OIDC)

### 1. **Initiation de la connexion**

```
Utilisateur clique sur "Se connecter avec SSO"
    ↓
Frontend → GET /api/auth/login
    ↓
Backend détecte l'origine (ex: http://10.128.255.101:3000)
    ↓
Backend génère un state et nonce (sécurité CSRF)
    ↓
Backend construit l'URL Keycloak dynamiquement:
  - issuer: http://10.128.255.101:8080/realms/ryvie
  - redirect_uri: http://10.128.255.101:3002/api/auth/callback
    ↓
Backend redirige vers Keycloak
```

**Code backend** (`/opt/Ryvie/Ryvie-Back/routes/oidcAuth.ts`):
```typescript
router.get('/login', async (req: any, res: any) => {
  const origin = getOriginFromRequest(req);
  const state = generateState();
  const nonce = generateNonce();
  
  stateStore.set(state, { nonce, timestamp: Date.now(), origin });
  
  const authUrl = await generateAuthUrl(state, nonce, origin);
  res.redirect(authUrl);
});
```

### 2. **Authentification Keycloak**

```
Keycloak affiche la page de login
    ↓
Utilisateur entre ses credentials (jules / julespassword)
    ↓
Keycloak vérifie dans LDAP:
  - Recherche: (&(objectClass=inetOrgPerson)(uid=jules))
  - DN trouvé: cn=jules,ou=users,dc=example,dc=org
  - Vérification du mot de passe
    ↓
Keycloak génère un code d'autorisation
    ↓
Keycloak redirige vers: http://10.128.255.101:3002/api/auth/callback?code=xxx&state=yyy
```

### 3. **Callback et échange de tokens**

```
Backend reçoit le code d'autorisation
    ↓
Backend vérifie le state (protection CSRF)
    ↓
Backend échange le code contre des tokens:
  POST http://10.128.255.101:8080/realms/ryvie/protocol/openid-connect/token
  Body:
    - grant_type: authorization_code
    - code: xxx
    - redirect_uri: http://10.128.255.101:3002/api/auth/callback
    - client_id: ryvie-dashboard
    - client_secret: xxx
    ↓
Keycloak retourne:
  - access_token (JWT)
  - id_token (JWT)
  - refresh_token
```

**Code backend** (`/opt/Ryvie/Ryvie-Back/services/oidcService.ts`):
```typescript
export async function exchangeCodeForTokens(code: string, state: string, nonce: string, origin: string) {
  const redirectUri = getBackendRedirectUri(origin);
  const issuer = getIssuerFromOrigin(origin);
  
  const tokenEndpoint = `${issuer}/protocol/openid-connect/token`;
  
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  
  return await response.json();
}
```

### 4. **Récupération des informations utilisateur**

```
Backend récupère les infos utilisateur:
  GET http://10.128.255.101:8080/realms/ryvie/protocol/openid-connect/userinfo
  Header: Authorization: Bearer <access_token>
    ↓
Keycloak retourne:
  - preferred_username: jules
  - email: jules@gmail.com
  - name: jules jules
    ↓
Backend cherche le DN LDAP de l'utilisateur:
  Recherche: (&(objectClass=inetOrgPerson)(uid=jules))
  DN trouvé: cn=jules,ou=users,dc=example,dc=org
    ↓
Backend détermine le rôle via les groupes LDAP:
  Recherche: (&(objectClass=groupOfNames)(member=cn=jules,ou=users,dc=example,dc=org))
  Groupe trouvé: cn=admins,ou=users,dc=example,dc=org
  Rôle: Admin
```

**Code backend** (`/opt/Ryvie/Ryvie-Back/routes/oidcAuth.ts`):
```typescript
const userinfo = await getUserInfo(tokens.accessToken!, origin);
const uid = userinfo.preferred_username || userinfo.sub;

// Chercher le DN LDAP
const ldapClient = ldap.createClient({ url: ldapConfig.url });
const filter = `(&(objectClass=inetOrgPerson)(uid=${uid}))`;
// ... recherche LDAP ...

// Déterminer le rôle
const role = await ldapService.getUserRole(userDN);
// role = 'Admin' si membre de cn=admins
```

### 5. **Création de la session Ryvie**

```
Backend crée un JWT Ryvie:
  {
    uid: 'jules',
    name: 'jules jules',
    email: 'jules@gmail.com',
    role: 'Admin',
    idToken: '<keycloak_id_token>'
  }
    ↓
Backend enregistre le token dans Redis (allowlist)
    ↓
Backend redirige vers le frontend:
  http://10.128.255.101:3000/#/auth-callback?token=<jwt_ryvie>
    ↓
Frontend stocke le token et l'id_token
    ↓
Utilisateur connecté !
```

---

## 🔄 Flux de déconnexion SSO

### 1. **Déconnexion initiée par l'utilisateur**

```
Utilisateur clique sur "Se déconnecter"
    ↓
Frontend récupère l'id_token du localStorage
    ↓
Frontend redirige vers: /api/auth/logout?id_token=xxx
    ↓
Backend détecte l'origine
    ↓
Backend construit l'URL de déconnexion Keycloak:
  http://10.128.255.101:8080/realms/ryvie/protocol/openid-connect/logout
  ?post_logout_redirect_uri=http://10.128.255.101:3000
  &id_token_hint=xxx
    ↓
Keycloak invalide la session
    ↓
Keycloak redirige vers l'origine
    ↓
Utilisateur déconnecté !
```

**Code backend** (`/opt/Ryvie/Ryvie-Back/routes/oidcAuth.ts`):
```typescript
router.get('/logout', async (req: any, res: any) => {
  const idToken = req.query.id_token;
  const origin = getOriginFromRequest(req);
  
  const url = new URL(origin);
  const issuer = `http://${url.hostname}:8080/realms/ryvie`;
  const logoutUrl = `${issuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(origin)}${idToken ? `&id_token_hint=${idToken}` : ''}`;
  
  res.redirect(logoutUrl);
});
```

---

## 🌐 Support multi-origines

Le système supporte dynamiquement plusieurs origines :

### **Origines supportées**

1. **`http://ryvie.local`** (via Caddy)
   - redirect_uri: `http://ryvie.local/api/auth/callback`
   - issuer: `http://ryvie.local:8080/realms/ryvie`

2. **`http://10.128.255.101:3000`** (webpack-dev-server)
   - redirect_uri: `http://10.128.255.101:3002/api/auth/callback`
   - issuer: `http://10.128.255.101:8080/realms/ryvie`

3. **`http://localhost:3000`** (développement local)
   - redirect_uri: `http://localhost:3002/api/auth/callback`
   - issuer: `http://localhost:8080/realms/ryvie`

### **Logique de détection**

**Code backend** (`/opt/Ryvie/Ryvie-Back/services/oidcService.ts`):
```typescript
function getBackendRedirectUri(origin: string): string {
  const url = new URL(origin);
  
  // Si c'est ryvie.local (Caddy), pas de port spécifique
  if (url.hostname === 'ryvie.local' && !url.port) {
    return `http://ryvie.local/api/auth/callback`;
  }
  
  // Si le port est 3000 (webpack-dev-server), utiliser 3002 pour le backend
  if (url.port === '3000') {
    return `http://${url.hostname}:3002/api/auth/callback`;
  }
  
  // Sinon, utiliser le port de l'origine
  const port = url.port || '80';
  return `http://${url.hostname}:${port}/api/auth/callback`;
}

function getIssuerFromOrigin(origin: string): string {
  const url = new URL(origin);
  return `http://${url.hostname}:8080/realms/ryvie`;
}
```

---

## ⚙️ Configuration Keycloak

### **Realm : ryvie**

- **Issuer**: `http://{hostname}:8080/realms/ryvie`
- **User Federation**: LDAP (`ldap://localhost:389`)
- **Base DN**: `ou=users,dc=example,dc=org`

### **Client : ryvie-dashboard**

```json
{
  "clientId": "ryvie-dashboard",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "clientAuthenticatorType": "client-secret",
  "secret": "xxx",
  "redirectUris": [
    "http://ryvie.local/*",
    "http://ryvie.local/api/auth/callback",
    "http://localhost:3000/*",
    "http://10.128.255.101:3000/*",
    "http://10.128.255.101:3002/api/auth/callback",
    "http://*:3000/*",
    "http://*:3002/api/auth/callback"
  ],
  "webOrigins": [
    "http://ryvie.local",
    "http://localhost:3000",
    "http://10.128.255.101:3000",
    "http://*:3000",
    "*"
  ],
  "attributes": {
    "post.logout.redirect.uris": "http://ryvie.local/*##http://localhost:3000/*##http://10.128.255.101:3000/*##http://*:3000/*"
  }
}
```

### **LDAP User Federation**

- **Vendor**: Other
- **Connection URL**: `ldap://localhost:389`
- **Bind DN**: `cn=read-only,ou=users,dc=example,dc=org`
- **Bind Credential**: `readpassword`
- **Users DN**: `ou=users,dc=example,dc=org`
- **User Object Classes**: `inetOrgPerson, posixAccount, shadowAccount`
- **Username LDAP attribute**: `uid`
- **RDN LDAP attribute**: `cn`
- **UUID LDAP attribute**: `entryUUID`

---

## 🔑 Gestion des rôles

### **Mapping LDAP → Ryvie**

Les rôles sont déterminés par l'appartenance aux groupes LDAP :

```typescript
// /opt/Ryvie/Ryvie-Back/services/ldapService.ts
function getRole(dn, groupMemberships) {
  if (groupMemberships.includes('cn=admins,ou=users,dc=example,dc=org')) return 'Admin';
  if (groupMemberships.includes('cn=users,ou=users,dc=example,dc=org')) return 'User';
  if (groupMemberships.includes('cn=guests,ou=users,dc=example,dc=org')) return 'Guest';
  return 'Unknown';
}
```

**Exemple** :
- Jules est membre de `cn=admins,ou=users,dc=example,dc=org`
- → Rôle : **Admin**

---

## 🛠️ API Keycloak Admin

Pour modifier la configuration Keycloak via API :

### **1. Authentification**

```bash
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin" \
  -d "password=changeme123" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | jq -r '.access_token')
```

### **2. Récupérer un client**

```bash
CLIENT_ID=$(curl -s -X GET "http://localhost:8080/admin/realms/ryvie/clients" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.clientId=="ryvie-dashboard") | .id')
```

### **3. Mettre à jour un client**

```bash
curl -s -X PUT "http://localhost:8080/admin/realms/ryvie/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @client-config.json
```

---

## 📊 Résumé des composants

| Composant | Port | Rôle |
|-----------|------|------|
| **Frontend Ryvie** | 3000 | Interface utilisateur |
| **Backend Ryvie** | 3002 | API REST, routes OIDC |
| **Keycloak** | 8080 | Serveur d'authentification SSO |
| **LDAP** | 389 | Annuaire utilisateurs/groupes |
| **Redis** | 6379 | Stockage des tokens allowlistés |

---

## 🎯 Prochaine étape : Intégration rPictures

Pour intégrer rPictures avec Keycloak SSO, il faut :

1. **Créer un nouveau client Keycloak** : `ryvie-rpictures`
2. **Configurer le backend rPictures** pour utiliser Keycloak comme provider OAuth
3. **Implémenter le SSO** : connexion à Ryvie → automatiquement connecté à rPictures

**Objectif** : Un utilisateur connecté à Ryvie (ex: jules) doit pouvoir accéder à rPictures sans avoir à se reconnecter.
