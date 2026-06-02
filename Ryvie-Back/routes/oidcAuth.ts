export {};
const express = require('express');
const oidcService = require('../services/oidcService');
const { signToken, allowlistToken } = require('../services/authService');
const ldapService = require('../services/ldapService');

const getOIDCConfig = oidcService.getOIDCConfig;
const generateAuthUrl = oidcService.generateAuthUrl;
const exchangeCodeForTokens = oidcService.exchangeCodeForTokens;
const getUserInfo = oidcService.getUserInfo;
const generateState = oidcService.generateState;
const generateNonce = oidcService.generateNonce;

const router = express.Router();

const stateStore = new Map<string, { nonce: string; timestamp: number; origin: string }>();

setInterval(() => {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.timestamp > 5 * 60 * 1000) {
      stateStore.delete(state);
    }
  }
}, 5 * 60 * 1000);

// Fonction pour convertir l'origin backend vers l'origin frontend
function getFrontendOrigin(backendOrigin: string): string {
  try {
    const url = new URL(backendOrigin);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${url.hostname}${port}`;
  } catch (e) {
    console.warn('[OIDC] Invalid backend origin:', backendOrigin);
    return backendOrigin;
  }
}

// Keycloak (/auth/*) et /api/* ne sont servis QUE par Caddy (port 80 en HTTP, 443 en HTTPS).
// Si la requête arrive sur un port direct (frontend 3000 ou backend 3002), il faut ramener
// l'origine sur Caddy en supprimant le port, sinon l'URL Keycloak générée serait injoignable
// (ex: http://<ip>:3002/auth/realms/ryvie n'existe pas, le backend ne proxie pas /auth).
function normalizeOriginToCaddy(protocol: string, hostname: string, _port?: string): string {
  // On ignore toujours le port : le flux SSO (Keycloak + /api) ne transite que par Caddy
  // sur les ports par défaut (80 en HTTP, 443 en HTTPS).
  return `${protocol}://${hostname}`;
}

// Fonction pour détecter l'origine de la requête
function getOriginFromRequest(req: any): string {
  // Priorité 1: utiliser le host de la requête (l'URL réellement demandée)
  // Cela permet au frontend de contrôler l'origin en redirigeant vers l'IP
  const protocol = req.protocol || 'http';
  const host = req.get('host');

  if (host) {
    const [hostname, port] = host.split(':');
    const origin = normalizeOriginToCaddy(protocol, hostname, port);
    console.log('[OIDC] Origin from request host:', origin, '(raw host:', host + ')');
    return origin;
  }

  // Fallback sur referer/origin header
  const referer = req.get('referer') || req.get('origin');
  if (referer) {
    try {
      const url = new URL(referer);
      const origin = normalizeOriginToCaddy(url.protocol.replace(':', ''), url.hostname, url.port);
      console.log('[OIDC] Origin from referer:', origin);
      return origin;
    } catch (e) {
      console.warn('[OIDC] Invalid referer/origin:', referer);
    }
  }

  console.warn('[OIDC] No valid origin found, using localhost fallback');
  return 'http://localhost';
}

router.get('/health', async (req: any, res: any) => {
  try {
    // Live check: fetch Keycloak's well-known endpoint via Caddy
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`http://localhost/auth/realms/ryvie/.well-known/openid-configuration`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.ok) {
      res.json({ ready: true });
    } else {
      res.status(503).json({ ready: false, error: `Keycloak returned ${response.status}` });
    }
  } catch (error: any) {
    res.status(503).json({ ready: false, error: error.message });
  }
});

router.get('/login', async (req: any, res: any) => {
  try {
    const origin = getOriginFromRequest(req);
    console.log('[OIDC] Detected origin:', origin);
    
    await getOIDCConfig();

    const state = generateState();
    const nonce = generateNonce();

    stateStore.set(state, { nonce, timestamp: Date.now(), origin });

    const authUrl = await generateAuthUrl(state, nonce, origin);
    
    console.log('[OIDC] Redirecting to Keycloak:', authUrl);
    res.redirect(authUrl);
  } catch (error: any) {
    console.error('[OIDC] Login error:', error.message);
    res.status(500).json({ error: 'Failed to initiate authentication' });
  }
});

router.get('/callback', async (req: any, res: any) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      console.warn('[OIDC] Callback missing code or state, redirecting to login');
      const origin = getOriginFromRequest(req);
      const frontendOrigin = getFrontendOrigin(origin);
      return res.redirect(`${frontendOrigin}/#/login?error=missing_params`);
    }

    const storedData = stateStore.get(state as string);
    if (!storedData) {
      console.warn('[OIDC] Invalid or expired state, redirecting to login');
      const origin = getOriginFromRequest(req);
      const frontendOrigin = getFrontendOrigin(origin);
      return res.redirect(`${frontendOrigin}/#/login?error=session_expired`);
    }

    const { nonce, origin } = storedData;
    stateStore.delete(state as string);

    const tokens = await exchangeCodeForTokens(code as string, state as string, nonce, origin);
    
    const userinfo = await getUserInfo(tokens.accessToken!, origin);

    // Déterminer le rôle depuis LDAP basé sur les groupes
    const uid = userinfo.preferred_username || userinfo.sub;
    
    // Chercher le DN de l'utilisateur dans LDAP
    const ldap = require('ldapjs');
    const ldapConfig = require('../config/ldap');
    
    let userDN = null;
    let role = 'Guest';
    
    try {
      const ldapClient = ldapService.createSafeClient();
      await new Promise((resolve, reject) => {
        ldapClient.bind(ldapConfig.bindDN, ldapConfig.bindPassword, (err: any) => {
          if (err) return reject(err);
          
          const filter = `(&(objectClass=inetOrgPerson)(uid=${ldapService.escapeLdapFilterValue(uid)}))`;
          ldapClient.search(ldapConfig.userSearchBase, { filter, scope: 'sub', attributes: ['dn'] }, (err2: any, res: any) => {
            if (err2) return reject(err2);
            
            res.on('searchEntry', (entry: any) => {
              userDN = entry.pojo.objectName;
            });
            
            res.on('end', async () => {
              ldapClient.unbind();
              if (userDN) {
                role = await ldapService.getUserRole(userDN);
              }
              resolve(null);
            });
          });
        });
      });
    } catch (error: any) {
      console.warn(`[OIDC] Failed to get user DN from LDAP for ${uid}:`, error.message);
    }

    console.log(`[OIDC] Role determined for ${uid}: ${role} (DN: ${userDN || 'not found'})`);

    const user = {
      uid,
      name: (userinfo.name || userinfo.preferred_username || '').split(' ')[0],
      email: userinfo.email,
      role,
      language: userinfo.locale || 'fr',
      idToken: tokens.idToken,
    };

    const token = signToken(user);
    await allowlistToken(token, user);

    console.log(`[OIDC] Authentication successful for ${user.uid} (role: ${role})`);

    const frontendOrigin = getFrontendOrigin(origin);
    console.log('[OIDC] Redirecting to frontend:', frontendOrigin, '(from backend origin:', origin + ')');
    res.redirect(`${frontendOrigin}/#/auth-callback?token=${token}`);
  } catch (error: any) {
    console.error('[OIDC] Callback error:', error.message);
    const origin = getOriginFromRequest(req);
    const frontendOrigin = getFrontendOrigin(origin);
    res.redirect(`${frontendOrigin}/#/login?error=auth_failed`);
  }
});

// Switch user step 1: redirect browser to KC logout (destroys session cookie),
// then KC redirects to /api/auth/switch-login with login_hint
router.get('/switch', async (req: any, res: any) => {
  try {
    const origin = getOriginFromRequest(req);
    const loginHint = req.query.login_hint || '';
    console.log('[OIDC] Switch user - origin:', origin, 'login_hint:', loginHint || '(none)');
    
    const url = new URL(origin);
    const issuer = `http://${url.hostname}${url.port ? ':' + url.port : ''}/auth/realms/ryvie`;
    
    // Redirect to KC logout with client_id (post.logout.redirect.uris=+ allows any redirect)
    // This destroys the KC session cookie in the browser
    const postLogoutRedirect = `${origin}/api/auth/switch-login?login_hint=${encodeURIComponent(loginHint)}`;
    const logoutUrl = `${issuer}/protocol/openid-connect/logout?client_id=ryvie-dashboard&post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirect)}`;
    
    console.log('[OIDC] Switch - logout then redirect:', logoutUrl);
    res.redirect(logoutUrl);
  } catch (error: any) {
    console.error('[OIDC] Switch error:', error.message);
    res.status(500).json({ error: 'Failed to initiate user switch' });
  }
});

// Switch user step 2: after KC logout, initiate fresh login with login_hint
router.get('/switch-login', async (req: any, res: any) => {
  try {
    const origin = getOriginFromRequest(req);
    const loginHint = req.query.login_hint || '';
    console.log('[OIDC] Switch-login - origin:', origin, 'login_hint:', loginHint || '(none)');
    
    await getOIDCConfig();

    const state = generateState();
    const nonce = generateNonce();

    stateStore.set(state, { nonce, timestamp: Date.now(), origin });

    const authUrl = await generateAuthUrl(state, nonce, origin);
    let switchUrl = authUrl;
    if (loginHint) {
      switchUrl += `&login_hint=${encodeURIComponent(loginHint)}`;
    }
    
    console.log('[OIDC] Switch-login - redirecting to Keycloak:', switchUrl);
    res.redirect(switchUrl);
  } catch (error: any) {
    console.error('[OIDC] Switch-login error:', error.message);
    res.status(500).json({ error: 'Failed to initiate user switch login' });
  }
});

router.get('/logout', async (req: any, res: any) => {
  try {
    const idToken = req.query.id_token;
    const origin = getOriginFromRequest(req);
    const frontendOrigin = getFrontendOrigin(origin);
    
    const url = new URL(origin);
    const issuer = `http://${url.hostname}${url.port ? ':' + url.port : ''}/auth/realms/ryvie`;
    const logoutUrl = `${issuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(frontendOrigin)}${idToken ? `&id_token_hint=${idToken}` : ''}`;

    console.log('[OIDC] Logging out from backend origin:', origin);
    console.log('[OIDC] Frontend origin:', frontendOrigin);
    console.log('[OIDC] Redirecting to:', logoutUrl);
    res.redirect(logoutUrl);
  } catch (error: any) {
    console.error('[OIDC] Logout error:', error.message);
    const origin = getOriginFromRequest(req);
    const frontendOrigin = getFrontendOrigin(origin);
    res.redirect(`${frontendOrigin}/#/login`);
  }
});

export = router;
