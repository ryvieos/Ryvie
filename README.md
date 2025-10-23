# Ryvie

Application (Front + Back) avec authentification LDAP, JWT et gestion des utilisateurs (UI Electron/Browser). v0.0.25

## Prérequis
- Node.js 18+
- npm 9+
- (Optionnel) Redis si vous activez l'allowlist JWT côté backend

## Démarrage rapide
1) Installer les dépendances
   - Backend: `cd Ryvie/Back-end-view && npm install`
   - Frontend: `cd Ryvie/Ryvie-Front && npm install`

2) Créer/compléter les fichiers `.env` (voir sections ci-dessous)

3) Lancer
   - Backend: `npm start` dans `Ryvie/Back-end-view/`
   - Frontend (dev + Electron): `npm start` dans `Ryvie/Ryvie-Front/`

Le frontend démarre un serveur de dev (Webpack) et une fenêtre Electron. Vous pouvez aussi ouvrir l'app dans le navigateur si souhaité.

## Configuration .env (Backend)
Chemin: `Ryvie/Back-end-view/.env`

Exemple minimal (adaptez à votre infra):
```
# Réseau
PORT=3001

# LDAP (adapter à votre serveur)
LDAP_URL=ldap://localhost:389
LDAP_BIND_DN=cn=admin,dc=example,dc=org
LDAP_BIND_PASSWORD=changeme
LDAP_BASE_DN=dc=example,dc=org

# JWT
JWT_SECRET=change-this-to-a-long-random-string
JWT_EXPIRES_MINUTES=15

# Redis (si utilisé pour l'allowlist JWT)
REDIS_URL=redis://127.0.0.1:6379
# ou
# REDIS_HOST=127.0.0.1
# REDIS_PORT=6379
```

Notes:
- `JWT_EXPIRES_MINUTES` contrôle la durée de validité des tokens.
- En prod, utilisez un `JWT_SECRET` fort et changez-le pour invalider immédiatement les anciens tokens si nécessaire.
- Si Redis n'est pas disponible, désactivez/ignorez l'allowlist côté code ou fournissez une URL valide.

## Configuration (Frontend)
- Pas de `.env` obligatoire par défaut. Le frontend lit le serveur via la config utilitaire `src/config/urls.js` et des valeurs en `localStorage`.
- Clés `localStorage` courantes: `jwt_token`, `currentUserRole`, `currentUser`, `accessMode`.
- Assurez-vous que l'URL Backend dans `Ryvie-Front/src/config/urls.js` correspond à votre environnement.

## Rôles et accès (UI)
- Seuls les utilisateurs avec rôle `Admin` voient la gestion des utilisateurs (colonne Actions, bouton « Ajouter un utilisateur », formulaires d'ajout/édition, suppression).
- Les rôles `User`/`Guest` ne voient pas la partie gestion.

## Commandes utiles
- Backend: `npm run start` (ou `npm run dev` si disponible)
- Frontend: `npm start` (démarre le dev-server + Electron)

## Dépannage
- Si les tokens expirent, vous serez redirigé vers la page de connexion. Le frontend tente un refresh automatique si configuré.
- Logs Electron du type `EGL Driver message ... Bad attribute` sont sans impact fonctionnel en dev et peuvent être ignorés.
- Vérifiez les CORS et l'URL serveur si le frontend n'arrive pas à joindre l'API.

## Sécurité (rappel)
- Utilisez un `JWT_SECRET` fort et stockez-le hors dépôt.
- Limitez le brute force côté backend (rate limit) et, si possible, utilisez Redis pour l'allowlist des JWT.

