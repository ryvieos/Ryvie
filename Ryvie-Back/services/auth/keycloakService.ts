export {};
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const KEYCLOAK_DATA_DIR = '/data/config/keycloak';
const KEYCLOAK_CODE_DIR = '/opt/Ryvie/keycloak';
const KEYCLOAK_ENV_DATA = path.join(KEYCLOAK_DATA_DIR, '.env');
const KEYCLOAK_ENV_CODE = path.join(KEYCLOAK_CODE_DIR, '.env');
const REALM_SOURCE = path.join(KEYCLOAK_CODE_DIR, 'import', 'ryvie-realm.json');
const REALM_DEST = path.join(KEYCLOAK_DATA_DIR, 'import', 'ryvie-realm.json');
const DOCKER_COMPOSE_FILE = path.join(KEYCLOAK_CODE_DIR, 'docker-compose.yml');

const BACKEND_ENV_DATA = '/data/config/backend-view/.env';
const BACKEND_ENV_CODE = '/opt/Ryvie/Ryvie-Back/.env';

const DASHBOARD_CLIENT_ID = 'ryvie-dashboard';
const MANIFESTS_DIR = '/data/config/manifests';

const REQUIRED_DIRS = [
  KEYCLOAK_DATA_DIR,
  path.join(KEYCLOAK_DATA_DIR, 'import'),
  path.join(KEYCLOAK_DATA_DIR, 'themes'),
  path.join(KEYCLOAK_DATA_DIR, 'postgres'),
];

const REQUIRED_ENV_KEYS = ['KEYCLOAK_ADMIN', 'KEYCLOAK_ADMIN_PASSWORD', 'KEYCLOAK_DB_PASSWORD'];

/**
 * Génère un mot de passe aléatoire URL-safe
 */
function generatePassword(length = 32): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

/**
 * Vérifie qu'un fichier .env contient les 3 clés requises
 */
function envHasRequiredKeys(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, 'utf8');
    return REQUIRED_ENV_KEYS.every(key => content.includes(`${key}=`));
  } catch {
    return false;
  }
}

/**
 * Génère un fichier .env Keycloak avec des mots de passe aléatoires
 */
function generateEnvFile(targetPath: string): void {
  const adminPass = generatePassword();
  const dbPass = generatePassword();
  const lines = [
    '# Keycloak Admin',
    'KEYCLOAK_ADMIN=admin',
    `KEYCLOAK_ADMIN_PASSWORD=${adminPass}`,
    '',
    '# Keycloak Database',
    `KEYCLOAK_DB_PASSWORD=${dbPass}`,
    '',
  ];
  const content = lines.join('\n');
  try {
    fs.writeFileSync(targetPath, content, 'utf8');
  } catch {
    const tmpFile = '/tmp/keycloak-env-' + Date.now();
    fs.writeFileSync(tmpFile, content, 'utf8');
    execSync(`sudo cp ${tmpFile} ${targetPath} && rm ${tmpFile}`, { stdio: 'pipe', timeout: 10000 });
  }
}

/**
 * Vérifie si un dossier est accessible en écriture par le processus courant
 */
function isWritable(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exécute une commande avec sudo si nécessaire
 */
function sudoExec(cmd: string): void {
  execSync(`sudo ${cmd}`, { stdio: 'pipe', timeout: 10000 });
}

/**
 * Crée les dossiers nécessaires dans /data/config/keycloak
 * Utilise sudo si le dossier parent n'est pas accessible en écriture
 */
function ensureDirectories(): void {
  for (const dir of REQUIRED_DIRS) {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        sudoExec(`mkdir -p ${dir}`);
        sudoExec(`chown -R $(whoami):$(whoami) ${dir}`);
      }
      console.log(`[keycloak] 📁 Dossier créé : ${dir}`);
    }
  }
  // S'assurer que tout le dossier est accessible en écriture
  if (!isWritable(KEYCLOAK_DATA_DIR)) {
    console.log('[keycloak] 🔐 Correction des permissions sur', KEYCLOAK_DATA_DIR);
    sudoExec(`chown -R $(whoami):$(whoami) ${KEYCLOAK_DATA_DIR}`);
  }
}

/**
 * Gère le .env Keycloak :
 * 1. Si /data/config/keycloak/.env existe et valide → copie vers /opt/Ryvie/keycloak/
 * 2. Si /opt/Ryvie/keycloak/.env existe et valide → copie vers /data/config/keycloak/
 * 3. Sinon → génère dans /data/config/keycloak/ et copie vers /opt/Ryvie/keycloak/
 */
function filesAreIdentical(fileA: string, fileB: string): boolean {
  try {
    if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return false;
    return fs.readFileSync(fileA, 'utf8') === fs.readFileSync(fileB, 'utf8');
  } catch {
    return false;
  }
}

function ensureEnvFile(): void {
  if (envHasRequiredKeys(KEYCLOAK_ENV_DATA)) {
    if (filesAreIdentical(KEYCLOAK_ENV_DATA, KEYCLOAK_ENV_CODE)) {
      console.log('[keycloak] ✅ .env déjà synchronisé');
    } else {
      fs.copyFileSync(KEYCLOAK_ENV_DATA, KEYCLOAK_ENV_CODE);
      console.log(`[keycloak] ✅ .env copié depuis ${KEYCLOAK_ENV_DATA}`);
    }
  } else if (envHasRequiredKeys(KEYCLOAK_ENV_CODE)) {
    if (filesAreIdentical(KEYCLOAK_ENV_CODE, KEYCLOAK_ENV_DATA)) {
      console.log('[keycloak] ✅ .env déjà synchronisé');
    } else {
      fs.copyFileSync(KEYCLOAK_ENV_CODE, KEYCLOAK_ENV_DATA);
      console.log(`[keycloak] ✅ .env copié depuis ${KEYCLOAK_ENV_CODE}`);
    }
  } else {
    generateEnvFile(KEYCLOAK_ENV_DATA);
    fs.copyFileSync(KEYCLOAK_ENV_DATA, KEYCLOAK_ENV_CODE);
    console.log('[keycloak] 🔑 .env généré avec mots de passe aléatoires');
  }
}

/**
 * Synchronise le realm JSON source vers /data/config/keycloak/import/
 */
function syncRealmJson(): void {
  if (!fs.existsSync(REALM_SOURCE)) {
    console.warn(`[keycloak] ⚠️  Realm JSON source introuvable : ${REALM_SOURCE}`);
    return;
  }
  if (filesAreIdentical(REALM_SOURCE, REALM_DEST)) {
    console.log('[keycloak] ✅ Realm JSON déjà à jour');
    return;
  }
  fs.copyFileSync(REALM_SOURCE, REALM_DEST);
  console.log(`[keycloak] ✅ Realm JSON synchronisé vers ${REALM_DEST}`);
}

/**
 * Synchronise les thèmes depuis /opt/Ryvie/keycloak/themes/ vers /data/config/keycloak/themes/
 * Compare les fichiers et ne copie que si le contenu a changé
 */
function syncThemes(): void {
  const themesSource = path.join(KEYCLOAK_CODE_DIR, 'themes');
  const themesDest = path.join(KEYCLOAK_DATA_DIR, 'themes');
  if (!fs.existsSync(themesSource)) {
    console.warn(`[keycloak] ⚠️  Dossier themes source introuvable : ${themesSource}`);
    return;
  }
  try {
    // Comparer les dossiers — diff retourne exit 1 si différent
    try {
      execSync(`diff -rq ${themesSource}/ryvie ${themesDest}/ryvie 2>/dev/null`, { stdio: 'pipe', timeout: 10000 });
      console.log('[keycloak] ✅ Thèmes déjà à jour');
      return;
    } catch {
      // Différences détectées ou dossier dest n'existe pas → copier
    }
    try {
      execSync(`cp -r ${themesSource}/* ${themesDest}/`, { stdio: 'pipe', timeout: 10000 });
    } catch {
      sudoExec(`cp -r ${themesSource}/* ${themesDest}/`);
    }
    console.log(`[keycloak] ✅ Thèmes mis à jour dans ${themesDest}`);
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de synchroniser les thèmes:', err.message);
  }
}

/**
 * Vérifie si le conteneur Keycloak est en cours d'exécution
 */
function isKeycloakRunning(): boolean {
  try {
    const output = execSync(
      'docker ps --filter "name=^keycloak$" --filter "status=running" -q',
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Crée le réseau Docker ryvie-network si nécessaire
 */
function ensureDockerNetwork(): void {
  try {
    execSync('docker network inspect ryvie-network', {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    try {
      execSync('docker network create ryvie-network', { stdio: 'pipe', timeout: 10000 });
      console.log('[keycloak] 🌐 Réseau Docker ryvie-network créé');
    } catch (createErr: any) {
      console.warn('[keycloak] ⚠️  Impossible de créer ryvie-network:', createErr.message);
    }
  }
}

/**
 * S'assure que le conteneur openldap est connecté au réseau ryvie-network.
 *
 * Keycloak a besoin de joindre openldap:1389 pour l'import du realm (fédération LDAP).
 * Si openldap tourne mais n'est pas sur ryvie-network, Keycloak crashe au démarrage.
 */
function ensureLdapOnNetwork(): void {
  try {
    // Vérifier si le conteneur openldap existe et tourne
    const ldapRunning = execSync(
      'docker ps --filter "name=^openldap$" --filter "status=running" -q',
      { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();

    if (!ldapRunning) {
      console.log('[keycloak] ℹ️  Conteneur openldap non trouvé ou arrêté, vérification réseau ignorée');
      return;
    }

    // Vérifier si openldap est déjà sur ryvie-network
    const networks = execSync(
      'docker inspect openldap --format \'{{json .NetworkSettings.Networks}}\'',
      { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();

    if (networks.includes('ryvie-network')) {
      console.log('[keycloak] ✅ openldap déjà connecté à ryvie-network');
      return;
    }

    // Connecter openldap à ryvie-network
    execSync('docker network connect ryvie-network openldap', {
      stdio: 'pipe',
      timeout: 15000,
    });
    console.log('[keycloak] 🌐 openldap connecté à ryvie-network');
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de vérifier/connecter openldap à ryvie-network:', err.message);
  }
}

/**
 * Démarre Keycloak via docker compose
 */
function startKeycloak(): void {
  console.log('[keycloak] 🚀 Démarrage de Keycloak...');
  const { composeUpWithRecovery } = require('../system/dockerService');
  const cmd = `docker compose -f "${DOCKER_COMPOSE_FILE}" --env-file "${KEYCLOAK_ENV_CODE}" up -d`;
  try {
    composeUpWithRecovery(cmd, { cwd: KEYCLOAK_CODE_DIR, timeout: 120000, label: 'keycloak' });
    console.log('[keycloak] ✅ Keycloak démarré');
  } catch (err: any) {
    console.error('[keycloak] ❌ Erreur lors du démarrage de Keycloak:', err.message);
  }
}

/**
 * Récupère le mot de passe admin depuis le .env Keycloak
 */
function getAdminPassword(): string {
  try {
    const content = fs.readFileSync(KEYCLOAK_ENV_CODE, 'utf8');
    const match = content.match(/^KEYCLOAK_ADMIN_PASSWORD=(.+)$/m);
    return match ? match[1].trim() : 'admin';
  } catch {
    return 'admin';
  }
}

/**
 * Attend que Keycloak soit prêt à recevoir des requêtes (health check via HTTP)
 */
async function waitForKeycloakReady(maxWaitMs = 120000, intervalMs = 2000): Promise<boolean> {
  const start = Date.now();
  console.log('[keycloak] ⏳ Attente que Keycloak soit prêt...');
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch('http://localhost/auth/realms/ryvie/.well-known/openid-configuration', {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        console.log('[keycloak] ✅ Keycloak est prêt');
        return true;
      }
    } catch {
      // pas encore prêt
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  console.error('[keycloak] ❌ Timeout en attendant Keycloak');
  return false;
}

/**
 * Authentifie kcadm.sh une seule fois. Les appels suivants réutilisent la session.
 */
function kcadmAuth(): void {
  const adminPass = getAdminPassword();
  execSync(
    `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth --realm master --user admin --password "${adminPass}"`,
    { stdio: 'pipe', timeout: 15000 }
  );
}

/**
 * Vérifie si le client ryvie-dashboard existe dans Keycloak via kcadm.sh
 * Assumes kcadmAuth() was already called.
 */
function dashboardClientExists(): boolean {
  try {
    const output = execSync(
      'docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie --fields clientId',
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    );
    return output.includes(`"${DASHBOARD_CLIENT_ID}"`);
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de vérifier les clients:', err.message);
    return false;
  }
}

/**
 * Crée le client ryvie-dashboard dans Keycloak via kcadm.sh et met à jour le realm JSON
 * Retourne le secret généré
 */
function createDashboardClient(): string {
  const clientSecret = crypto.randomBytes(32).toString('hex');

  // Créer le client via l'API admin
  const clientJson = JSON.stringify({
    clientId: DASHBOARD_CLIENT_ID,
    name: 'Ryvie Dashboard',
    description: 'OAuth client for Ryvie Dashboard',
    enabled: true,
    clientAuthenticatorType: 'client-secret',
    secret: clientSecret,
    redirectUris: ['*'],
    webOrigins: ['*'],
    standardFlowEnabled: true,
    directAccessGrantsEnabled: true,
    publicClient: false,
    protocol: 'openid-connect',
    attributes: { 'post.logout.redirect.uris': '+' },
  });

  execSync(
    `echo '${clientJson.replace(/'/g, "'\\''")}' | docker exec -i keycloak /opt/keycloak/bin/kcadm.sh create clients -r ryvie -f -`,
    { stdio: 'pipe', timeout: 15000 }
  );

  console.log('[keycloak] ✅ Client ryvie-dashboard créé dans Keycloak');

  // Ajouter aussi au realm JSON pour persistance
  addClientToRealmJson(clientSecret);

  return clientSecret;
}

/**
 * Ajoute le client ryvie-dashboard au fichier realm JSON
 */
function addClientToRealmJson(clientSecret: string): void {
  try {
    const realmFile = fs.existsSync(REALM_DEST) ? REALM_DEST : REALM_SOURCE;
    const realm = JSON.parse(fs.readFileSync(realmFile, 'utf8'));

    // Supprimer l'ancien client s'il existe
    realm.clients = (realm.clients || []).filter((c: any) => c.clientId !== DASHBOARD_CLIENT_ID);

    // Ajouter le nouveau
    realm.clients.push({
      clientId: DASHBOARD_CLIENT_ID,
      name: 'Ryvie Dashboard',
      description: 'OAuth client for Ryvie Dashboard',
      enabled: true,
      clientAuthenticatorType: 'client-secret',
      secret: clientSecret,
      redirectUris: ['*'],
      webOrigins: ['*'],
      standardFlowEnabled: true,
      directAccessGrantsEnabled: true,
      publicClient: false,
      protocol: 'openid-connect',
      attributes: { 'post.logout.redirect.uris': '+' },
    });

    // Écrire dans les deux emplacements
    const content = JSON.stringify(realm, null, 2);
    if (fs.existsSync(REALM_DEST)) {
      fs.writeFileSync(REALM_DEST, content, 'utf8');
    }
    fs.writeFileSync(REALM_SOURCE, content, 'utf8');
    console.log('[keycloak] ✅ Client ryvie-dashboard ajouté au realm JSON');
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de mettre à jour le realm JSON:', err.message);
  }
}

/**
 * Met à jour ou ajoute une variable dans un fichier .env
 */
function setEnvVar(filePath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // fichier n'existe pas encore
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  const exactLine = `${key}=${value}`;
  // Si la valeur est déjà correcte, ne rien faire
  if (regex.test(content) && content.match(regex)![0] === exactLine) {
    return;
  }

  if (regex.test(content)) {
    content = content.replace(regex, exactLine);
  } else {
    content = content.trimEnd() + `\n${exactLine}\n`;
  }

  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch {
    const tmpFile = `/tmp/env-update-${Date.now()}`;
    fs.writeFileSync(tmpFile, content, 'utf8');
    execSync(`sudo cp ${tmpFile} ${filePath} && rm ${tmpFile}`, { stdio: 'pipe', timeout: 10000 });
  }
}

/**
 * Met à jour les .env du backend avec le client_id et secret du dashboard
 */
function updateBackendEnv(clientSecret: string): void {
  const envFiles = [BACKEND_ENV_DATA, BACKEND_ENV_CODE];
  for (const envFile of envFiles) {
    try {
      setEnvVar(envFile, 'OIDC_CLIENT_ID', DASHBOARD_CLIENT_ID);
      setEnvVar(envFile, 'OIDC_CLIENT_SECRET', clientSecret);
      console.log(`[keycloak] ✅ .env backend mis à jour : ${envFile}`);
    } catch (err: any) {
      console.warn(`[keycloak] ⚠️  Impossible de mettre à jour ${envFile}:`, err.message);
    }
  }
}

/**
 * Récupère le secret du client ryvie-dashboard existant depuis Keycloak
 */
function getDashboardClientSecret(): string | null {
  try {
    // Récupérer l'ID interne du client
    const clientsJson = execSync(
      'docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie --fields id,clientId',
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    );
    const clients = JSON.parse(clientsJson);
    const dashboard = clients.find((c: any) => c.clientId === DASHBOARD_CLIENT_ID);
    if (!dashboard) return null;

    // Récupérer le secret
    const secretJson = execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients/${dashboard.id}/client-secret -r ryvie`,
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    );
    const secretObj = JSON.parse(secretJson);
    return secretObj.value || null;
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de récupérer le secret du dashboard:', err.message);
    return null;
  }
}

/**
 * S'assure que le client ryvie-dashboard existe et que les .env backend sont à jour
 */
async function ensureDashboardClient(): Promise<void> {
  console.log('[keycloak] 🔍 Vérification du client ryvie-dashboard...');

  if (dashboardClientExists()) {
    console.log('[keycloak] ✅ Client ryvie-dashboard existe déjà');
    // Vérifier que le .env backend a le bon secret
    const secret = getDashboardClientSecret();
    if (secret) {
      updateBackendEnv(secret);
    }
  } else {
    console.log('[keycloak] 📝 Création du client ryvie-dashboard...');
    const secret = createDashboardClient();
    updateBackendEnv(secret);
  }
}

/**
 * Synchronise les secrets de tous les clients custom du realm JSON vers Keycloak.
 *
 * Pourquoi : Keycloak importe le realm avec la stratégie IGNORE_EXISTING, ce qui
 * signifie que si un client existe déjà en base, son secret n'est PAS mis à jour
 * depuis le fichier JSON. Keycloak stocke les secrets hashés en interne, et ce hash
 * peut diverger silencieusement du secret en clair dans le realm JSON (par exemple
 * après une régénération via l'admin UI ou un re-hash interne).
 *
 * Cette fonction force le secret du realm JSON dans Keycloak via kcadm.sh update,
 * ce qui re-hashe le secret en base et garantit la cohérence.
 */
function syncClientSecrets(): void {
  console.log('[keycloak] 🔑 Synchronisation des secrets clients...');

  const realmPath = fs.existsSync(REALM_DEST) ? REALM_DEST : REALM_SOURCE;
  if (!fs.existsSync(realmPath)) {
    console.warn('[keycloak] ⚠️  Realm JSON introuvable, sync secrets ignorée');
    return;
  }

  let realm: any;
  try {
    realm = JSON.parse(fs.readFileSync(realmPath, 'utf8'));
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de lire le realm JSON:', err.message);
    return;
  }

  const internalClients = ['account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console'];
  const customClients = (realm.clients || []).filter(
    (c: any) => c.secret && !internalClients.includes(c.clientId)
  );

  if (customClients.length === 0) {
    console.log('[keycloak] ℹ️  Aucun client custom avec secret dans le realm JSON');
    return;
  }

  let syncCount = 0;
  for (const client of customClients) {
    try {
      const clientsJson = execSync(
        `docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie -q clientId=${client.clientId} --fields id`,
        { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
      );
      const clients = JSON.parse(clientsJson);
      if (!clients.length) continue;

      execSync(
        `docker exec keycloak /opt/keycloak/bin/kcadm.sh update clients/${clients[0].id} -r ryvie -s secret=${client.secret}`,
        { stdio: 'pipe', timeout: 15000 }
      );
      syncCount++;
    } catch (err: any) {
      console.warn(`[keycloak] ⚠️  Échec sync secret pour ${client.clientId}:`, err.message);
    }
  }

  console.log(`[keycloak] ✅ ${syncCount}/${customClients.length} secret(s) synchronisé(s)`);
}

/**
 * Point d'entrée principal : s'assure que Keycloak est configuré et en cours d'exécution.
 * Appelé au démarrage du backend dans index.ts → startServer()
 */
async function ensureKeycloakRunning(): Promise<{ success: boolean; alreadyRunning?: boolean; started?: boolean; error?: string }> {
  try {
    console.log('[keycloak] 🔐 Vérification de Keycloak...');

    // 1. Dossiers
    ensureDirectories();

    // 2. .env
    ensureEnvFile();

    // 3. Realm JSON
    syncRealmJson();

    // 3b. Thèmes
    syncThemes();

    // 4. Réseau Docker
    ensureDockerNetwork();

    // 4b. S'assurer que openldap est sur ryvie-network (requis pour l'import realm LDAP)
    ensureLdapOnNetwork();

    // 5. Toujours exécuter docker compose up -d pour détecter les changements de config
    // (idempotent : ne recrée le container que si la config a changé)
    const wasRunning = isKeycloakRunning();
    startKeycloak();
    const wasStarted = !wasRunning;

    // 6. Attendre que Keycloak soit prêt
    const ready = await waitForKeycloakReady();
    if (!ready) {
      return { success: false, error: 'Keycloak non prêt après timeout' };
    }

    // 6b. Authentifier kcadm.sh une seule fois pour toutes les opérations suivantes
    kcadmAuth();

    // 7. S'assurer que le client ryvie-dashboard existe et .env backend à jour
    await ensureDashboardClient();

    // 7b. Forcer les secrets du realm JSON dans Keycloak (évite les désync après import IGNORE_EXISTING)
    syncClientSecrets();

    // 8. S'assurer que le thème ryvie est appliqué au realm
    ensureRealmTheme();

    // 8b. Migration idempotente : configuration OIDC STANDARD pour LDAP
    // (uid = login = preferred_username ; cn = nom d'affichage = claim name ;
    // sub = identité stable). Compatible avec toutes les apps, sans bidouille.
    await ensureStandardLdapMapping();

    // 9. Provisionnement SSO apps géré par appsOAuthService.syncAllAppsOAuth() dans index.ts

    return { success: true, alreadyRunning: !wasStarted, started: wasStarted };
  } catch (err: any) {
    console.error('[keycloak] ❌ Erreur lors du setup Keycloak:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Configure le thème login du realm ryvie sur 'ryvie' via kcadm.sh
 */
function ensureRealmTheme(): void {
  try {
    // Vérifier le thème et la locale actuels
    const realmJson = execSync(
      'docker exec keycloak /opt/keycloak/bin/kcadm.sh get realms/ryvie --fields loginTheme,internationalizationEnabled,defaultLocale',
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    );
    const realm = JSON.parse(realmJson);
    if (realm.loginTheme === 'ryvie' && realm.internationalizationEnabled === true && realm.defaultLocale === 'fr') {
      console.log('[keycloak] ✅ Thème login ryvie et locale FR déjà appliqués');
      return;
    }
    // Appliquer le thème + internationalisation FR
    execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh update realms/ryvie -s loginTheme=ryvie -s internationalizationEnabled=true -s 'supportedLocales=["fr","en"]' -s defaultLocale=fr`,
      { stdio: 'pipe', timeout: 15000 }
    );
    console.log('[keycloak] ✅ Thème login ryvie + locale FR appliqués au realm');
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  Impossible de configurer le thème:', err.message);
  }
}

/**
 * Vérifie si un client Keycloak existe dans le realm ryvie
 */
function keycloakClientExists(clientId: string): boolean {
  try {
    const result = execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie --fields clientId -q clientId=${clientId}`,
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    );
    return result.includes(clientId);
  } catch {
    return false;
  }
}

/**
 * Récupère le secret d'un client Keycloak depuis le realm JSON
 */
function getClientSecretFromRealm(clientId: string): string | null {
  try {
    const realmPath = fs.existsSync(REALM_DEST) ? REALM_DEST : REALM_SOURCE;
    const realm = JSON.parse(fs.readFileSync(realmPath, 'utf8'));
    const client = (realm.clients || []).find((c: any) => c.clientId === clientId);
    return client?.secret || null;
  } catch {
    return null;
  }
}

/**
 * Supprime le client SSO d'une app lors de sa désinstallation.
 * - Supprime le client dans Keycloak via kcadm.sh
 * - Supprime le client du realm JSON (source + dest)
 * - Supprime les rôles client associés du realm JSON
 */
function removeAppSSOClient(appId: string): void {
  const clientId = `ryvie-${appId}`;

  // 1) Lire le manifest pour vérifier si l'app avait sso: true
  const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest.sso) {
        console.log(`[keycloak] ℹ️  SSO non activé pour ${appId}, pas de client à supprimer`);
        return;
      }
    } catch {
      // En cas d'erreur de lecture, on tente quand même la suppression
    }
  }

  console.log(`[keycloak] 🗑️  Suppression du client SSO ${clientId}...`);

  // 2) Supprimer en live dans Keycloak si accessible
  try {
    const isRunning = execSync(
      'docker ps --filter "name=keycloak" --filter "status=running" -q',
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();

    if (isRunning) {
      kcadmAuth();

      // Trouver l'ID interne du client
      const clientsJson = execSync(
        `docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie -q clientId=${clientId} --fields id`,
        { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
      );
      const clients = JSON.parse(clientsJson);

      if (clients.length > 0) {
        execSync(
          `docker exec keycloak /opt/keycloak/bin/kcadm.sh delete clients/${clients[0].id} -r ryvie`,
          { stdio: 'pipe', timeout: 15000 }
        );
        console.log(`[keycloak]    ✅ Client ${clientId} supprimé de Keycloak`);
      } else {
        console.log(`[keycloak]    ℹ️  Client ${clientId} non trouvé dans Keycloak (déjà supprimé ?)`);
      }
    } else {
      console.log(`[keycloak]    ℹ️  Keycloak non accessible, suppression live ignorée`);
    }
  } catch (err: any) {
    console.warn(`[keycloak]    ⚠️  Erreur suppression live de ${clientId}:`, err.message);
  }

  // 3) Supprimer l'entrée dans apps-oauth.json pour forcer la re-création au prochain install
  const APPS_OAUTH_FILE = '/data/config/keycloak/apps-oauth.json';
  try {
    if (fs.existsSync(APPS_OAUTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(APPS_OAUTH_FILE, 'utf8'));
      if (data[appId]) {
        delete data[appId];
        fs.writeFileSync(APPS_OAUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`[keycloak]    ✅ Entrée ${appId} supprimée de apps-oauth.json`);
      }
    }
  } catch (err: any) {
    console.warn(`[keycloak]    ⚠️  Erreur suppression de ${appId} dans apps-oauth.json:`, err.message);
  }

  // 4) Supprimer du realm JSON (source + dest)
  for (const realmPath of [REALM_DEST, REALM_SOURCE]) {
    if (!fs.existsSync(realmPath)) continue;
    try {
      const realm = JSON.parse(fs.readFileSync(realmPath, 'utf8'));
      const before = (realm.clients || []).length;
      realm.clients = (realm.clients || []).filter((c: any) => c.clientId !== clientId);
      const after = realm.clients.length;

      // Supprimer les rôles client associés
      if (realm.roles?.client?.[clientId]) {
        delete realm.roles.client[clientId];
      }

      if (before !== after) {
        fs.writeFileSync(realmPath, JSON.stringify(realm, null, 2), 'utf8');
        console.log(`[keycloak]    ✅ Client ${clientId} supprimé de ${realmPath}`);
      }
    } catch (err: any) {
      console.warn(`[keycloak]    ⚠️  Erreur suppression de ${clientId} dans ${realmPath}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Migration : configuration OIDC STANDARD pour LDAP
// ---------------------------------------------------------------------------
// Modèle conventionnel, compatible avec toutes les apps OIDC (Immich, rdrive…) :
//   - uid                = identifiant de connexion (login)         -> usernameLDAPAttribute=uid
//   - preferred_username = uid                                      -> claim depuis la propriété username
//   - name               = nom d'affichage (cn), librement éditable -> claim depuis firstName (= cn)
//   - sub                = identifiant stable interne (entryUUID)   -> géré par Keycloak
// Idempotente : n'écrit que si la config diffère, ne resynchronise que si besoin,
// n'interrompt jamais le démarrage, et nettoie les anciens mappers "découplés".

const KC_BASE = 'http://localhost/auth';
const KC_REALM = 'ryvie';
const LDAP_UID_ATTR = 'ldapUid'; // attribut Keycloak qui porte l'uid LDAP

async function kcAdminToken(): Promise<string> {
  const pass = getAdminPassword();
  const res = await fetch(`${KC_BASE}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: pass,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`token admin HTTP ${res.status}`);
  const j: any = await res.json();
  return j.access_token;
}

async function kcReq(token: string, method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${KC_BASE}/admin/realms/${KC_REALM}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function firstVal(config: any, key: string): string | undefined {
  const v = config?.[key];
  return Array.isArray(v) ? v[0] : v;
}

async function ensureStandardLdapMapping(): Promise<void> {
  try {
    const token = await kcAdminToken();
    let changed = false;

    // 1) Composants de fédération LDAP
    const ldapComponents = await kcReq(token, 'GET', '/components?type=org.keycloak.storage.UserStorageProvider');
    const ldapProviders = (ldapComponents || []).filter((c: any) => c.providerId === 'ldap');
    if (!ldapProviders.length) {
      console.log('[keycloak] ℹ️  Aucun provider LDAP trouvé, mapping standard ignoré');
      return;
    }

    for (const ldap of ldapProviders) {
      // 1a) Login = uid
      if (firstVal(ldap.config, 'usernameLDAPAttribute') !== 'uid') {
        ldap.config.usernameLDAPAttribute = ['uid'];
        await kcReq(token, 'PUT', `/components/${ldap.id}`, ldap);
        changed = true;
        console.log(`[keycloak] 🔧 usernameLDAPAttribute -> uid (${ldap.id})`);
      }

      // 1b) Mappers du provider
      const mappers = await kcReq(token, 'GET', `/components?parent=${ldap.id}&type=org.keycloak.storage.ldap.mappers.LDAPStorageMapper`);

      // username <- uid (identifiant de connexion)
      const usernameMapper = (mappers || []).find(
        (m: any) => m.providerId === 'user-attribute-ldap-mapper' && firstVal(m.config, 'user.model.attribute') === 'username'
      );
      if (usernameMapper && (firstVal(usernameMapper.config, 'ldap.attribute') !== 'uid' || firstVal(usernameMapper.config, 'always.read.value.from.ldap') !== 'true')) {
        usernameMapper.config['ldap.attribute'] = ['uid'];
        usernameMapper.config['always.read.value.from.ldap'] = ['true'];
        await kcReq(token, 'PUT', `/components/${usernameMapper.id}`, usernameMapper);
        changed = true;
        console.log(`[keycloak] 🔧 mapper username -> uid (${usernameMapper.id})`);
      }

      // firstName <- cn (= nom d'affichage), toujours relu pour propager les renommages
      const firstNameMapper = (mappers || []).find(
        (m: any) => m.providerId === 'user-attribute-ldap-mapper' && firstVal(m.config, 'user.model.attribute') === 'firstName'
      );
      if (firstNameMapper && (firstVal(firstNameMapper.config, 'ldap.attribute') !== 'cn' || firstVal(firstNameMapper.config, 'always.read.value.from.ldap') !== 'true')) {
        firstNameMapper.config['ldap.attribute'] = ['cn'];
        firstNameMapper.config['always.read.value.from.ldap'] = ['true'];
        await kcReq(token, 'PUT', `/components/${firstNameMapper.id}`, firstNameMapper);
        changed = true;
        console.log(`[keycloak] 🔧 mapper firstName -> cn always.read (${firstNameMapper.id})`);
      }

      // lastName <- sn, toujours relu
      const lastNameMapper = (mappers || []).find(
        (m: any) => m.providerId === 'user-attribute-ldap-mapper' && firstVal(m.config, 'user.model.attribute') === 'lastName'
      );
      if (lastNameMapper && firstVal(lastNameMapper.config, 'always.read.value.from.ldap') !== 'true') {
        lastNameMapper.config['always.read.value.from.ldap'] = ['true'];
        await kcReq(token, 'PUT', `/components/${lastNameMapper.id}`, lastNameMapper);
        changed = true;
        console.log(`[keycloak] 🔧 mapper lastName -> always.read (${lastNameMapper.id})`);
      }

      // Nettoyage : retirer l'ancien mapper "ldap-uid" (bidouille du découplage)
      const uidMapper = (mappers || []).find(
        (m: any) => m.providerId === 'user-attribute-ldap-mapper' && firstVal(m.config, 'user.model.attribute') === LDAP_UID_ATTR
      );
      if (uidMapper) {
        await kcReq(token, 'DELETE', `/components/${uidMapper.id}`);
        changed = true;
        console.log(`[keycloak] 🧹 mapper ldap-uid supprimé (${uidMapper.id})`);
      }
    }

    // 2) Claims (client scope "profile")
    const scopes = await kcReq(token, 'GET', '/client-scopes');
    const profile = (scopes || []).find((s: any) => s.name === 'profile');
    if (profile) {
      // preferred_username <- username (= uid). Standard : identifiant de connexion.
      const pm = (profile.protocolMappers || []).find(
        (m: any) => firstVal(m.config, 'claim.name') === 'preferred_username'
      );
      if (pm && firstVal(pm.config, 'user.attribute') !== 'username') {
        pm.config['user.attribute'] = 'username';
        await kcReq(token, 'PUT', `/client-scopes/${profile.id}/protocol-mappers/models/${pm.id}`, pm);
        changed = true;
        console.log('[keycloak] 🔧 preferred_username -> username (= uid)');
      }

      // name = nom d'affichage. On supprime le full-name mapper (qui colle
      // firstName+lastName -> doublage) et on émet `name` directement depuis
      // firstName (qui lit cn). Le nom affiché reste donc librement éditable et
      // se propage aux apps au prochain login.
      const fullNameMapper = (profile.protocolMappers || []).find(
        (m: any) => m.protocolMapper === 'oidc-full-name-mapper'
      );
      if (fullNameMapper) {
        await kcReq(token, 'DELETE', `/client-scopes/${profile.id}/protocol-mappers/models/${fullNameMapper.id}`);
        changed = true;
        console.log('[keycloak] 🔧 full-name mapper supprimé (doublage évité)');
      }
      const nameMapper = (profile.protocolMappers || []).find(
        (m: any) => m.protocolMapper === 'oidc-usermodel-property-mapper' && firstVal(m.config, 'claim.name') === 'name'
      );
      if (!nameMapper) {
        await kcReq(token, 'POST', `/client-scopes/${profile.id}/protocol-mappers/models`, {
          name: 'ryvie-name-display',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-property-mapper',
          config: {
            'user.attribute': 'firstName',
            'claim.name': 'name',
            'jsonType.label': 'String',
            'id.token.claim': 'true',
            'access.token.claim': 'true',
            'userinfo.token.claim': 'true',
          },
        });
        changed = true;
        console.log('[keycloak] 🔧 mapper name <- nom d\'affichage (cn) créé');
      } else if (firstVal(nameMapper.config, 'user.attribute') !== 'firstName') {
        nameMapper.config['user.attribute'] = 'firstName';
        await kcReq(token, 'PUT', `/client-scopes/${profile.id}/protocol-mappers/models/${nameMapper.id}`, nameMapper);
        changed = true;
        console.log('[keycloak] 🔧 mapper name -> firstName (cn)');
      }
    } else {
      console.warn('[keycloak] ⚠️  client scope "profile" introuvable');
    }

    // 3) Re-synchroniser depuis LDAP uniquement si on a modifié quelque chose
    if (changed) {
      for (const ldap of ldapProviders) {
        try {
          await kcReq(token, 'POST', `/user-storage/${ldap.id}/sync?action=triggerFullSync`);
          console.log(`[keycloak] 🔄 Re-sync LDAP déclenchée (${ldap.id})`);
        } catch (e: any) {
          console.warn(`[keycloak] ⚠️  Re-sync échouée (${ldap.id}):`, e.message);
        }
      }
      console.log('[keycloak] ✅ Mapping OIDC standard appliqué');
    } else {
      console.log('[keycloak] ✅ Mapping OIDC standard déjà en place');
    }
  } catch (err: any) {
    // Ne jamais interrompre le démarrage du backend pour cette migration.
    console.warn('[keycloak] ⚠️  Mapping OIDC standard non appliqué:', err.message);
  }
}

// Aligne la durée de session SSO Keycloak (idle + max lifespan) sur `minutes`.
// Permet au réglage "Durée de session" du dashboard de piloter aussi la session
// Keycloak (et donc les apps SSO), pas seulement le JWT du dashboard.
async function setRealmSessionTimeout(minutes: number): Promise<boolean> {
  try {
    const secs = Math.max(60, Math.floor(Number(minutes) || 0) * 60);
    const token = await kcAdminToken();
    const realm: any = await kcReq(token, 'GET', '');
    if (!realm || typeof realm !== 'object') throw new Error('realm representation introuvable');
    realm.ssoSessionIdleTimeout = secs;
    realm.ssoSessionMaxLifespan = secs;
    // On ne touche PAS à accessTokenLifespan : il reste court (rafraîchi automatiquement
    // pendant la session). On borne juste s'il dépassait la session.
    if (typeof realm.accessTokenLifespan === 'number' && realm.accessTokenLifespan > secs) {
      realm.accessTokenLifespan = secs;
    }
    await kcReq(token, 'PUT', '', realm);
    console.log(`[keycloak] 🔧 Session SSO alignée: idle+max = ${secs}s (${minutes} min)`);
    return true;
  } catch (err: any) {
    console.warn('[keycloak] ⚠️  setRealmSessionTimeout échoué:', err.message);
    return false;
  }
}

module.exports = { ensureKeycloakRunning, removeAppSSOClient, setRealmSessionTimeout };
