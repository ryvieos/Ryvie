# Résumé de l'intégration Keycloak SSO

## ✅ Ce qui a été fait

### 1. **Intégration Keycloak SSO pour Ryvie Dashboard** ✅

#### Configuration Keycloak
- **Realm** : `ryvie`
- **Client** : `ryvie-dashboard`
- **LDAP User Federation** : Connecté à `ldap://localhost:389`
- **Base DN** : `ou=users,dc=example,dc=org`

#### Fonctionnalités implémentées
- ✅ **Authentification SSO** avec support multi-origines
  - `http://ryvie.local`
  - `http://10.128.255.101:3000`
  - `http://localhost:3000`
- ✅ **Déconnexion OIDC** complète
- ✅ **Détermination automatique des rôles** via groupes LDAP
  - Admin : `cn=admins,ou=users,dc=example,dc=org`
  - User : `cn=users,ou=users,dc=example,dc=org`
  - Guest : `cn=guests,ou=users,dc=example,dc=org`
- ✅ **Détection dynamique de l'origine** pour les redirects
- ✅ **Support PKCE** pour la sécurité

#### Fichiers modifiés
- `/opt/Ryvie/Ryvie-Back/routes/oidcAuth.ts` - Routes OIDC
- `/opt/Ryvie/Ryvie-Back/services/oidcService.ts` - Service OIDC
- `/opt/Ryvie/Ryvie-Front/src/pages/Home.tsx` - Logout frontend
- `/opt/Ryvie/Ryvie-Front/src/pages/AuthCallback.tsx` - Callback frontend
- `/opt/Ryvie/keycloak/import/ryvie-realm.json` - Configuration Keycloak

#### Test réussi
- ✅ Jules se connecte avec SSO
- ✅ Rôle Admin correctement attribué
- ✅ Déconnexion fonctionne
- ✅ Support multi-origines validé

---

### 2. **Préparation intégration rPictures** ✅

#### Client Keycloak créé
- **Client ID** : `ryvie-rpictures`
- **Secret** : `rpictures-secret-change-in-production`
- **Redirect URIs** :
  - `http://ryvie.local:3013/api/oauth/callback`
  - `http://localhost:3013/api/oauth/callback`
  - `http://10.128.255.101:3013/api/oauth/callback`
  - `http://*:3013/api/oauth/callback`
- **Support PKCE** : Activé (S256)

#### Documentation créée
- ✅ `/opt/Ryvie/KEYCLOAK_SSO_DOCUMENTATION.md` - Documentation complète Keycloak
- ✅ `/opt/Ryvie/RPICTURES_KEYCLOAK_INTEGRATION_PLAN.md` - Plan d'intégration rPictures

---

## 🚀 Prochaines étapes pour rPictures

### Étape 1 : Configuration des variables d'environnement

Créer/modifier `/data/apps/Ryvie-rPictures/.env` :

```env
# Configuration Keycloak SSO
KEYCLOAK_ISSUER_URL=http://ryvie.local:8080/realms/ryvie
KEYCLOAK_CLIENT_ID=ryvie-rpictures
KEYCLOAK_CLIENT_SECRET=rpictures-secret-change-in-production
KEYCLOAK_ENABLED=true
KEYCLOAK_AUTO_REGISTER=true
KEYCLOAK_BUTTON_TEXT=Se connecter avec Ryvie
```

### Étape 2 : Adapter le code rPictures

Les fichiers à modifier sont identifiés dans `/opt/Ryvie/RPICTURES_KEYCLOAK_INTEGRATION_PLAN.md` :

1. **`/data/apps/Ryvie-rPictures/server/src/config.ts`**
   - Ajouter la configuration Keycloak

2. **`/data/apps/Ryvie-rPictures/server/src/services/auth.service.ts`**
   - Adapter `authorize()` pour Keycloak
   - Adapter `callback()` pour échanger le code avec Keycloak
   - Implémenter l'auto-registration des utilisateurs

3. **`/data/apps/Ryvie-rPictures/server/src/repositories/oauth.repository.ts`**
   - Vérifier/adapter le stockage des profils OAuth

### Étape 3 : Tester le SSO

1. Se connecter à Ryvie avec Jules
2. Accéder à rPictures : `http://ryvie.local:3013`
3. Cliquer sur "Se connecter avec Ryvie"
4. Vérifier que Jules est automatiquement connecté

---

## 📊 Architecture SSO finale

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
│  • Authentification centralisée                          │
│  • Session SSO unique                                    │
│  • Intégration LDAP                                      │
└────────┬────────────────────────────┬────────────────────┘
         │                            │
         ▼                            ▼
┌─────────────────────┐    ┌─────────────────────────────┐
│   Ryvie Dashboard   │    │      rPictures (Immich)     │
│  (port 3000/3002)   │    │       (port 3013)           │
│                     │    │                             │
│  Client:            │    │  Client:                    │
│  ryvie-dashboard    │    │  ryvie-rpictures            │
│                     │    │                             │
│  ✅ Connecté        │    │  🔄 En cours d'intégration  │
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
- **DN** : `cn=jules,ou=users,dc=example,dc=org`
- **Groupe** : `cn=admins,ou=users,dc=example,dc=org`
- **Rôle Ryvie** : Admin

### Clients Keycloak
1. **ryvie-dashboard** (Ryvie Dashboard)
   - ✅ Opérationnel
   - Secret : (configuré dans `/opt/Ryvie/Ryvie-Back/.env`)

2. **ryvie-rpictures** (rPictures)
   - 🔄 Créé, en attente d'intégration
   - Secret : `rpictures-secret-change-in-production`

---

## 🛠️ Commandes utiles

### Gérer Keycloak via API

```bash
# Obtenir un token admin
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin" \
  -d "password=changeme123" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | jq -r '.access_token')

# Lister les clients
curl -s -X GET "http://localhost:8080/admin/realms/ryvie/clients" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[].clientId'

# Obtenir un client spécifique
CLIENT_ID=$(curl -s -X GET "http://localhost:8080/admin/realms/ryvie/clients" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.clientId=="ryvie-rpictures") | .id')

curl -s -X GET "http://localhost:8080/admin/realms/ryvie/clients/$CLIENT_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Redémarrer Keycloak

```bash
cd /opt/Ryvie/keycloak
docker-compose restart
```

### Logs Keycloak

```bash
cd /opt/Ryvie/keycloak
docker-compose logs -f --tail=50
```

---

## 📚 Documentation

- **Documentation complète Keycloak** : `/opt/Ryvie/KEYCLOAK_SSO_DOCUMENTATION.md`
- **Plan d'intégration rPictures** : `/opt/Ryvie/RPICTURES_KEYCLOAK_INTEGRATION_PLAN.md`
- **Ce résumé** : `/opt/Ryvie/KEYCLOAK_SSO_SUMMARY.md`

---

## ✅ Statut actuel

| Composant | Statut | Notes |
|-----------|--------|-------|
| **Keycloak** | ✅ Opérationnel | Realm ryvie configuré |
| **LDAP Integration** | ✅ Opérationnel | User Federation active |
| **Ryvie Dashboard SSO** | ✅ Opérationnel | Login/Logout fonctionnels |
| **Client ryvie-rpictures** | ✅ Créé | Prêt pour intégration |
| **rPictures SSO** | 🔄 En attente | Code à adapter |

---

## 🎯 Objectif final

**Single Sign-On complet** :
1. Jules se connecte à Ryvie → Session Keycloak créée
2. Jules accède à rPictures → Automatiquement connecté (SSO)
3. Jules accède à toute autre app Ryvie → Automatiquement connecté (SSO)
4. Jules se déconnecte de Keycloak → Déconnecté de toutes les apps

**Avantages** :
- Une seule authentification pour tout l'écosystème Ryvie
- Gestion centralisée des utilisateurs (LDAP)
- Sécurité renforcée
- Expérience utilisateur fluide
