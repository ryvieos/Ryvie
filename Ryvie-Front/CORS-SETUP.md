# Configuration CORS pour Ryvie

## 🚨 Problème identifié

Les erreurs CORS empêchent la détection automatique et l'accès aux API :

```
Access to fetch at 'http://ryvie.local:3002/api/server-info' from origin 'http://localhost:3000' 
has been blocked by CORS policy: Response to preflight request doesn't pass access control check: 
The value of the 'Access-Control-Allow-Origin' header in the response must not be the wildcard '*' 
when the request's credentials mode is 'include'.
```

## ✅ Corrections apportées côté client

1. **Suppression des credentials** dans les requêtes de détection
2. **Configuration axios** sans `withCredentials` pour les tests
3. **Fallback robuste** avec mode `no-cors` pour la détection

## 🔧 Configuration serveur requise

### Pour le serveur local (`http://ryvie.local:3002`)

```javascript
// Configuration CORS recommandée
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://votre-domaine-web.com'
  ],
  credentials: false, // Important: false pour les requêtes de détection
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization']
}));

// Endpoint de santé requis
app.get('/api/server-info', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mode: 'private'
  });
});
```

### Pour le serveur public (`https://status.makerfaire.jules.ryvie.fr`)

```javascript
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://votre-domaine-web.com'
  ],
  credentials: false,
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization']
}));
```

## 🔄 Logique de fallback implémentée

1. **Test privé** avec `detectAccessMode()` (CORS standard)
2. **Fallback robuste** avec `detectAccessModeRobust()` (mode no-cors)
3. **Mode public par défaut** si tout échoue

## 🧪 Test de la configuration

Une fois CORS configuré côté serveur, l'application devrait :

1. Détecter automatiquement le serveur local si accessible
2. Basculer vers public si local inaccessible
3. Afficher les badges de mode appropriés
4. Charger les utilisateurs depuis le bon serveur

## 📝 Endpoints requis

- `/api/server-info` - Détection de connectivité
- `/api/users` - Liste des utilisateurs  
- `/api/authenticate` - Authentification JWT

Tous doivent supporter CORS avec les origines appropriées.
