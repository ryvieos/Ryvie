import * as oauth from 'openid-client';
import { randomBytes } from 'crypto';
import * as http from 'http';
import * as https from 'https';

interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const config: OIDCConfig = {
  // Keycloak est servi par Caddy sur le port 80/443 sous le préfixe /auth
  // (plus sur le port 3005). Discovery côté backend via localhost (toujours joignable).
  issuer: process.env.OIDC_ISSUER || 'http://localhost/auth/realms/ryvie',
  clientId: process.env.OIDC_CLIENT_ID || 'ryvie-dashboard',
  clientSecret: process.env.OIDC_CLIENT_SECRET || 'ryvie-dashboard-secret-change-me',
  redirectUri: process.env.OIDC_REDIRECT_URI || 'http://ryvie.local/api/auth/callback',
};

let discoveredConfig: oauth.Configuration | null = null;

// Fonction pour construire l'issuer dynamiquement basé sur l'origine
// Utilisé UNIQUEMENT pour les URLs vues par le navigateur (authorize).
function getIssuerFromOrigin(origin: string): string {
  const url = new URL(origin);
  const protocol = url.protocol || 'http:';
  // Keycloak est servi par Caddy sur le port 80/443 sous le préfixe /auth et reflète
  // dynamiquement le Host. On garde donc l'hôte demandé (joignable par le navigateur)
  // sans port, avec le préfixe /auth. (Avant: ':3005/realms' n'existe plus.)
  return `${protocol}//${url.hostname}/auth/realms/ryvie`;
}

const REALM_PATH = '/auth/realms/ryvie';

interface SimpleResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
}

// Appel serveur-à-serveur vers Keycloak.
// On tape le Caddy LOCAL (OIDC_INTERNAL_BASE, défaut http://127.0.0.1), JAMAIS l'origin
// public : en accès distant celle-ci ressort sur Internet et repasse par l'ingress du
// cluster, qui supprime l'en-tête `Authorization` → /userinfo en 401 "Missing token".
// MAIS on présente à Keycloak le Host + proto PUBLICS (issus de l'origin). Sinon Keycloak
// émettrait/attendrait un issuer http://127.0.0.1, incohérent avec le token émis lors de
// l'authorize sur le domaine public (iss=https://demo.ryvie.fr) → "Invalid token issuer".
// Le détour par Caddy local résout `@auth_https` (cf. Caddyfile) et reflète l'hôte public.
// NB: on utilise le module http natif car fetch (undici) interdit de fixer l'en-tête Host.
function localKeycloakRequest(
  origin: string | undefined,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<SimpleResponse> {
  const target = new URL(process.env.OIDC_INTERNAL_BASE || 'http://127.0.0.1');
  const lib = target.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (origin) {
    const pub = new URL(origin);
    // Hôte + proto publics → issuer cohérent avec le flow navigateur.
    headers['Host'] = pub.host;
    headers['X-Forwarded-Host'] = pub.host;
    headers['X-Forwarded-Proto'] = pub.protocol.replace(':', '');
  }
  if (opts.body) {
    headers['Content-Length'] = Buffer.byteLength(opts.body).toString();
  }
  return new Promise<SimpleResponse>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path,
        method: opts.method || 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => data,
            json: async () => JSON.parse(data),
          });
        });
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Fonction pour construire le redirect_uri vers le backend
function getBackendRedirectUri(origin: string): string {
  const url = new URL(origin);
  const protocol = url.protocol || 'http:';
  
  // Si c'est ryvie.local (Caddy), pas de port spécifique
  if (url.hostname === 'ryvie.local' && !url.port) {
    return `${protocol}//ryvie.local/api/auth/callback`;
  }
  
  // Si le port est 3000 (webpack-dev-server), utiliser 3002 pour le backend
  if (url.port === '3000') {
    return `${protocol}//${url.hostname}:3002/api/auth/callback`;
  }
  
  // Sinon, utiliser le port de l'origine s'il existe, ou l'hôte nu pour 80/443
  if (url.port) {
    return `${protocol}//${url.hostname}:${url.port}/api/auth/callback`;
  }

  return `${protocol}//${url.hostname}/api/auth/callback`;
}

export async function getOIDCConfig(): Promise<oauth.Configuration> {
  if (discoveredConfig) {
    return discoveredConfig;
  }

  try {
    const issuerUrl = new URL(config.issuer);
    console.log('[OIDC] Attempting discovery for:', config.issuer);
    
    discoveredConfig = await oauth.discovery(
      issuerUrl, 
      config.clientId, 
      config.clientSecret,
      undefined,
      {
        execute: [oauth.allowInsecureRequests]
      }
    );
    console.log('[OIDC] Discovery successful for issuer:', config.issuer);
    return discoveredConfig;
  } catch (error: any) {
    console.error('[OIDC] Failed to discover configuration:', error.message);
    console.error('[OIDC] Will retry on next request');
    // Ne pas mettre en cache l'erreur - permettre de réessayer
    throw new Error('OIDC initialization failed');
  }
}

export async function generateAuthUrl(state: string, nonce: string, origin: string): Promise<string> {
  const redirectUri = getBackendRedirectUri(origin);
  const issuer = getIssuerFromOrigin(origin);
  
  console.log('[OIDC] generateAuthUrl - origin:', origin);
  console.log('[OIDC] generateAuthUrl - issuer:', issuer);
  console.log('[OIDC] generateAuthUrl - redirectUri:', redirectUri);
  
  const authUrl = new URL(`${issuer}/protocol/openid-connect/auth`);
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('response_type', 'code');

  return authUrl.href;
}

export async function exchangeCodeForTokens(code: string, state: string, nonce: string, origin: string) {
  // redirect_uri DOIT rester l'URL publique envoyée au navigateur lors de l'authorize.
  const redirectUri = getBackendRedirectUri(origin);

  console.log('[OIDC] Exchange code for tokens - redirectUri:', redirectUri);
  console.log('[OIDC] Exchange code for tokens - origin (public issuer):', origin);

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    // Appel local mais avec Host/proto publics → token émis avec iss = origin public.
    const response = await localKeycloakRequest(origin, `${REALM_PATH}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const tokens: any = await response.json();
    
    console.log('[OIDC] Token received successfully');

    // Décoder le id_token pour extraire les claims
    let claims: any = {};
    if (tokens.id_token) {
      const parts = tokens.id_token.split('.');
      if (parts.length === 3) {
        const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
        claims = JSON.parse(payload);
      }
    }
    
    return {
      accessToken: tokens.access_token,
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      claims: claims,
    };
  } catch (error: any) {
    console.error('[OIDC] Token exchange error:', error.message);
    console.error('[OIDC] Error details:', error);
    throw error;
  }
}

export async function getUserInfo(accessToken: string, origin?: string) {
  try {
    // Appel local (préserve Authorization, évite l'ingress) mais avec Host/proto publics
    // → l'issuer attendu par /userinfo = celui du token (origin public). Cf. localKeycloakRequest.
    const response = await localKeycloakRequest(origin, `${REALM_PATH}/protocol/openid-connect/userinfo`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`UserInfo fetch failed: ${response.status} ${errorText}`);
    }

    const userinfo: any = await response.json();
    console.log('[OIDC] UserInfo retrieved successfully:', userinfo.preferred_username || userinfo.sub);
    
    return userinfo;
  } catch (error: any) {
    console.error('[OIDC] UserInfo error:', error.message);
    throw error;
  }
}

export async function refreshAccessToken(refreshToken: string) {
  const oidcConfig = await getOIDCConfig();
  const tokens = await oauth.refreshTokenGrant(oidcConfig, refreshToken);
  
  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  };
}

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}
