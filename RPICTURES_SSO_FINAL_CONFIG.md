# Configuration finale SSO Keycloak pour rPictures

## ✅ Ce qui a été fait

### 1. **Intégration Keycloak SSO pour Ryvie Dashboard** ✅
- SSO fonctionnel avec support multi-origines
- Déconnexion OIDC complète
- Détermination automatique des rôles via groupes LDAP
- Jules obtient correctement le rôle Admin

### 2. **Client Keycloak pour rPictures** ✅
- **Client ID** : `ryvie-rpictures`
- **Client Secret** : `rpictures-secret-change-in-production`
- **Redirect URIs** : Toutes les variantes (ryvie.local, localhost, IPs, wildcards)
- **Support PKCE** : Activé

### 3. **Configuration rPictures avec OAuth activé par défaut** ✅

#### Fichier modifié : `/data/apps/Ryvie-rPictures/server/src/config.ts`

```typescript
oauth: {
  autoLaunch: false,
  autoRegister: true,
  buttonText: process.env.OAUTH_BUTTON_TEXT || 'Se connecter avec Ryvie',
  clientId: process.env.OAUTH_CLIENT_ID || 'ryvie-rpictures',
  clientSecret: process.env.OAUTH_CLIENT_SECRET || 'rpictures-secret-change-in-production',
  defaultStorageQuota: process.env.OAUTH_DEFAULT_STORAGE_QUOTA ? Number(process.env.OAUTH_DEFAULT_STORAGE_QUOTA) : null,
  enabled: process.env.OAUTH_ENABLED !== 'false', // ✅ Activé par défaut
  issuerUrl: process.env.OAUTH_ISSUER_URL || 'http://ryvie.local:8080/realms/ryvie',
  mobileOverrideEnabled: process.env.OAUTH_MOBILE_OVERRIDE_ENABLED === 'true',
  mobileRedirectUri: process.env.OAUTH_MOBILE_REDIRECT_URI || '',
  scope: process.env.OAUTH_SCOPE || 'openid email profile',
  signingAlgorithm: process.env.OAUTH_SIGNING_ALGORITHM || 'RS256',
  profileSigningAlgorithm: process.env.OAUTH_PROFILE_SIGNING_ALGORITHM || 'none',
  storageLabelClaim: process.env.OAUTH_STORAGE_LABEL_CLAIM || 'preferred_username',
  storageQuotaClaim: process.env.OAUTH_STORAGE_QUOTA_CLAIM || 'immich_quota',
  roleClaim: process.env.OAUTH_ROLE_CLAIM || 'immich_role',
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod.ClientSecretPost,
  timeout: process.env.OAUTH_TIMEOUT ? Number(process.env.OAUTH_TIMEOUT) : 30_000,
},
```

**Changements clés** :
- ✅ `enabled: process.env.OAUTH_ENABLED !== 'false'` → OAuth activé par défaut
- ✅ `clientSecret: ... || 'rpictures-secret-change-in-production'` → Secret par défaut
- ✅ Toutes les valeurs Keycloak Ryvie en fallback

### 4. **Configuration Docker** ✅

#### Fichier modifié : `/data/apps/Ryvie-rPictures/docker/docker-compose.prod.yml`

```yaml
immich-server:
  container_name: immich_server
  image: immich-server:latest
  # ...
  extra_hosts:
    - "ryvie.local:172.17.0.1"  # ✅ Résolution DNS pour Keycloak
```

**Pourquoi** : Le conteneur Docker doit pouvoir résoudre `ryvie.local` vers l'IP de l'hôte Docker (`172.17.0.1`) pour contacter Keycloak.

### 5. **Variables d'environnement** ✅

#### Fichier : `/data/apps/Ryvie-rPictures/docker/.env`

```env
# OAuth Keycloak (optionnel, valeurs par défaut dans le code)
OAUTH_ENABLED=true
OAUTH_ISSUER_URL=http://ryvie.local:8080/realms/ryvie
OAUTH_CLIENT_ID=ryvie-rpictures
OAUTH_CLIENT_SECRET=rpictures-secret-change-in-production
OAUTH_SCOPE=openid email profile
OAUTH_BUTTON_TEXT=Se connecter avec Ryvie
OAUTH_AUTO_REGISTER=true
```

**Note** : Ces variables sont maintenant **optionnelles** car les valeurs par défaut sont dans le code.

---

## 🚀 Démarrage de rPictures avec OAuth activé

### Commandes

```bash
cd /data/apps/Ryvie-rPictures/docker

# Construire l'image avec la nouvelle configuration
docker compose -f docker-compose.prod.yml build immich-server

# Démarrer tous les services
docker compose -f docker-compose.prod.yml up -d

# Vérifier les logs
docker logs immich_server --tail 50
```

### Vérification OAuth activé

```bash
# Vérifier que OAuth est activé via l'API
curl -s http://localhost:3013/api/server/config | jq '.oauth.enabled'
# Devrait retourner: true
```

---

## 🎯 Flux SSO complet

1. **Utilisateur accède à rPictures** : `http://ryvie.local:3013`
2. **Bouton "Se connecter avec Ryvie" visible** dès le premier accès
3. **Clic sur le bouton** → Redirection vers Keycloak
4. **Authentification Keycloak** (si pas déjà connecté)
5. **Redirection vers rPictures** avec le code d'autorisation
6. **Création automatique de l'utilisateur** (auto-register)
7. **Connexion réussie** !

---

## 📊 Architecture finale

```
┌──────────────────────────────────────────────────────────┐
│                    Utilisateur (Jules)                    │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│                   Keycloak SSO                            │
│            (http://ryvie.local:8080)                      │
│                                                           │
│  Realm: ryvie                                            │
│  • Client ryvie-dashboard (Ryvie)                       │
│  • Client ryvie-rpictures (rPictures)                   │
│  • LDAP User Federation                                  │
└────────┬────────────────────────────┬────────────────────┘
         │                            │
         ▼                            ▼
┌─────────────────────┐    ┌─────────────────────────────┐
│   Ryvie Dashboard   │    │      rPictures (Immich)     │
│  (port 3000/3002)   │    │       (port 3013)           │
│                     │    │                             │
│  ✅ SSO actif       │    │  ✅ OAuth activé par défaut │
│  ✅ Rôles LDAP      │    │  ✅ Auto-register           │
└─────────────────────┘    └─────────────────────────────┘
```

---

## 🔑 Informations importantes

### Credentials Keycloak Admin
- **URL** : `http://localhost:8080` ou `http://ryvie.local:8080`
- **Username** : `admin`
- **Password** : `changeme123`
- **Realm** : `ryvie`

### Utilisateur test LDAP
- **Username** : `jules`
- **Password** : `julespassword`
- **Email** : `jules@gmail.com`
- **Rôle Ryvie** : Admin
- **Rôle rPictures** : User (auto-créé)

### Clients Keycloak
1. **ryvie-dashboard** (Ryvie Dashboard)
   - ✅ Opérationnel
   - Redirect URIs : `http://ryvie.local/*`, `http://*:3000/*`

2. **ryvie-rpictures** (rPictures)
   - ✅ Opérationnel
   - Redirect URIs : `http://ryvie.local:3013/*`, `http://*:3013/*`
   - Secret : `rpictures-secret-change-in-production`

---

## 🛠️ Commandes utiles

### Gérer rPictures

```bash
cd /data/apps/Ryvie-rPictures/docker

# Démarrer
docker compose -f docker-compose.prod.yml up -d

# Arrêter
docker compose -f docker-compose.prod.yml down

# Reconstruire
docker compose -f docker-compose.prod.yml build immich-server

# Logs
docker logs immich_server --tail 100 -f

# Vérifier OAuth
curl -s http://localhost:3013/api/server/config | jq '.oauth'
```

### Réinitialiser la base de données

```bash
cd /data/apps/Ryvie-rPictures/docker

# Arrêter les conteneurs
docker compose -f docker-compose.prod.yml down

# Supprimer la base de données
sudo rm -rf /data/apps/Ryvie-rPictures-data/postgres/*

# Redémarrer
docker compose -f docker-compose.prod.yml up -d
```

---

## ✅ Avantages de cette configuration

1. **OAuth activé par défaut** : Pas besoin de configuration manuelle
2. **Valeurs Keycloak en dur** : Fonctionne out-of-the-box pour Ryvie
3. **Auto-registration** : Les utilisateurs Keycloak sont créés automatiquement
4. **Single Sign-On** : Une seule authentification pour Ryvie et rPictures
5. **Gestion centralisée** : Tous les utilisateurs gérés dans LDAP/Keycloak

---

## 📚 Documentation

- **Documentation Keycloak** : `/opt/Ryvie/KEYCLOAK_SSO_DOCUMENTATION.md`
- **Plan d'intégration rPictures** : `/opt/Ryvie/RPICTURES_KEYCLOAK_INTEGRATION_PLAN.md`
- **Résumé SSO** : `/opt/Ryvie/KEYCLOAK_SSO_SUMMARY.md`
- **Configuration finale** : `/opt/Ryvie/RPICTURES_SSO_FINAL_CONFIG.md` (ce fichier)

---

## 🎉 Résultat final

**Single Sign-On complet entre Ryvie et rPictures via Keycloak !**

- Jules se connecte à Ryvie → Session Keycloak créée
- Jules accède à rPictures → Automatiquement connecté (SSO)
- Déconnexion de Keycloak → Déconnecté de toutes les apps
- Gestion centralisée des utilisateurs via LDAP
