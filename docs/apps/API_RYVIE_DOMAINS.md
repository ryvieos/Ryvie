# API Ryvie Domains - Documentation

Cette documentation décrit comment authentifier un utilisateur et récupérer les informations de domaine, l'IP du tunnel et l'ID de la machine Ryvie.

## Table des matières

1. [Authentification](#authentification)
2. [Récupération de l'ID de la machine (public)](#récupération-de-lid-de-la-machine-public)
3. [Récupération des domaines et de l'IP du tunnel (authentifié)](#récupération-des-domaines-et-de-lip-du-tunnel-authentifié)
4. [Exemples de code](#exemples-de-code)

---

## Authentification

### Endpoint
```
POST /api/authenticate
```

### Description
Authentifie un utilisateur via LDAP et retourne un token JWT pour les appels API ultérieurs.

### Headers
```
Content-Type: application/json
```

### Body (JSON)
```json
{
  "uid": "utilisateur@example.com",
  "password": "motdepasse"
}
```

**Note importante** : Le champ `uid` accepte **3 formats** :
- **Username** : `john`
- **Common Name** : `John Doe`
- **Email** : `john@example.com`

### Réponse succès (200)
```json
{
  "message": "Authentification réussie",
  "user": {
    "uid": "john",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "Admin"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
```

### Réponses d'erreur

#### 400 - Bad Request
```json
{
  "error": "UID et mot de passe requis"
}
```

#### 401 - Unauthorized
```json
{
  "error": "Identifiant ou mot de passe incorrect",
  "attempts": 2
}
```

#### 429 - Too Many Requests
```json
{
  "error": "Trop de tentatives de connexion. Réessayez dans 15 minutes.",
  "retryAfter": 900
}
```

#### 500 - Internal Server Error
```json
{
  "error": "Échec de connexion LDAP initiale"
}
```

---

## Récupération de l'ID de la machine (public)

### Endpoint
```
GET /api/machine-id
```

### Description
Récupère l'ID unique de la machine Ryvie. **Aucune authentification requise**.

### Headers
Aucun header spécifique requis.

### Réponse succès (200)
```json
{
  "success": true,
  "ryvieId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Réponse d'erreur (500)
```json
{
  "success": false,
  "error": "Unable to retrieve machine ID"
}
```

---

## Récupération des domaines et de l'IP du tunnel (authentifié)

### Endpoint
```
GET /api/settings/ryvie-domains
```

### Description
Récupère les domaines publics Netbird, l'IP du tunnel et l'ID de la machine. **Authentification JWT requise**.

### Restrictions importantes
- ⚠️ **Accessible uniquement depuis le réseau local** (localhost, IP privée, ou tunnel Netbird)
- ⚠️ **Bloqué si l'accès se fait via un domaine public Netbird** (ex: `*.ryvie.fr`)
- ⚠️ **Bloqué sur le port remote 3002** pour les connexions non-locales

### Headers
```
Authorization: Bearer <token_jwt>
```

### Réponse succès (200)
```json
{
  "success": true,
  "id": "netbird-peer-id-123",
  "ryvieId": "550e8400-e29b-41d4-a716-446655440000",
  "domains": {
    "frontend": "frontend.ryvie.fr",
    "backend": "backend.ryvie.fr"
  },
  "tunnelHost": "100.64.0.1",
  "setupKey": "A1B2C3D4-E5F6-G7H8-I9J0-K1L2M3N4O5P6"
}
```

### Champs de la réponse

| Champ | Type | Description |
|-------|------|-------------|
| `success` | boolean | Indique si la requête a réussi |
| `id` | string \| null | ID du peer Netbird |
| `ryvieId` | string \| null | ID unique de l'instance Ryvie |
| `domains` | object | Objet contenant les domaines publics (frontend, backend, etc.) |
| `tunnelHost` | string \| null | **IP du tunnel Netbird** (ex: `100.64.0.1`) |
| `setupKey` | string \| null | Clé de configuration Netbird |

### Réponses d'erreur

#### 401 - Unauthorized
```json
{
  "error": "Accès refusé. Authentification requise."
}
```

#### 403 - Forbidden (accès remote)
```json
{
  "error": "Accès refusé: cette API n'est pas exposée via le domaine remote"
}
```

ou

```json
{
  "error": "Accès refusé: cette API est uniquement accessible en local"
}
```

#### 404 - Not Found
```json
{
  "error": "Fichier netbird-data.json non trouvé",
  "ryvieId": "550e8400-e29b-41d4-a716-446655440000"
}
```

ou

```json
{
  "error": "Aucun domaine trouvé dans le fichier",
  "ryvieId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### 500 - Internal Server Error
```json
{
  "error": "Erreur serveur",
  "details": "Message d'erreur détaillé"
}
```

---

## Exemples de code

### JavaScript / TypeScript (avec fetch)

```javascript
// Configuration
const RYVIE_BASE_URL = 'http://192.168.1.100:3000'; // Adresse locale de votre Ryvie

// 1. Authentification
async function authenticate(email, password) {
  const response = await fetch(`${RYVIE_BASE_URL}/api/authenticate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      uid: email, // Peut être un email, username ou common name
      password: password,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Authentification échouée');
  }

  const data = await response.json();
  return data.token; // Retourne le token JWT
}

// 2. Récupérer l'ID de la machine (sans authentification)
async function getMachineId() {
  const response = await fetch(`${RYVIE_BASE_URL}/api/machine-id`);

  if (!response.ok) {
    throw new Error('Impossible de récupérer l\'ID de la machine');
  }

  const data = await response.json();
  return data.ryvieId;
}

// 3. Récupérer les domaines et l'IP du tunnel (avec authentification)
async function getRyvieDomains(token) {
  const response = await fetch(`${RYVIE_BASE_URL}/api/settings/ryvie-domains`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Impossible de récupérer les domaines');
  }

  const data = await response.json();
  return {
    ryvieId: data.ryvieId,
    tunnelHost: data.tunnelHost, // IP du tunnel
    domains: data.domains,
    setupKey: data.setupKey,
  };
}

// Exemple d'utilisation complète
async function main() {
  try {
    // Étape 1 : Authentification
    const token = await authenticate('john@example.com', 'password123');
    console.log('✅ Authentification réussie');

    // Étape 2 : Récupérer l'ID de la machine (optionnel, car aussi dans ryvie-domains)
    const machineId = await getMachineId();
    console.log('Machine ID:', machineId);

    // Étape 3 : Récupérer les informations complètes
    const info = await getRyvieDomains(token);
    console.log('Ryvie ID:', info.ryvieId);
    console.log('IP du tunnel:', info.tunnelHost);
    console.log('Domaines:', info.domains);
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

main();
```

### Python (avec requests)

```python
import requests

# Configuration
RYVIE_BASE_URL = 'http://192.168.1.100:3000'

def authenticate(email, password):
    """Authentifie l'utilisateur et retourne le token JWT"""
    response = requests.post(
        f'{RYVIE_BASE_URL}/api/authenticate',
        json={
            'uid': email,  # Peut être un email, username ou common name
            'password': password
        }
    )
    
    if not response.ok:
        raise Exception(f"Authentification échouée: {response.json().get('error')}")
    
    data = response.json()
    return data['token']

def get_machine_id():
    """Récupère l'ID de la machine (sans authentification)"""
    response = requests.get(f'{RYVIE_BASE_URL}/api/machine-id')
    
    if not response.ok:
        raise Exception("Impossible de récupérer l'ID de la machine")
    
    data = response.json()
    return data['ryvieId']

def get_ryvie_domains(token):
    """Récupère les domaines et l'IP du tunnel (avec authentification)"""
    response = requests.get(
        f'{RYVIE_BASE_URL}/api/settings/ryvie-domains',
        headers={
            'Authorization': f'Bearer {token}'
        }
    )
    
    if not response.ok:
        raise Exception(f"Erreur: {response.json().get('error')}")
    
    data = response.json()
    return {
        'ryvieId': data['ryvieId'],
        'tunnelHost': data['tunnelHost'],  # IP du tunnel
        'domains': data['domains'],
        'setupKey': data.get('setupKey')
    }

# Exemple d'utilisation
if __name__ == '__main__':
    try:
        # Étape 1 : Authentification
        token = authenticate('john@example.com', 'password123')
        print('✅ Authentification réussie')
        
        # Étape 2 : Récupérer l'ID de la machine
        machine_id = get_machine_id()
        print(f'Machine ID: {machine_id}')
        
        # Étape 3 : Récupérer les informations complètes
        info = get_ryvie_domains(token)
        print(f"Ryvie ID: {info['ryvieId']}")
        print(f"IP du tunnel: {info['tunnelHost']}")
        print(f"Domaines: {info['domains']}")
    except Exception as e:
        print(f'❌ Erreur: {e}')
```

### cURL

```bash
# 1. Authentification
curl -X POST http://192.168.1.100:3000/api/authenticate \
  -H "Content-Type: application/json" \
  -d '{
    "uid": "john@example.com",
    "password": "password123"
  }'

# Réponse : {"token": "eyJhbGc...", ...}

# 2. Récupérer l'ID de la machine (sans token)
curl http://192.168.1.100:3000/api/machine-id

# 3. Récupérer les domaines et l'IP du tunnel (avec token)
curl http://192.168.1.100:3000/api/settings/ryvie-domains \
  -H "Authorization: Bearer eyJhbGc..."
```

---

## Notes importantes

1. **Sécurité** : Le token JWT expire après un certain temps (configurable, par défaut 60 minutes). Vous devrez vous réauthentifier après expiration.

2. **Accès local uniquement** : L'endpoint `/api/settings/ryvie-domains` n'est accessible que depuis :
   - `localhost` / `127.0.0.1`
   - Adresses IP privées (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
   - Tunnel Netbird (100.x.x.x)

3. **Rate limiting** : L'endpoint d'authentification est limité à 5 tentatives par 15 minutes pour éviter les attaques par force brute.

4. **Formats d'authentification** : Vous pouvez utiliser indifféremment :
   - L'email de l'utilisateur
   - Le username (uid)
   - Le nom complet (cn)

5. **IP du tunnel** : Le champ `tunnelHost` contient l'IP du tunnel Netbird, généralement dans la plage `100.x.x.x`.

---

## Support

Pour toute question ou problème, consultez la documentation principale de Ryvie ou contactez l'équipe de support.
