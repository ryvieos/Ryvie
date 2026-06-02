# Migration SSO apps : port 3005 → /auth (Caddy)

Keycloak est désormais accessible via Caddy sur le port 80 avec le path `/auth` au lieu d'un port dédié 3005.

## Ce qui a changé

| Avant | Après |
|---|---|
| `http://{host}:3005/realms/ryvie` | `http://{host}/auth/realms/ryvie` |
| Port 3005 exposé par Caddy | Tout passe par le port 80 |

## Approche

L'URL Keycloak n'est plus hardcodée. La config `issuerUrl` (configurable via `OAUTH_ISSUER_URL`) sert de template. Le code dynamique ne remplace que le hostname en préservant le port et le path de la config.

```ts
// Méthode helper ajoutée
private buildIssuerUrl(templateUrl: string, hostname: string): string {
  const url = new URL(templateUrl);
  url.hostname = hostname;
  return url.toString().replace(/\/$/, '');
}
```

## rDrive

**Statut : corrigé**

Fichiers modifiés dans `/data/apps/Ryvie-rDrive/tdrive/backend/node/src/services/oauth/` :

- `config.ts` — fallback mis à jour vers `/auth/realms/ryvie`
- `service.ts` — 4 occurrences remplacées par `this.buildIssuerUrl(oauth.issuerUrl, hostname)`

`.env` (`/data/apps/rdrive/.env`) :
```
OAUTH_ISSUER_URL=http://ryvie.local/auth/realms/ryvie
```

Après rebuild de l'image :
```bash
cd /data/apps/rdrive && docker compose up -d node
```

## rPictures

**Statut : à corriger (même pattern)**

Fichiers à modifier :

**`server/src/config.ts`** :
```ts
// Remplacer le fallback
issuerUrl: process.env.OAUTH_ISSUER_URL || 'http://ryvie.local/auth/realms/ryvie',
```

**`server/src/services/auth.service.ts`** (2 occurrences) :

Ajouter une méthode helper :
```ts
private buildIssuerUrl(templateUrl: string, hostname: string): string {
  const url = new URL(templateUrl);
  url.hostname = hostname;
  return url.toString().replace(/\/$/, '');
}
```

Remplacer :
```ts
dynamicOauth.issuerUrl = `http://${redirectUrl.hostname}:3005/realms/ryvie`;
```
Par :
```ts
dynamicOauth.issuerUrl = this.buildIssuerUrl(oauth.issuerUrl, redirectUrl.hostname);
```

Ajouter dans `/data/apps/rpictures/.env` :
```
OAUTH_ISSUER_URL=http://ryvie.local/auth/realms/ryvie
```

Après rebuild :
```bash
cd /data/apps/rpictures && docker compose up -d
```

## Futures apps

Configurer dans le `.env` :
```
OAUTH_ISSUER_URL=http://ryvie.local/auth/realms/ryvie
```

Ne jamais hardcoder le port/path Keycloak — utiliser `buildIssuerUrl(config.issuerUrl, hostname)` pour les URLs dynamiques.
