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
function ensureEnvFile(): void {
  if (envHasRequiredKeys(KEYCLOAK_ENV_DATA)) {
    fs.copyFileSync(KEYCLOAK_ENV_DATA, KEYCLOAK_ENV_CODE);
    console.log(`[keycloak] ✅ .env copié depuis ${KEYCLOAK_ENV_DATA}`);
  } else if (envHasRequiredKeys(KEYCLOAK_ENV_CODE)) {
    fs.copyFileSync(KEYCLOAK_ENV_CODE, KEYCLOAK_ENV_DATA);
    console.log(`[keycloak] ✅ .env copié depuis ${KEYCLOAK_ENV_CODE}`);
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
 * Attend que Keycloak soit prêt à recevoir des requêtes (health check)
 */
async function waitForKeycloakReady(maxWaitMs = 120000, intervalMs = 5000): Promise<boolean> {
  const start = Date.now();
  const adminPass = getAdminPassword();
  console.log('[keycloak] ⏳ Attente que Keycloak soit prêt...');
  while (Date.now() - start < maxWaitMs) {
    try {
      execSync(
        `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${adminPass}"`,
        { stdio: 'pipe', timeout: 10000 }
      );
      console.log('[keycloak] ✅ Keycloak est prêt');
      return true;
    } catch {
      // pas encore prêt
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  console.error('[keycloak] ❌ Timeout en attendant Keycloak');
  return false;
}

/**
 * Vérifie si le client ryvie-dashboard existe dans Keycloak via kcadm.sh
 */
function dashboardClientExists(): boolean {
  try {
    const adminPass = getAdminPassword();
    execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${adminPass}"`,
      { stdio: 'pipe', timeout: 15000 }
    );
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
  const adminPass = getAdminPassword();

  // Authentification admin
  execSync(
    `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${adminPass}"`,
    { stdio: 'pipe', timeout: 15000 }
  );

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
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
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
    const adminPass = getAdminPassword();
    execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${adminPass}"`,
      { stdio: 'pipe', timeout: 15000 }
    );
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

    // 7. S'assurer que le client ryvie-dashboard existe et .env backend à jour
    await ensureDashboardClient();

    // 8. S'assurer que le thème ryvie est appliqué au realm
    ensureRealmTheme();

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
    const adminPass = getAdminPassword();
    execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${adminPass}"`,
      { stdio: 'pipe', timeout: 15000 }
    );
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

module.exports = { ensureKeycloakRunning };
