export {};
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

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
const ADD_CLIENT_SCRIPT = path.join('/opt/Ryvie/scripts', 'add-client-oauth.sh');

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
  try {
    execSync(
      `docker compose -f "${DOCKER_COMPOSE_FILE}" --env-file "${KEYCLOAK_ENV_CODE}" up -d`,
      { stdio: 'pipe', timeout: 120000, cwd: KEYCLOAK_CODE_DIR }
    );
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
      const res = await fetch('http://localhost:3005/realms/ryvie/.well-known/openid-configuration', {
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
    `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${adminPass}"`,
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

    // 5. Démarrer si pas déjà en cours
    let wasStarted = false;
    if (!isKeycloakRunning()) {
      startKeycloak();
      wasStarted = true;
    } else {
      console.log('[keycloak] ✅ Keycloak déjà en cours d\'exécution');
    }

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

    // 9. Provisionner les clients SSO des apps (manifests avec sso: true)
    ensureAppSSOClients();

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
 * Provisionne les clients SSO pour toutes les apps dont le manifest a sso: true.
 * - Lit les manifests dans /data/config/manifests/
 * - Pour chaque app avec sso: true, vérifie si le client ryvie-<appId> existe
 * - Si absent, exécute scripts/add-client-oauth.sh pour le créer
 * - Injecte les variables OIDC dans le .env de l'app (à côté du docker-compose)
 */
function ensureAppSSOClients(): void {
  console.log('[keycloak] 🔐 Vérification des clients SSO des apps...');

  if (!fs.existsSync(MANIFESTS_DIR)) {
    console.log('[keycloak] ℹ️  Aucun dossier manifests, pas de clients SSO à provisionner');
    return;
  }

  let entries: any[];
  try {
    entries = fs.readdirSync(MANIFESTS_DIR, { withFileTypes: true }).filter((e: any) => e.isDirectory());
  } catch {
    console.warn('[keycloak] ⚠️  Impossible de lire le dossier manifests');
    return;
  }

  for (const entry of entries) {
    const manifestPath = path.join(MANIFESTS_DIR, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: any;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }

    if (!manifest.sso) continue;

    const appId = manifest.id;
    const appName = manifest.name;
    const port = manifest.mainPort;
    const clientId = `ryvie-${appId}`;

    if (!port) {
      console.log(`[keycloak] ⚠️  SSO activé pour ${appName} mais pas de port, ignoré`);
      continue;
    }

    console.log(`[keycloak] 🔐 SSO ${appName} (client: ${clientId}, port: ${port})`);

    // 1) Vérifier / créer le client Keycloak
    let clientSecret: string | null = null;

    if (keycloakClientExists(clientId)) {
      console.log(`[keycloak]    ✅ Client ${clientId} existe déjà`);
      clientSecret = getClientSecretFromRealm(clientId);
    } else {
      console.log(`[keycloak]    🆕 Création du client ${clientId}...`);
      try {
        const adminPass = getAdminPassword();
        const output = execSync(
          `KEYCLOAK_ADMIN_PASSWORD='${adminPass}' bash "${ADD_CLIENT_SCRIPT}" "${clientId}" "${appName}" "${port}"`,
          { timeout: 30000, encoding: 'utf8', stdio: 'pipe' }
        );
        console.log(output);
        clientSecret = getClientSecretFromRealm(clientId);
      } catch (err: any) {
        console.warn(`[keycloak]    ❌ Erreur création client ${clientId}:`, err.message);
        continue;
      }
    }

    if (!clientSecret) {
      // Fallback: lire depuis le .env existant de l'app
      const envPath = manifest.sourceDir && manifest.dockerComposePath
        ? path.join(path.dirname(path.join(manifest.sourceDir, manifest.dockerComposePath)), '.env')
        : null;
      if (envPath && fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const m = envContent.match(/OAUTH_CLIENT_SECRET=(.+)/);
        if (m) clientSecret = m[1].trim();
      }
    }

    if (!clientSecret) {
      console.warn(`[keycloak]    ⚠️  Secret introuvable pour ${clientId}, injection OIDC ignorée`);
      continue;
    }

    // 2) Injecter les variables OIDC dans le .env de l'app
    if (!manifest.sourceDir || !manifest.dockerComposePath) {
      console.warn(`[keycloak]    ⚠️  Pas de sourceDir/dockerComposePath pour ${appName}, injection ignorée`);
      continue;
    }

    const envFilePath = path.join(
      path.dirname(path.join(manifest.sourceDir, manifest.dockerComposePath)),
      '.env'
    );

    const oidcVars: Record<string, string> = {
      'OAUTH_ENABLED': 'true',
      'OAUTH_ISSUER_URL': 'http://ryvie.local:3005/realms/ryvie',
      'OAUTH_CLIENT_ID': clientId,
      'OAUTH_CLIENT_SECRET': clientSecret,
      'OAUTH_SCOPE': 'openid email profile',
    };

    // Lire le contenu avant modification pour détecter les changements
    let envBefore = '';
    try {
      if (fs.existsSync(envFilePath)) {
        envBefore = fs.readFileSync(envFilePath, 'utf8');
      }
    } catch {}

    try {
      for (const [key, value] of Object.entries(oidcVars)) {
        setEnvVar(envFilePath, key, value);
      }
      console.log(`[keycloak]    ✅ Variables OIDC injectées dans ${envFilePath}`);
    } catch (err: any) {
      console.warn(`[keycloak]    ⚠️  Erreur injection OIDC dans ${envFilePath}:`, err.message);
      continue;
    }

    // Si le .env a changé, redémarrer le docker-compose de l'app
    let envAfter = '';
    try {
      envAfter = fs.readFileSync(envFilePath, 'utf8');
    } catch {}

    if (envBefore !== envAfter) {
      // Détecter le fichier compose réellement utilisé via les labels Docker
      let actualComposeFile: string | null = null;
      let actualComposeDir: string | null = null;
      try {
        const containerName = execSync(
          `docker ps -a --filter "name=app-${appId}" --format "{{.Names}}" | head -1`,
          { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
        ).trim();
        if (containerName) {
          const configFiles = execSync(
            `docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "${containerName}"`,
            { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
          ).trim();
          if (configFiles && configFiles !== '<no value>' && fs.existsSync(configFiles)) {
            actualComposeFile = path.basename(configFiles);
            actualComposeDir = path.dirname(configFiles);
          }
        }
      } catch {}

      // Fallback sur le chemin du manifest
      if (!actualComposeFile || !actualComposeDir) {
        const composePath = path.join(manifest.sourceDir, manifest.dockerComposePath);
        actualComposeFile = path.basename(composePath);
        actualComposeDir = path.dirname(composePath);
      }

      console.log(`[keycloak]    🔄 .env modifié, redémarrage de ${appName} (${actualComposeFile})...`);
      try {
        execSync(`docker compose -f "${actualComposeFile}" down`, { cwd: actualComposeDir, timeout: 120000, stdio: 'pipe' });
        // Lancer up -d en arrière-plan (non bloquant)
        const child = spawn('docker', ['compose', '-f', actualComposeFile, 'up', '-d', '--force-recreate'], {
          cwd: actualComposeDir,
          stdio: 'ignore',
          detached: true,
        });
        child.unref();
        console.log(`[keycloak]    ✅ ${appName} : down terminé, up -d lancé en arrière-plan`);
      } catch (err: any) {
        console.warn(`[keycloak]    ⚠️  Erreur redémarrage ${appName}:`, err.message);
      }
    } else {
      console.log(`[keycloak]    ✅ Variables OIDC déjà à jour pour ${appName}, pas de redémarrage`);
    }
  }
}

/**
 * Provisionne le client SSO pour une seule app (par appId).
 * Lit le manifest de l'app, vérifie si sso: true, crée le client Keycloak si absent,
 * injecte les variables OIDC dans le .env de l'app et redémarre si nécessaire.
 * 
 * Appelé après l'installation/mise à jour d'une app dans updateAppFromStore().
 */
function ensureAppSSOClient(appId: string): void {
  const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log(`[keycloak] ℹ️  Pas de manifest pour ${appId}, SSO ignoré`);
    return;
  }

  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err: any) {
    console.warn(`[keycloak] ⚠️  Impossible de lire le manifest de ${appId}:`, err.message);
    return;
  }

  if (!manifest.sso) {
    console.log(`[keycloak] ℹ️  SSO non activé pour ${appId}, ignoré`);
    return;
  }

  const appName = manifest.name;
  const port = manifest.mainPort;
  const clientId = `ryvie-${appId}`;

  if (!port) {
    console.log(`[keycloak] ⚠️  SSO activé pour ${appName} mais pas de port, ignoré`);
    return;
  }

  // Vérifier que Keycloak est accessible
  try {
    execSync('docker ps --filter "name=keycloak" --filter "status=running" -q', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }).trim();
  } catch {
    console.log(`[keycloak] ℹ️  Keycloak non accessible, SSO pour ${appId} sera provisionné au prochain démarrage`);
    return;
  }

  console.log(`[keycloak] 🔐 SSO ${appName} (client: ${clientId}, port: ${port})`);

  // Authentifier kcadm.sh pour cette opération standalone
  try {
    kcadmAuth();
  } catch (err: any) {
    console.warn(`[keycloak]    ⚠️  Impossible de s'authentifier auprès de Keycloak:`, err.message);
    return;
  }

  // 1) Vérifier / créer le client Keycloak
  let clientSecret: string | null = null;

  if (keycloakClientExists(clientId)) {
    console.log(`[keycloak]    ✅ Client ${clientId} existe déjà`);
    clientSecret = getClientSecretFromRealm(clientId);
  } else {
    console.log(`[keycloak]    🆕 Création du client ${clientId}...`);
    try {
      const adminPass = getAdminPassword();
      const output = execSync(
        `KEYCLOAK_ADMIN_PASSWORD='${adminPass}' bash "${ADD_CLIENT_SCRIPT}" "${clientId}" "${appName}" "${port}"`,
        { timeout: 30000, encoding: 'utf8', stdio: 'pipe' }
      );
      console.log(output);
      clientSecret = getClientSecretFromRealm(clientId);
    } catch (err: any) {
      console.warn(`[keycloak]    ❌ Erreur création client ${clientId}:`, err.message);
      return;
    }
  }

  if (!clientSecret) {
    // Fallback: lire depuis le .env existant de l'app
    const envPath = manifest.sourceDir && manifest.dockerComposePath
      ? path.join(path.dirname(path.join(manifest.sourceDir, manifest.dockerComposePath)), '.env')
      : null;
    if (envPath && fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const m = envContent.match(/OAUTH_CLIENT_SECRET=(.+)/);
      if (m) clientSecret = m[1].trim();
    }
  }

  if (!clientSecret) {
    console.warn(`[keycloak]    ⚠️  Secret introuvable pour ${clientId}, injection OIDC ignorée`);
    return;
  }

  // 2) Injecter les variables OIDC dans le .env de l'app
  if (!manifest.sourceDir || !manifest.dockerComposePath) {
    console.warn(`[keycloak]    ⚠️  Pas de sourceDir/dockerComposePath pour ${appName}, injection ignorée`);
    return;
  }

  const envFilePath = path.join(
    path.dirname(path.join(manifest.sourceDir, manifest.dockerComposePath)),
    '.env'
  );

  const oidcVars: Record<string, string> = {
    'OAUTH_ENABLED': 'true',
    'OAUTH_ISSUER_URL': 'http://ryvie.local:3005/realms/ryvie',
    'OAUTH_CLIENT_ID': clientId,
    'OAUTH_CLIENT_SECRET': clientSecret,
    'OAUTH_SCOPE': 'openid email profile',
  };

  let envBefore = '';
  try {
    if (fs.existsSync(envFilePath)) {
      envBefore = fs.readFileSync(envFilePath, 'utf8');
    }
  } catch {}

  try {
    for (const [key, value] of Object.entries(oidcVars)) {
      setEnvVar(envFilePath, key, value);
    }
    console.log(`[keycloak]    ✅ Variables OIDC injectées dans ${envFilePath}`);
  } catch (err: any) {
    console.warn(`[keycloak]    ⚠️  Erreur injection OIDC dans ${envFilePath}:`, err.message);
    return;
  }

  // Si le .env a changé, redémarrer le docker-compose de l'app
  let envAfter = '';
  try {
    envAfter = fs.readFileSync(envFilePath, 'utf8');
  } catch {}

  if (envBefore !== envAfter) {
    let actualComposeFile: string | null = null;
    let actualComposeDir: string | null = null;
    try {
      const containerName = execSync(
        `docker ps -a --filter "name=app-${appId}" --format "{{.Names}}" | head -1`,
        { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
      ).trim();
      if (containerName) {
        const configFiles = execSync(
          `docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "${containerName}"`,
          { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
        ).trim();
        if (configFiles && configFiles !== '<no value>' && fs.existsSync(configFiles)) {
          actualComposeFile = path.basename(configFiles);
          actualComposeDir = path.dirname(configFiles);
        }
      }
    } catch {}

    if (!actualComposeFile || !actualComposeDir) {
      const composePath = path.join(manifest.sourceDir, manifest.dockerComposePath);
      actualComposeFile = path.basename(composePath);
      actualComposeDir = path.dirname(composePath);
    }

    console.log(`[keycloak]    🔄 .env modifié, redémarrage de ${appName} (${actualComposeFile})...`);
    try {
      execSync(`docker compose -f "${actualComposeFile}" down`, { cwd: actualComposeDir, timeout: 120000, stdio: 'pipe' });
      const child = spawn('docker', ['compose', '-f', actualComposeFile, 'up', '-d', '--force-recreate'], {
        cwd: actualComposeDir,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      console.log(`[keycloak]    ✅ ${appName} : down terminé, up -d lancé en arrière-plan`);
    } catch (err: any) {
      console.warn(`[keycloak]    ⚠️  Erreur redémarrage ${appName}:`, err.message);
    }
  } else {
    console.log(`[keycloak]    ✅ Variables OIDC déjà à jour pour ${appName}, pas de redémarrage`);
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

  // 3) Supprimer du realm JSON (source + dest)
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

module.exports = { ensureKeycloakRunning, ensureAppSSOClient, removeAppSSOClient };
