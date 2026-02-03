import * as oauth from 'openid-client';
import { randomBytes } from 'crypto';

interface OIDCConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const config: OIDCConfig = {
  issuer: process.env.OIDC_ISSUER || 'http://ryvie.local:8080/realms/ryvie',
  clientId: process.env.OIDC_CLIENT_ID || 'ryvie-dashboard',
  clientSecret: process.env.OIDC_CLIENT_SECRET || 'ryvie-dashboard-secret-change-me',
  redirectUri: process.env.OIDC_REDIRECT_URI || 'http://ryvie.local/api/auth/callback',
};

let discoveredConfig: oauth.Configuration | null = null;

// Fonction pour construire l'issuer dynamiquement basé sur l'origine
function getIssuerFromOrigin(origin: string): string {
  const url = new URL(origin);
  // Remplacer le port par 8080 pour Keycloak
  return `http://${url.hostname}:8080/realms/ryvie`;
}

// Fonction pour construire le redirect_uri vers le backend
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

export async function getOIDCConfig(): Promise<oauth.Configuration> {
  if (discoveredConfig) {
    return discoveredConfig;
  }

  try {
    const issuerUrl = new URL(config.issuer);
    discoveredConfig = await oauth.discovery(
      issuerUrl, 
      config.clientId, 
      config.clientSecret,
      undefined,
      {
        execute: [oauth.allowInsecureRequests]
      }
    );
    console.log('[OIDC] Discovered issuer:', config.issuer);
    return discoveredConfig;
  } catch (error: any) {
    console.error('[OIDC] Failed to discover configuration:', error.message);
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
  const redirectUri = getBackendRedirectUri(origin);
  const issuer = getIssuerFromOrigin(origin);
  
  console.log('[OIDC] Exchange code for tokens - redirectUri:', redirectUri);
  console.log('[OIDC] Exchange code for tokens - issuer:', issuer);
  console.log('[OIDC] Exchange code for tokens - origin:', origin);

  try {
    // Appel manuel au token endpoint pour contourner la validation stricte de l'issuer
    const tokenEndpoint = `${issuer}/protocol/openid-connect/token`;
    
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const response = await fetch(tokenEndpoint, {
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
    const issuer = getIssuerFromOrigin(origin);
    const userinfoEndpoint = `${issuer}/protocol/openid-connect/userinfo`;
    
    const response = await fetch(userinfoEndpoint, {
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
