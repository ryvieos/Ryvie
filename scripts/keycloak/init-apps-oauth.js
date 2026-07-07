#!/usr/bin/env node
/**
 * Script pour initialiser/synchroniser la configuration OAuth
 * des apps SSO déjà installées.
 *
 * Détecte automatiquement les apps avec sso:true dans leur manifest.
 * Stocke les secrets dans /data/config/keycloak/apps-oauth.json
 */

const appsOAuthService = require('../Ryvie-Back/dist/services/appsOAuthService');

async function main() {
  console.log('🔐 Synchronisation OAuth des apps SSO...\n');

  const ssoApps = appsOAuthService.listSsoApps();

  if (ssoApps.length === 0) {
    console.log('ℹ️  Aucune app SSO détectée dans les manifests');
    return;
  }

  console.log(`� ${ssoApps.length} app(s) SSO détectée(s): ${ssoApps.map(a => a.appId).join(', ')}\n`);

  for (const app of ssoApps) {
    try {
      console.log(`📦 ${app.appId} (env: ${app.envPath})...`);
      const ok = await appsOAuthService.provisionAppOAuth(app.appId);
      console.log(ok ? `✅ ${app.appId} OK\n` : `⚠️  ${app.appId} : échec\n`);
    } catch (error) {
      console.error(`❌ ${app.appId}:`, error.message, '\n');
    }
  }

  console.log('✅ Synchronisation terminée !');
  console.log('   Secrets stockés dans /data/config/keycloak/apps-oauth.json');
  console.log('   ⚠️  Redémarrer les apps modifiées : docker compose down && docker compose up -d\n');
}

main().catch(error => {
  console.error('❌ Erreur fatale:', error);
  process.exit(1);
});
