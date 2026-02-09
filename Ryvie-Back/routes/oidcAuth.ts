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

// Fonction pour détecter l'origine de la requête
function getOriginFromRequest(req: any): string {
  const referer = req.get('referer') || req.get('origin');
  
  if (referer) {
    try {
      const url = new URL(referer);
      return `${url.protocol}//${url.host}`;
    } catch (e) {
      console.warn('[OIDC] Invalid referer/origin:', referer);
    }
  }
  
  // Fallback sur l'host de la requête
  const protocol = req.protocol || 'http';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

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
      return res.status(400).json({ error: 'Missing code or state' });
    }

    const storedData = stateStore.get(state as string);
    if (!storedData) {
      return res.status(400).json({ error: 'Invalid or expired state' });
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
      const ldapClient = ldap.createClient({ url: ldapConfig.url });
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

    console.log('[OIDC] Redirecting to frontend:', origin);
    res.redirect(`${origin}/#/auth-callback?token=${token}`);
  } catch (error: any) {
    console.error('[OIDC] Callback error:', error.message);
    const origin = getOriginFromRequest(req);
    res.redirect(`${origin}/#/login?error=auth_failed`);
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
    const issuer = `http://${url.hostname}:3005/realms/ryvie`;
    
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
    
    const url = new URL(origin);
    const issuer = `http://${url.hostname}:3005/realms/ryvie`;
    const logoutUrl = `${issuer}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(origin)}${idToken ? `&id_token_hint=${idToken}` : ''}`;

    console.log('[OIDC] Logging out from origin:', origin);
    console.log('[OIDC] Redirecting to:', logoutUrl);
    res.redirect(logoutUrl);
  } catch (error: any) {
    console.error('[OIDC] Logout error:', error.message);
    const origin = getOriginFromRequest(req);
    res.redirect(`${origin}/#/login`);
  }
});

export = router;
