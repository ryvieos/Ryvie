# Migration vers Keycloak SSO - Guide complet

## Vue d'ensemble

Ce guide détaille la migration de Ryvie d'une authentification LDAP directe vers un système SSO (Single Sign-On) basé sur Keycloak avec OpenID Connect (OIDC). L'objectif est de permettre une connexion unique pour accéder à Ryvie et toutes les applications installées.

## Table des matières

1. [Architecture cible](#architecture-cible)
2. [Prérequis](#prérequis)
3. [Phase 1 : Déploiement de Keycloak](#phase-1--déploiement-de-keycloak)
4. [Phase 2 : Configuration Keycloak](#phase-2--configuration-keycloak)
5. [Phase 3 : Migration Backend Ryvie](#phase-3--migration-backend-ryvie)
6. [Phase 4 : Migration Frontend Ryvie](#phase-4--migration-frontend-ryvie)
7. [Phase 5 : Migration des applications](#phase-5--migration-des-applications)
8. [Tests et validation](#tests-et-validation)
9. [Rollback](#rollback)

---

## Architecture cible

### Phase 1 : Déploiement en mode LOCAL uniquement

**Cette documentation couvre la mise en place initiale de Keycloak SSO en mode local** :

- **Mode LOCAL** : Accès via `ryvie.local` (réseau local, HTTP)
- Le système fonctionne sur le réseau local sans nécessiter de configuration Netbird
- Une fois validé en local, le mode REMOTE (Netbird/HTTPS) pourra être ajouté facilement

**Avantages de commencer en local** :
- ✅ Configuration plus simple (pas de HTTPS, pas de DNS)
- ✅ Tests rapides sur le réseau local
- ✅ Validation du concept SSO avant déploiement remote
- ✅ Migration progressive : local d'abord, remote ensuite

### Système Private/Remote de Ryvie (pour référence future)

**Note** : Ryvie supporte un système de double accès :
- **Mode PRIVATE** : Accès local via `ryvie.local` (cette phase)
- **Mode REMOTE** : Accès distant via domaines Netbird (phase 2, à venir)

Le code backend sera préparé pour supporter les deux modes, mais seul le mode local sera activé initialement.

### Flux d'authentification SSO (mode LOCAL)

```
┌─────────────┐
│ Utilisateur │ Accès via http://ryvie.local
└──────┬──────┘
       │ 1. Accède à Ryvie
       ▼
┌─────────────────────────────────────────┐
│     Ryvie Frontend (ryvie.local)        │
│  - Détecte absence de session           │
│  - Redirige vers Keycloak               │
└──────┬──────────────────────────────────┘
       │ 2. Redirection HTTP
       ▼
┌─────────────────────────────────────────┐
│    Keycloak (http://ryvie.local:8080)   │
│  - Page de connexion unique             │
│  - Vérifie via LDAP local               │
│  - Émet token OIDC                      │
└──────┬──────────────────────────────────┘
       │ 3. Callback avec code
       ▼
┌─────────────────────────────────────────┐
│     Ryvie Backend (ryvie.local)         │
│  - Échange code contre token            │
│  - Crée session utilisateur             │
│  - Redirige vers dashboard              │
└──────┬──────────────────────────────────┘
       │ 4. SSO automatique (même réseau)
       ├──────────────────┬────────────────┐
       ▼                  ▼                ▼
┌─────────────┐   ┌─────────────┐  ┌─────────────┐
│  rpictures  │   │   rdrive    │  │  Autre app  │
│  (local)    │   │  (local)    │  │  (local)    │
│  SSO auto   │   │  SSO auto   │  │  SSO auto   │
└─────────────┘   └─────────────┘  └─────────────┘
```

**Avantage du SSO** : Une seule connexion donne accès à toutes les applications installées !

### Composants (mode LOCAL)

- **Keycloak** : Serveur SSO central
  - Accessible sur `http://ryvie.local:3005`
  - Interface admin : `http://ryvie.local:3005/admin`
- **PostgreSQL** : Base de données Keycloak
- **OpenLDAP** : Source d'identités (via User Federation)
  - Connexion directe depuis Keycloak
- **Ryvie Backend** : Client OIDC principal
  - Accessible sur `http://ryvie.local`
- **Ryvie Frontend** : Interface utilisateur
  - Accessible sur `http://ryvie.local`
- **Applications** : Clients OIDC secondaires
  - rpictures : `http://ryvie.local:3010`
  - rdrive : `http://ryvie.local:3011`
  - etc.

**Note** : Tous les composants communiquent en HTTP sur le réseau local. Le mode HTTPS/Remote sera ajouté dans une phase ultérieure.

---

## Prérequis

### Variables d'environnement à définir

Créer un fichier `.env` ou ajouter à votre configuration existante :

```bash
# Keycloak
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=<mot_de_passe_fort>
KEYCLOAK_DB_PASSWORD=<mot_de_passe_db>

# OIDC pour Ryvie (mode LOCAL)
OIDC_CLIENT_ID=ryvie-dashboard
OIDC_CLIENT_SECRET=<générer_un_secret>
OIDC_ISSUER=http://ryvie.local:3005/realms/ryvie
OIDC_REDIRECT_URI=http://ryvie.local/api/auth/callback

# Frontend URL
FRONTEND_URL=http://ryvie.local

# LDAP existant
LDAP_URL=ldap://openldap:389
LDAP_BIND_DN=cn=read-only,ou=users,dc=example,dc=org
LDAP_BIND_PASSWORD=readpassword
LDAP_USER_SEARCH_BASE=ou=users,dc=example,dc=org
```

**Note** : Pour ajouter le mode REMOTE plus tard, il suffira d'ajouter des variables `*_REMOTE` et de modifier légèrement le code backend pour détecter le mode.

### Dépendances à installer

**Backend (Node.js)** :
```bash
npm install openid-client express-session
```

**Frontend** : Aucune dépendance supplémentaire nécessaire (utilise redirections)

---

## Phase 1 : Déploiement de Keycloak

### 1.1 Créer la structure de fichiers

```bash
mkdir -p keycloak/themes
mkdir -p keycloak/import
```

### 1.2 Docker Compose

Créer ou modifier votre `docker-compose.yml` :

```yaml
version: '3.8'

services:
  # PostgreSQL pour Keycloak
  keycloak-postgres:
    image: postgres:15-alpine
    container_name: keycloak-postgres
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: ${KEYCLOAK_DB_PASSWORD}
    volumes:
      - keycloak-postgres-data:/var/lib/postgresql/data
    networks:
      - ryvie-network
    restart: unless-stopped

  # Keycloak SSO
  keycloak:
    image: quay.io/keycloak/keycloak:26.3
    container_name: keycloak
    environment:
      # Admin
      KEYCLOAK_ADMIN: ${KEYCLOAK_ADMIN}
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}
      
      # Database
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://keycloak-postgres:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: ${KEYCLOAK_DB_PASSWORD}
      
      # Hostname - Désactiver la validation stricte pour supporter private/remote
      KC_HOSTNAME_STRICT: false
      KC_HOSTNAME_STRICT_HTTPS: false
      
      # Proxy (derrière Caddy)
      KC_PROXY: edge
      KC_HTTP_ENABLED: true
      
      # Features
      KC_FEATURES: preview
    volumes:
      - ./keycloak/import:/opt/keycloak/data/import
      - ./keycloak/themes:/opt/keycloak/themes
    # Pas de ports exposés directement - accès via Caddy
    expose:
      - "8080"
    command:
      - start
      - --import-realm
      - --health-enabled=true
    depends_on:
      - keycloak-postgres
      - openldap  # Votre LDAP existant
    networks:
      - ryvie-network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health/ready"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  keycloak-postgres-data:

networks:
  ryvie-network:
    external: true
```

**Note importante** : 
- Le réseau `ryvie-network` doit déjà exister (créé par Ryvie)
- Keycloak utilisera le nom de conteneur `keycloak` pour être accessible depuis Caddy
- Caddy accède à Keycloak via `keycloak:8080` (résolution DNS interne Docker)

### 1.3 Configuration Caddy pour Keycloak

**Ryvie utilise déjà un système Caddy dynamique** qui génère automatiquement le Caddyfile. Il faut modifier le service de reverse proxy pour ajouter Keycloak.

**Modifier** `Ryvie-Back/services/reverseProxyService.ts` :

Dans la fonction `generateCaddyfileContent()` (ligne ~460), ajouter la section Keycloak à la fin du template :

```typescript
function generateCaddyfileContent() {
  return `{
  local_certs
}

# Rediriger HTTPS -> HTTP (évite le forçage HTTPS local)
https://ryvie.local {
  redir http://ryvie.local{uri} permanent
}

# Site local
http://ryvie.local {
  encode gzip

  # 1) Socket.IO (WebSocket support)
  @socketio path /socket.io/*
  reverse_proxy @socketio host.docker.internal:3002 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
  }

  # 2) API Backend (routes /api/* et /status)
  @api path /api/* /status
  reverse_proxy @api host.docker.internal:3002 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
  }

  # 3) Tout le reste vers le frontend (webpack dev)
  reverse_proxy host.docker.internal:3000 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
  }
}

# --- KEYCLOAK SSO ---
ryvie.local:3005 {
  reverse_proxy keycloak:8080 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-Proto {scheme}
    header_up X-Forwarded-Host {host}
  }
}
`;
}
```

**Après modification** :
1. Redémarrer le backend Ryvie : `pm2 restart ryvie-back`
2. Le Caddyfile sera automatiquement régénéré au prochain démarrage
3. Ou forcer la régénération via l'API : `/api/admin/reverse-proxy/reload`

**Note** : Le système Caddy de Ryvie gère automatiquement le rechargement gracieux sans interruption de service.

### 1.3 Démarrer Keycloak

```bash
docker-compose up -d keycloak-postgres keycloak
docker-compose logs -f keycloak
```

Attendre que Keycloak soit prêt (message "Keycloak started").

### 1.4 Accéder à l'interface admin

- URL : `http://localhost:8080` (ou votre domaine)
- Username : `admin`
- Password : `${KEYCLOAK_ADMIN_PASSWORD}`

---

## Phase 2 : Configuration Keycloak

### 2.1 Créer le realm "ryvie"

**Via l'interface web** :
1. Cliquer sur le menu déroulant "master" (en haut à gauche)
2. Cliquer sur "Create Realm"
3. Nom : `ryvie`
4. Enabled : `ON`
5. Cliquer sur "Create"

**Ou via fichier d'import** (`keycloak/import/ryvie-realm.json`) :

```json
{
  "realm": "ryvie",
  "enabled": true,
  "displayName": "Ryvie Authentication",
  "displayNameHtml": "<div class=\"kc-logo-text\"><span>Ryvie</span></div>",
  "loginTheme": "keycloak",
  "accountTheme": "keycloak",
  "adminTheme": "keycloak",
  "emailTheme": "keycloak",
  
  "sslRequired": "external",
  "registrationAllowed": false,
  "registrationEmailAsUsername": false,
  "rememberMe": true,
  "verifyEmail": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "resetPasswordAllowed": true,
  "editUsernameAllowed": false,
  
  "bruteForceProtected": true,
  "permanentLockout": false,
  "maxFailureWaitSeconds": 900,
  "minimumQuickLoginWaitSeconds": 60,
  "waitIncrementSeconds": 60,
  "quickLoginCheckMilliSeconds": 1000,
  "maxDeltaTimeSeconds": 43200,
  "failureFactor": 5,
  
  "accessTokenLifespan": 300,
  "accessTokenLifespanForImplicitFlow": 900,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 36000,
  "offlineSessionIdleTimeout": 2592000,
  "accessCodeLifespan": 60,
  "accessCodeLifespanUserAction": 300,
  "accessCodeLifespanLogin": 1800,
  
  "roles": {
    "realm": [
      {
        "name": "Admin",
        "description": "Administrator role"
      },
      {
        "name": "User",
        "description": "Standard user role"
      },
      {
        "name": "Guest",
        "description": "Guest role with limited access"
      }
    ]
  }
}
```

### 2.2 Configurer la connexion LDAP

**Via l'interface web** :
1. Aller dans le realm "ryvie"
2. Menu : **User Federation** → **Add provider** → **ldap**
3. Configuration :

```
General Options:
  - Console Display Name: LDAP Ryvie
  - Priority: 0
  - Enabled: ON
  - Import Users: ON
  - Edit Mode: READ_ONLY (ou WRITABLE si vous voulez modifier LDAP)
  - Sync Registrations: OFF

Connection and Authentication:
  - Connection URL: ldap://openldap:389
  - Bind Type: simple
  - Bind DN: cn=read-only,ou=users,dc=example,dc=org
  - Bind Credential: readpassword
  - Test Connection: [Cliquer pour tester]
  - Test Authentication: [Cliquer pour tester]

LDAP Searching and Updating:
  - Users DN: ou=users,dc=example,dc=org
  - Username LDAP attribute: uid
  - RDN LDAP attribute: uid
  - UUID LDAP attribute: entryUUID
  - User Object Classes: inetOrgPerson, posixAccount
  - User LDAP Filter: (objectClass=inetOrgPerson)
  - Search Scope: Subtree

Synchronization Settings:
  - Periodic Full Sync: ON
  - Full Sync Period: 86400 (1 jour)
  - Periodic Changed Users Sync: ON
  - Changed Users Sync Period: 3600 (1 heure)
```

4. Cliquer sur **Save**
5. Cliquer sur **Synchronize all users** pour importer les utilisateurs

### 2.3 Mapper les attributs LDAP

Dans **User Federation** → **ldap** → **Mappers**, créer les mappers suivants :

**Mapper 1 : email**
```
Name: email
Mapper Type: user-attribute-ldap-mapper
User Model Attribute: email
LDAP Attribute: mail
Read Only: ON
Always Read Value From LDAP: ON
Is Mandatory In LDAP: OFF
```

**Mapper 2 : first name**
```
Name: first name
Mapper Type: user-attribute-ldap-mapper
User Model Attribute: firstName
LDAP Attribute: givenName
Read Only: ON
```

**Mapper 3 : last name**
```
Name: last name
Mapper Type: user-attribute-ldap-mapper
User Model Attribute: lastName
LDAP Attribute: sn
Read Only: ON
```

**Mapper 4 : full name**
```
Name: full name
Mapper Type: full-name-ldap-mapper
LDAP Full Name Attribute: cn
Read Only: ON
```

**Mapper 5 : groups (pour les rôles)**
```
Name: groups
Mapper Type: group-ldap-mapper
LDAP Groups DN: ou=users,dc=example,dc=org
Group Name LDAP Attribute: cn
Group Object Classes: groupOfNames
Membership LDAP Attribute: member
Membership Attribute Type: DN
User Groups Retrieve Strategy: LOAD_GROUPS_BY_MEMBER_ATTRIBUTE
Member-Of LDAP Attribute: memberOf
Mapped Group Attributes: 
Mode: READ_ONLY
Drop non-existing groups during sync: OFF
```

### 2.4 Créer le client OIDC pour Ryvie

**Via l'interface web** :
1. Menu : **Clients** → **Create client**
2. Configuration :

**General Settings** :
```
Client type: OpenID Connect
Client ID: ryvie-dashboard
Name: Ryvie Dashboard
Description: Main Ryvie application
Always display in console: ON
```

**Capability config** :
```
Client authentication: ON
Authorization: OFF
Authentication flow:
  ✓ Standard flow
  ✓ Direct access grants
  ☐ Implicit flow
  ☐ Service accounts roles
```

**Login settings** :
```
Root URL: http://ryvie.local
Home URL: http://ryvie.local

Valid redirect URIs :
  - http://ryvie.local/*
  - http://ryvie.local/api/auth/callback
  - http://localhost:3000/* (dev frontend, optionnel)
  - http://localhost:3001/api/auth/callback (dev backend, optionnel)

Valid post logout redirect URIs:
  - http://ryvie.local
  - http://ryvie.local/login

Web origins (CORS):
  - http://ryvie.local
  - http://ryvie.local:3000 (dev, optionnel)
  - http://localhost:3000 (dev, optionnel)
  - http://localhost:3001 (dev, optionnel)
```

**Note** : Pour ajouter le mode REMOTE plus tard, il suffira d'ajouter les URLs `https://*.ryvie.fr` dans cette configuration.

3. Cliquer sur **Save**
4. Aller dans l'onglet **Credentials**
5. Copier le **Client secret** (à mettre dans `OIDC_CLIENT_SECRET`)

### 2.5 Configurer les mappers de rôles

Dans **Clients** → **ryvie-dashboard** → **Client scopes** → **ryvie-dashboard-dedicated** → **Mappers** :

**Mapper : roles**
```
Name: roles
Mapper Type: User Realm Role
Token Claim Name: roles
Claim JSON Type: String
Add to ID token: ON
Add to access token: ON
Add to userinfo: ON
```

**Mapper : groups**
```
Name: groups
Mapper Type: Group Membership
Token Claim Name: groups
Full group path: OFF
Add to ID token: ON
Add to access token: ON
Add to userinfo: ON
```

### 2.6 Mapper les groupes LDAP vers les rôles Keycloak

1. Menu : **Realm roles** → Créer les rôles si nécessaire (Admin, User, Guest)
2. Menu : **Groups** → Créer les groupes correspondants :
   - `admins` → Assigner le rôle `Admin`
   - `users` → Assigner le rôle `User`
   - `guests` → Assigner le rôle `Guest`

---

## Phase 3 : Migration Backend Ryvie

### 3.1 Installer les dépendances

```bash
cd Ryvie-Back
npm install openid-client express-session
```

### 3.2 Créer le service OIDC

Créer `Ryvie-Back/services/oidcService.ts` :

```typescript
import { Issuer, Client, generators } from 'openid-client';

let oidcClient: Client | null = null;

interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// Configuration OIDC (mode LOCAL pour l'instant)
const config: OIDCConfig = {
  issuer: process.env.OIDC_ISSUER || 'http://ryvie.local:8080/realms/ryvie',
  clientId: process.env.OIDC_CLIENT_ID || 'ryvie-dashboard',
  clientSecret: process.env.OIDC_CLIENT_SECRET || '',
  redirectUri: process.env.OIDC_REDIRECT_URI || 'http://ryvie.local/api/auth/callback',
};

/**
 * Initialise et retourne le client OIDC
 */
export async function getOIDCClient(): Promise<Client> {
  if (oidcClient) {
    return oidcClient;
  }

  try {
    const issuer = await Issuer.discover(config.issuer);
    console.log('[OIDC] Discovered issuer:', issuer.metadata.issuer);

    oidcClient = new issuer.Client({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uris: [config.redirectUri],
      response_types: ['code'],
    });

    return oidcClient;
  } catch (error: any) {
    console.error('[OIDC] Failed to initialize client:', error.message);
    throw new Error('OIDC initialization failed');
  }
}

export function generateAuthUrl(state: string, nonce: string): string {
  if (!oidcClient) {
    throw new Error('OIDC client not initialized');
  }

  const authUrl = oidcClient.authorizationUrl({
    scope: 'openid email profile',
    state,
    nonce,
  });

  return authUrl;
}

export async function exchangeCodeForTokens(code: string, state: string, nonce: string) {
  const client = await getOIDCClient();

  const tokenSet = await client.callback(config.redirectUri, { code, state }, { nonce, state });

  return {
    accessToken: tokenSet.access_token,
    idToken: tokenSet.id_token,
    refreshToken: tokenSet.refresh_token,
    expiresIn: tokenSet.expires_in,
    claims: tokenSet.claims(),
  };
}

export async function getUserInfo(accessToken: string) {
  const client = await getOIDCClient();
  const userinfo = await client.userinfo(accessToken);
  return userinfo;
}

export async function refreshAccessToken(refreshToken: string) {
  const client = await getOIDCClient();
  const tokenSet = await client.refresh(refreshToken);
  
  return {
    accessToken: tokenSet.access_token,
    idToken: tokenSet.id_token,
    refreshToken: tokenSet.refresh_token,
    expiresIn: tokenSet.expires_in,
  };
}

export function generateState(): string {
  return generators.state();
}

export function generateNonce(): string {
  return generators.nonce();
}
```

### 3.3 Créer les routes d'authentification OIDC

Créer `Ryvie-Back/routes/oidcAuth.ts` :

```typescript
import express from 'express';
import {
  getOIDCClient,
  generateAuthUrl,
  exchangeCodeForTokens,
  getUserInfo,
  generateState,
  generateNonce,
} from '../services/oidcService';
import { signToken, allowlistToken } from '../services/authService';

const router = express.Router();

// Stockage temporaire des états (en production, utiliser Redis)
const stateStore = new Map<string, { nonce: string; timestamp: number }>();

// Nettoyer les états expirés toutes les 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.timestamp > 5 * 60 * 1000) {
      stateStore.delete(state);
    }
  }
}, 5 * 60 * 1000);

// GET /api/auth/login - Initier l'authentification OIDC
router.get('/login', async (req: any, res: any) => {
  try {
    // Initialiser le client OIDC
    await getOIDCClient();

    const state = generateState();
    const nonce = generateNonce();

    // Stocker state et nonce pour validation
    stateStore.set(state, { nonce, timestamp: Date.now() });

    const authUrl = generateAuthUrl(state, nonce);
    
    console.log('[OIDC] Redirecting to Keycloak:', authUrl);
    res.redirect(authUrl);
  } catch (error: any) {
    console.error('[OIDC] Login error:', error.message);
    res.status(500).json({ error: 'Failed to initiate authentication' });
  }
});

// GET /api/auth/callback - Callback après authentification Keycloak
router.get('/callback', async (req: any, res: any) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state' });
    }

    // Vérifier le state
    const storedData = stateStore.get(state as string);
    if (!storedData) {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }

    const { nonce } = storedData;
    stateStore.delete(state as string);

    // Échanger le code contre des tokens
    const tokens = await exchangeCodeForTokens(code as string, state as string, nonce);
    
    // Récupérer les informations utilisateur
    const userinfo = await getUserInfo(tokens.accessToken!);

    // Mapper les rôles depuis les claims
    const roles = tokens.claims.roles || tokens.claims.realm_access?.roles || [];
    const role = roles.includes('Admin') ? 'Admin' : roles.includes('User') ? 'User' : 'Guest';

    // Créer l'objet utilisateur
    const user = {
      uid: userinfo.preferred_username || userinfo.sub,
      name: userinfo.name || userinfo.preferred_username,
      email: userinfo.email,
      role,
      language: userinfo.locale || 'fr',
    };

    // Générer un JWT interne pour Ryvie
    const token = signToken(user);
    await allowlistToken(token, user);

    console.log(`[OIDC] Authentication successful for ${user.uid} (role: ${role})`);

    // Rediriger vers le frontend
    const frontendUrl = process.env.FRONTEND_URL || 'http://ryvie.local';
    res.redirect(`${frontendUrl}/#/auth-callback?token=${token}`);
  } catch (error: any) {
    console.error('[OIDC] Callback error:', error.message);
    const frontendUrl = process.env.FRONTEND_URL || 'http://ryvie.local';
    res.redirect(`${frontendUrl}/#/login?error=auth_failed`);
  }
});

// GET /api/auth/logout - Déconnexion SSO
router.get('/logout', async (req: any, res: any) => {
  try {
    // Détecter le mode
    const mode = detectAccessMode(req);
    console.log(`[OIDC] Logout request in ${mode.toUpperCase()} mode`);

    const client = await getOIDCClient(mode);
    const idToken = req.query.id_token;

    // URL de redirection après déconnexion selon le mode
    const postLogoutRedirectUri = mode === 'private'
      ? (process.env.FRONTEND_URL_PRIVATE || 'http://ryvie.local')
      : (process.env.FRONTEND_URL_REMOTE || 'https://app.ryvie.fr');

    const logoutUrl = client.endSessionUrl({
      id_token_hint: idToken,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });

    console.log(`[OIDC] Logging out (${mode}), redirecting to:`, logoutUrl);
    res.redirect(logoutUrl);
  } catch (error: any) {
    console.error('[OIDC] Logout error:', error.message);
    
    // Fallback selon le mode
    const mode = detectAccessMode(req);
    const fallbackUrl = mode === 'private' ? 'http://ryvie.local' : 'https://app.ryvie.fr';
    res.redirect(fallbackUrl);
  }
});

export = router;
```

### 3.4 Intégrer les routes OIDC

Modifier `Ryvie-Back/index.ts` pour ajouter les routes OIDC :

```typescript
// Importer les routes OIDC
const oidcAuthRoutes = require('./routes/oidcAuth');

// Ajouter les routes (avant les routes existantes)
app.use('/api/auth', oidcAuthRoutes);

// Garder les routes LDAP existantes pour compatibilité (optionnel)
// app.use('/api', authRoutes); // Routes LDAP legacy
```

### 3.5 Variables d'environnement

Ajouter dans `.env` ou votre système de configuration :

```bash
# OIDC Configuration
OIDC_ISSUER=http://localhost:8080/realms/ryvie
OIDC_CLIENT_ID=ryvie-dashboard
OIDC_CLIENT_SECRET=<votre_client_secret>
OIDC_REDIRECT_URI=http://localhost:3001/api/auth/callback

# Frontend URL
FRONTEND_URL=http://localhost:3000
```

---

## Phase 4 : Migration Frontend Ryvie

### 4.1 Créer la page de callback

Créer `Ryvie-Front/src/pages/AuthCallback.tsx` :

```typescript
import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { startSession } from '../utils/sessionManager';

const AuthCallback = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');

  useEffect(() => {
    const handleCallback = () => {
      // Extraire le token depuis l'URL hash
      const hash = location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const token = params.get('token');
      const errorParam = params.get('error');

      if (errorParam) {
        setError('Erreur d\'authentification. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      if (!token) {
        setError('Token manquant. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      try {
        // Décoder le JWT pour extraire les informations utilisateur
        const payload = JSON.parse(atob(token.split('.')[1]));

        // Démarrer la session
        startSession({
          token,
          userId: payload.uid,
          userName: payload.name,
          userRole: payload.role,
          userEmail: payload.email,
        });

        console.log('[AuthCallback] Session démarrée pour', payload.uid);

        // Rediriger vers le dashboard
        navigate('/welcome', { replace: true });
      } catch (error) {
        console.error('[AuthCallback] Erreur lors du traitement du token:', error);
        setError('Erreur lors de la connexion. Veuillez réessayer.');
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    handleCallback();
  }, [location, navigate]);

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100vh',
      flexDirection: 'column',
      gap: '20px'
    }}>
      {error ? (
        <>
          <div style={{ color: 'red', fontSize: '18px' }}>{error}</div>
          <div>Redirection vers la page de connexion...</div>
        </>
      ) : (
        <>
          <div className="spinner"></div>
          <div>Authentification en cours...</div>
        </>
      )}
    </div>
  );
};

export default AuthCallback;
```

### 4.2 Modifier la page de login

Modifier `Ryvie-Front/src/pages/Login.tsx` pour utiliser OIDC **en conservant le système de détection private/remote** :

```typescript
// La détection du mode accessMode est déjà présente dans Login.tsx
// Il suffit de modifier la fonction handleLogin pour utiliser OIDC

const handleLogin = async (e: React.FormEvent) => {
  e.preventDefault();
  
  setLoading(true);
  setMessage(t('login.redirectingToSSO'));
  setMessageType('info');

  try {
    // Utiliser l'URL du serveur en fonction du mode d'accès (déjà existant)
    const serverUrl = getServerUrl(accessMode); // accessMode = 'private' ou 'remote'
    
    console.log(`[Login] Redirection SSO en mode ${accessMode.toUpperCase()}: ${serverUrl}`);
    
    // Rediriger vers l'endpoint OIDC du backend
    // Le backend détectera automatiquement le mode et utilisera le bon Keycloak
    window.location.href = `${serverUrl}/api/auth/login`;
  } catch (error: any) {
    console.error('Erreur de redirection SSO:', error);
    setMessage(t('login.ssoError'));
    setMessageType('error');
    setLoading(false);
  }
};

// Modifier le formulaire pour afficher un bouton SSO :

<form onSubmit={handleLogin} className="login-form">
  <button 
    type="submit" 
    className="login-button sso-button"
    disabled={loading}
  >
    {loading ? t('login.redirecting') : t('login.signInWithSSO')}
  </button>
  
  {/* Badge indiquant le mode actuel */}
  <div style={{ marginTop: '10px', fontSize: '12px', color: '#666', textAlign: 'center' }}>
    Mode: {accessMode === 'remote' ? 'Remote (Netbird)' : 'Private (Local)'}
  </div>
  
  {/* Optionnel : Garder le formulaire classique pour fallback/dev */}
  <details style={{ marginTop: '20px' }}>
    <summary style={{ cursor: 'pointer', color: '#666' }}>
      {t('login.useClassicLogin')}
    </summary>
    <div style={{ marginTop: '10px' }}>
      {/* Formulaire classique LDAP existant (pour fallback) */}
      <div className="form-group">
        <label htmlFor="username">{t('login.username')}</label>
        <input
          type="text"
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('login.usernamePlaceholder')}
        />
      </div>
      
      <div className="form-group">
        <label htmlFor="password">{t('login.password')}</label>
        <input
          type="password"
          id="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('login.passwordPlaceholder')}
        />
      </div>
      
      <button type="button" onClick={handleLdapLogin} className="login-button">
        {t('login.signInLDAP')}
      </button>
    </div>
  </details>
</form>

// Conserver la fonction handleLdapLogin existante pour le fallback
const handleLdapLogin = async () => {
  // Code existant de Login.tsx pour LDAP
  // ...
};
```

**Points clés** :
- ✅ Le système de détection `accessMode` existant est **conservé** (pour compatibilité future)
- ✅ La fonction `getServerUrl(accessMode)` continue de fonctionner
- ✅ Pour l'instant, seul le mode local est utilisé
- ✅ Le toggle private/remote peut être **masqué temporairement** ou laissé visible
- ✅ Pas besoin de modifier `detectAccessMode.ts` ou `urls.ts`

**Note** : Le badge "Mode: Private (Local)" peut être affiché pour information, mais le mode remote n'est pas encore actif.

### 4.3 Ajouter la route de callback

Modifier `Ryvie-Front/src/App.tsx` (ou votre fichier de routes) :

```typescript
import AuthCallback from './pages/AuthCallback';

// Dans vos routes :
<Route path="/auth-callback" element={<AuthCallback />} />
```

### 4.4 Ajouter les traductions

Modifier `Ryvie-Front/src/i18n/fr.json` :

```json
{
  "login": {
    "signInWithSSO": "Se connecter avec SSO",
    "redirectingToSSO": "Redirection vers l'authentification...",
    "redirecting": "Redirection...",
    "ssoError": "Erreur lors de la redirection SSO",
    "useClassicLogin": "Utiliser la connexion classique"
  }
}
```

Modifier `Ryvie-Front/src/i18n/en.json` :

```json
{
  "login": {
    "signInWithSSO": "Sign in with SSO",
    "redirectingToSSO": "Redirecting to authentication...",
    "redirecting": "Redirecting...",
    "ssoError": "SSO redirection error",
    "useClassicLogin": "Use classic login"
  }
}
```

### 4.5 Gérer la déconnexion SSO

Modifier le composant de déconnexion pour inclure la déconnexion SSO :

```typescript
const handleLogout = async () => {
  try {
    const token = localStorage.getItem('token');
    const idToken = localStorage.getItem('id_token'); // Si stocké
    
    // Déconnexion locale
    localStorage.clear();
    sessionStorage.clear();
    
    // Déconnexion SSO
    const serverUrl = getServerUrl(accessMode);
    window.location.href = `${serverUrl}/api/auth/logout${idToken ? `?id_token=${idToken}` : ''}`;
  } catch (error) {
    console.error('Erreur de déconnexion:', error);
    navigate('/login');
  }
};
```

---

## Phase 5 : Migration des applications

### 5.1 Créer des clients OIDC pour chaque application

Pour chaque application (rpictures, rdrive, etc.), créer un client dans Keycloak :

**Exemple pour rpictures** :

1. **Clients** → **Create client**
2. Configuration :
   - Client ID: `rpictures`
   - Client authentication: ON
   - Valid redirect URIs: `https://rpictures.votre-domaine.com/*`
   - Web origins: `https://rpictures.votre-domaine.com`

3. Copier le **Client secret**

### 5.2 Configurer chaque application

Chaque application doit être configurée pour utiliser OIDC. Voici des exemples pour différents frameworks :

#### **Application Node.js/Express**

```javascript
const { Issuer } = require('openid-client');

async function setupOIDC() {
  const issuer = await Issuer.discover('http://keycloak:8080/realms/ryvie');
  
  const client = new issuer.Client({
    client_id: 'rpictures',
    client_secret: process.env.OIDC_CLIENT_SECRET,
    redirect_uris: ['https://rpictures.votre-domaine.com/callback'],
    response_types: ['code'],
  });

  return client;
}
```

#### **Application Python/Django**

Installer `mozilla-django-oidc` :

```bash
pip install mozilla-django-oidc
```

Configuration `settings.py` :

```python
AUTHENTICATION_BACKENDS = [
    'mozilla_django_oidc.auth.OIDCAuthenticationBackend',
]

OIDC_RP_CLIENT_ID = 'rpictures'
OIDC_RP_CLIENT_SECRET = os.environ.get('OIDC_CLIENT_SECRET')
OIDC_OP_AUTHORIZATION_ENDPOINT = 'http://keycloak:8080/realms/ryvie/protocol/openid-connect/auth'
OIDC_OP_TOKEN_ENDPOINT = 'http://keycloak:8080/realms/ryvie/protocol/openid-connect/token'
OIDC_OP_USER_ENDPOINT = 'http://keycloak:8080/realms/ryvie/protocol/openid-connect/userinfo'
OIDC_OP_JWKS_ENDPOINT = 'http://keycloak:8080/realms/ryvie/protocol/openid-connect/certs'
```

#### **Application PHP**

Utiliser une bibliothèque comme `jumbojett/openid-connect-php` :

```php
use Jumbojett\OpenIDConnectClient;

$oidc = new OpenIDConnectClient(
    'http://keycloak:8080/realms/ryvie',
    'rpictures',
    getenv('OIDC_CLIENT_SECRET')
);

$oidc->authenticate();
$userInfo = $oidc->requestUserInfo();
```

### 5.3 Supprimer l'authentification LDAP des applications

Une fois OIDC configuré, supprimer les appels LDAP directs dans chaque application :

- Supprimer les bibliothèques LDAP (`ldapjs`, `python-ldap`, etc.)
- Supprimer les endpoints de synchronisation LDAP
- Supprimer les configurations LDAP

### 5.4 Tester le SSO entre applications

1. Se connecter à Ryvie Dashboard
2. Cliquer sur une application (rpictures, rdrive)
3. Vérifier que l'accès est automatique (pas de nouvelle connexion)

---

## Tests et validation

### 6.1 Tests d'authentification

**Test 1 : Connexion initiale**
```bash
# Accéder à Ryvie
curl -I http://localhost:3000

# Vérifier la redirection vers Keycloak
# Devrait rediriger vers http://localhost:8080/realms/ryvie/protocol/openid-connect/auth
```

**Test 2 : Callback**
```bash
# Simuler un callback avec un code
curl "http://localhost:3001/api/auth/callback?code=test&state=test"
```

**Test 3 : Vérifier les utilisateurs LDAP**
```bash
# Dans Keycloak, aller dans Users et vérifier que les utilisateurs LDAP sont importés
```

### 6.2 Tests SSO

**Test 1 : SSO entre applications (mode PRIVATE)**
1. Accéder à `http://ryvie.local`
2. Se connecter via Keycloak
3. Ouvrir rpictures dans un nouvel onglet
4. Vérifier l'accès automatique sans nouvelle connexion

**Test 2 : SSO entre applications (mode REMOTE)**
1. Accéder à `https://app.ryvie.fr`
2. Se connecter via Keycloak
3. Ouvrir rpictures dans un nouvel onglet
4. Vérifier l'accès automatique sans nouvelle connexion

**Test 3 : Déconnexion SSO (mode PRIVATE)**
1. Se déconnecter de Ryvie en mode private
2. Vérifier la redirection vers `http://ryvie.local:8080` (Keycloak local)
3. Vérifier que rpictures demande aussi une nouvelle connexion

**Test 4 : Déconnexion SSO (mode REMOTE)**
1. Se déconnecter de Ryvie en mode remote
2. Vérifier la redirection vers `https://auth.ryvie.fr` (Keycloak remote)
3. Vérifier que rpictures demande aussi une nouvelle connexion

### 6.3 Tests de bascule Private/Remote

**Test 1 : Connexion en PRIVATE puis accès en REMOTE**
1. Se connecter via `http://ryvie.local`
2. Accéder à `https://app.ryvie.fr`
3. **Résultat attendu** : Nouvelle authentification requise (sessions séparées)

**Test 2 : Connexion en REMOTE puis accès en PRIVATE**
1. Se connecter via `https://app.ryvie.fr`
2. Accéder à `http://ryvie.local`
3. **Résultat attendu** : Nouvelle authentification requise (sessions séparées)

**Test 3 : Toggle du mode pendant la session**
1. Se connecter en mode private
2. Utiliser le toggle pour basculer en remote
3. **Résultat attendu** : Redirection et nouvelle authentification

**Note** : Les sessions private et remote sont **indépendantes** car elles utilisent des domaines différents (cookies séparés).

### 6.3 Tests de rôles

**Test 1 : Rôle Admin**
```bash
# Se connecter avec un utilisateur admin
# Vérifier l'accès aux fonctionnalités admin
```

**Test 2 : Rôle User**
```bash
# Se connecter avec un utilisateur standard
# Vérifier les restrictions d'accès
```

### 6.4 Tests de performance

**Test 1 : Temps de connexion**
```bash
# Mesurer le temps entre le clic sur "Se connecter" et l'accès au dashboard
# Devrait être < 3 secondes
```

**Test 2 : Charge**
```bash
# Simuler 100 connexions simultanées
ab -n 100 -c 10 http://localhost:3001/api/auth/login
```

---

## Rollback

### 7.1 Rollback complet vers LDAP

Si nécessaire, revenir à l'authentification LDAP :

**Backend** :
```typescript
// Dans index.ts, réactiver les routes LDAP
app.use('/api', authRoutes); // Routes LDAP
// app.use('/api/auth', oidcAuthRoutes); // Désactiver OIDC
```

**Frontend** :
```typescript
// Restaurer l'ancien Login.tsx depuis Git
git checkout HEAD~1 -- Ryvie-Front/src/pages/Login.tsx
```

**Docker** :
```bash
# Arrêter Keycloak
docker-compose stop keycloak keycloak-postgres
```

### 7.2 Rollback partiel (coexistence)

Garder les deux systèmes en parallèle :

```typescript
// Routes backend
app.use('/api/auth', oidcAuthRoutes); // OIDC
app.use('/api', authRoutes); // LDAP legacy

// Frontend : Offrir le choix à l'utilisateur
<button onClick={() => window.location.href = '/api/auth/login'}>
  SSO
</button>
<button onClick={handleLdapLogin}>
  LDAP
</button>
```

---

## Checklist de migration

### Avant la migration

- [ ] Sauvegarder la base de données LDAP
- [ ] Documenter les utilisateurs et rôles existants
- [ ] Tester Keycloak en environnement de dev
- [ ] Préparer un plan de rollback
- [ ] Informer les utilisateurs de la migration

### Pendant la migration

- [ ] Déployer Keycloak avec PostgreSQL
- [ ] Configurer la connexion LDAP
- [ ] Synchroniser les utilisateurs
- [ ] Créer les clients OIDC
- [ ] Migrer le backend Ryvie
- [ ] Migrer le frontend Ryvie
- [ ] Tester l'authentification complète
- [ ] Migrer les applications une par une

### Après la migration

- [ ] Vérifier que tous les utilisateurs peuvent se connecter
- [ ] Tester le SSO entre toutes les applications
- [ ] Monitorer les logs Keycloak
- [ ] Vérifier les performances
- [ ] Documenter la nouvelle architecture
- [ ] Former les administrateurs à Keycloak

---

## Troubleshooting

### Problèmes spécifiques Private/Remote

#### Problème : "Invalid redirect URI" en mode PRIVATE

**Cause** : L'URI `http://ryvie.local/api/auth/callback` n'est pas dans la liste

**Solution** :
1. Aller dans Keycloak → Clients → ryvie-dashboard → Settings
2. Vérifier que `http://ryvie.local/*` est dans "Valid redirect URIs"
3. Vérifier que `http://ryvie.local` est dans "Web origins"
4. Sauvegarder et vider le cache du navigateur

#### Problème : "Invalid redirect URI" en mode REMOTE

**Cause** : L'URI `https://status.ryvie.fr/api/auth/callback` n'est pas dans la liste

**Solution** :
1. Aller dans Keycloak → Clients → ryvie-dashboard → Settings
2. Vérifier que `https://status.ryvie.fr/*` est dans "Valid redirect URIs"
3. Vérifier que `https://*.ryvie.fr` est dans "Web origins"
4. Sauvegarder

#### Problème : Keycloak inaccessible en mode PRIVATE

**Cause** : Caddy ne route pas correctement vers Keycloak

**Solution** :
```bash
# Vérifier que Keycloak est accessible
curl http://ryvie.local:8080/health/ready

# Vérifier les logs Caddy
docker logs caddy

# Vérifier la configuration Caddy
docker exec caddy caddy fmt /etc/caddy/Caddyfile

# Recharger Caddy
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

#### Problème : Keycloak inaccessible en mode REMOTE

**Cause** : DNS Netbird ou certificat TLS incorrect

**Solution** :
```bash
# Vérifier la résolution DNS
nslookup auth.ryvie.fr

# Vérifier le certificat
curl -v https://auth.ryvie.fr/health/ready

# Vérifier les logs Keycloak
docker logs keycloak | grep -i error

# Vérifier la configuration Netbird
cat /config/netbird-data.json
```

#### Problème : Boucle de redirection entre modes

**Cause** : Le mode détecté ne correspond pas à l'URL d'accès

**Solution** :
1. Vider le localStorage : `localStorage.clear()`
2. Vérifier la fonction `detectModeFromUrl()` dans `detectAccessMode.ts`
3. Vérifier que `KC_HOSTNAME_STRICT=false` dans Keycloak
4. Vérifier les headers `X-Forwarded-*` dans Caddy

#### Problème : Session perdue lors du changement de mode

**Cause** : Normal - les sessions private et remote sont indépendantes

**Explication** :
- Mode PRIVATE : cookies sur domaine `ryvie.local`
- Mode REMOTE : cookies sur domaine `*.ryvie.fr`
- Les cookies ne sont pas partagés entre domaines différents

**Solution** : C'est le comportement attendu. L'utilisateur doit se reconnecter lors du changement de mode.

### Problème : "Invalid redirect URI"

**Cause** : L'URI de callback n'est pas dans la liste des URIs valides

**Solution** :
1. Aller dans Keycloak → Clients → ryvie-dashboard
2. Ajouter l'URI exacte dans "Valid redirect URIs"
3. Sauvegarder

### Problème : "Invalid state"

**Cause** : Le state a expiré ou est incorrect

**Solution** :
- Vérifier que le stockage du state fonctionne (utiliser Redis en production)
- Augmenter la durée de validité du state
- Vérifier l'horloge du serveur (NTP)

### Problème : Utilisateurs LDAP non importés

**Cause** : Configuration LDAP incorrecte

**Solution** :
1. Tester la connexion LDAP dans Keycloak
2. Vérifier le filtre LDAP
3. Lancer une synchronisation manuelle
4. Vérifier les logs Keycloak

### Problème : Rôles non mappés

**Cause** : Mapper de groupes mal configuré

**Solution** :
1. Vérifier le mapper "groups" dans User Federation
2. Vérifier que les groupes LDAP existent
3. Assigner manuellement les rôles dans Keycloak

### Problème : Boucle de redirection

**Cause** : Configuration des URLs incorrecte

**Solution** :
- Vérifier `OIDC_REDIRECT_URI`
- Vérifier `FRONTEND_URL`
- Vérifier les "Valid redirect URIs" dans Keycloak

---

## Ressources

### Documentation officielle

- [Keycloak Documentation](https://www.keycloak.org/documentation)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [openid-client (Node.js)](https://github.com/panva/node-openid-client)

### Outils utiles

- [JWT.io](https://jwt.io/) - Décodeur de JWT
- [OIDC Debugger](https://oidcdebugger.com/) - Tester les flux OIDC
- [Keycloak Admin CLI](https://www.keycloak.org/docs/latest/server_admin/#admin-cli) - Gestion en ligne de commande

### Support

- GitHub Issues : [Votre repo]
- Documentation Ryvie : `/docs`
- Keycloak Community : https://www.keycloak.org/community

---

## Récapitulatif des URLs

### Mode PRIVATE (réseau local)

| Service | URL | Notes |
|---------|-----|-------|
| **Frontend Ryvie** | `http://ryvie.local` | Via Caddy |
| **Backend Ryvie** | `http://ryvie.local` | Via Caddy (même domaine) |
| **Keycloak** | `http://ryvie.local:8080` | Via Caddy |
| **Keycloak Admin** | `http://ryvie.local:8080/admin` | Interface admin |
| **OIDC Issuer** | `http://ryvie.local:8080/realms/ryvie` | Discovery endpoint |
| **Callback URL** | `http://ryvie.local/api/auth/callback` | Backend callback |
| **LDAP** | `ldap://openldap:389` | Interne Docker |

### Mode REMOTE (accès distant via Netbird)

| Service | URL | Notes |
|---------|-----|-------|
| **Frontend Ryvie** | `https://app.ryvie.fr` | Via Netbird + Caddy |
| **Backend Ryvie** | `https://status.ryvie.fr` | Via Netbird + Caddy |
| **Keycloak** | `https://auth.ryvie.fr` | Via Netbird + Caddy |
| **Keycloak Admin** | `https://auth.ryvie.fr/admin` | Interface admin |
| **OIDC Issuer** | `https://auth.ryvie.fr/realms/ryvie` | Discovery endpoint |
| **Callback URL** | `https://status.ryvie.fr/api/auth/callback` | Backend callback |
| **LDAP** | `ldap://openldap:389` | Via tunnel Netbird |

### URLs des applications (exemples)

| Application | Mode PRIVATE | Mode REMOTE |
|-------------|--------------|-------------|
| **rpictures** | `http://ryvie.local:3010` | `https://rpictures.ryvie.fr` |
| **rdrive** | `http://ryvie.local:3011` | `https://rdrive.ryvie.fr` |
| **Autre app** | `http://ryvie.local:<port>` | `https://<app>.ryvie.fr` |

### Variables d'environnement finales

```bash
# Keycloak
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=<secret>
KEYCLOAK_DB_PASSWORD=<secret>

# OIDC
OIDC_CLIENT_ID=ryvie-dashboard
OIDC_CLIENT_SECRET=<secret>

# Mode PRIVATE
OIDC_ISSUER_PRIVATE=http://ryvie.local:8080/realms/ryvie
OIDC_REDIRECT_URI_PRIVATE=http://ryvie.local/api/auth/callback
FRONTEND_URL_PRIVATE=http://ryvie.local

# Mode REMOTE
OIDC_ISSUER_REMOTE=https://auth.ryvie.fr/realms/ryvie
OIDC_REDIRECT_URI_REMOTE=https://status.ryvie.fr/api/auth/callback
FRONTEND_URL_REMOTE=https://app.ryvie.fr

# LDAP
LDAP_URL=ldap://openldap:389
LDAP_BIND_DN=cn=read-only,ou=users,dc=example,dc=org
LDAP_BIND_PASSWORD=<secret>
```

---

## Conclusion

Cette migration vers Keycloak SSO permet de :

✅ **Centraliser l'authentification** pour toutes les applications
✅ **Améliorer la sécurité** avec OIDC et MFA
✅ **Simplifier l'expérience utilisateur** avec le SSO
✅ **Faciliter l'ajout de nouvelles applications**
✅ **Garder la compatibilité** avec LDAP existant
✅ **Supporter les deux modes d'accès** (private/remote) de Ryvie

**Points clés de l'architecture Private/Remote** :
- Keycloak accessible dans les deux modes via Caddy
- Détection automatique du mode dans le backend
- URLs de callback configurées pour les deux modes
- Sessions indépendantes entre private et remote (comportement normal)
- Pas de modification nécessaire du système de détection existant

La migration peut être progressive et réversible, minimisant les risques pour votre infrastructure.
