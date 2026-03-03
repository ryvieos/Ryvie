export {};
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APPS_OAUTH_FILE = '/data/config/keycloak/apps-oauth.json';
const MANIFESTS_DIR = '/data/config/manifests';
const KEYCLOAK_ENV = '/data/config/keycloak/.env';

// Variables .env OAuth standardisées (communes à toutes les apps Ryvie)
const OAUTH_ENV_VARS = {
  clientId: 'OAUTH_CLIENT_ID',
  clientSecret: 'OAUTH_CLIENT_SECRET',
  issuerUrl: 'OAUTH_ISSUER_URL'
};

interface AppOAuthEntry {
  clientId: string;
  clientSecret: string;
  keycloakSynced: boolean;
}

interface AppsOAuthData {
  [appId: string]: AppOAuthEntry;
}

// ───────── Helpers ─────────

function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function getAdminPassword(): string {
  return execSync(`grep KEYCLOAK_ADMIN_PASSWORD ${KEYCLOAK_ENV} | cut -d= -f2`, { encoding: 'utf8' }).trim();
}

function kcadmLogin(): void {
  const pw = getAdminPassword();
  execSync(
    `docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user admin --password "${pw}"`,
    { stdio: 'pipe' }
  );
}

// ───────── Fichier apps-oauth.json ─────────

async function loadAppsOAuth(): Promise<AppsOAuthData> {
  try {
    if (!fsSync.existsSync(APPS_OAUTH_FILE)) return {};
    return JSON.parse(await fs.readFile(APPS_OAUTH_FILE, 'utf8'));
  } catch { return {}; }
}

async function saveAppsOAuth(data: AppsOAuthData): Promise<void> {
  const dir = path.dirname(APPS_OAUTH_FILE);
  if (!fsSync.existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(APPS_OAUTH_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ───────── Manifest helpers ─────────

/**
 * Lit le manifest d'une app et retourne { sso, sourceDir, dockerComposePath } si sso === true
 */
function getSsoManifest(appId: string): { sourceDir: string; dockerComposePath: string } | null {
  const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
  if (!fsSync.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
    if (manifest.sso !== true) return null;
    return { sourceDir: manifest.sourceDir, dockerComposePath: manifest.dockerComposePath || '' };
  } catch { return null; }
}

/**
 * Déduit le chemin du .env de l'app depuis le manifest
 * Le .env est dans le même dossier que le docker-compose.yml
 */
function resolveAppEnvPath(sourceDir: string, dockerComposePath: string): string {
  if (dockerComposePath.includes('/')) {
    return path.join(sourceDir, path.dirname(dockerComposePath), '.env');
  }
  return path.join(sourceDir, '.env');
}

/**
 * Liste toutes les apps SSO installées en lisant les manifests
 */
function listSsoApps(): Array<{ appId: string; sourceDir: string; envPath: string }> {
  const result: Array<{ appId: string; sourceDir: string; envPath: string }> = [];
  if (!fsSync.existsSync(MANIFESTS_DIR)) return result;

  for (const entry of fsSync.readdirSync(MANIFESTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sso = getSsoManifest(entry.name);
    if (!sso) continue;
    result.push({
      appId: entry.name,
      sourceDir: sso.sourceDir,
      envPath: resolveAppEnvPath(sso.sourceDir, sso.dockerComposePath)
    });
  }
  return result;
}

// ───────── Keycloak ─────────

/**
 * Récupère le secret actuel du client dans Keycloak (null si le client n'existe pas)
 */
function getKeycloakClientSecret(clientId: string): string | null {
  try {
    kcadmLogin();
    const result = execSync(
      `docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie -q clientId=${clientId} --fields secret`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const match = result.match(/"secret"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch { return null; }
}

/**
 * Crée un client OAuth dans Keycloak (ne fait rien si le client existe déjà avec le bon secret)
 */
async function ensureKeycloakClient(clientId: string, clientSecret: string): Promise<boolean> {
  try {
    // Vérifier si le client existe déjà avec le bon secret → skip
    const currentSecret = getKeycloakClientSecret(clientId);

    if (currentSecret === clientSecret) {
      console.log(`[appsOAuth] ✅ Client ${clientId} déjà à jour dans Keycloak (skip)`);
      return true;
    }

    kcadmLogin();

    if (currentSecret !== null) {
      // Le client existe mais avec un mauvais secret → update
      const clientData = execSync(
        `docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie -q clientId=${clientId}`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      const idMatch = clientData.match(/"id"\s*:\s*"([^"]+)"/);
      if (!idMatch) throw new Error(`ID introuvable pour ${clientId}`);

      console.log(`[appsOAuth] 🔄 Mise à jour du secret de ${clientId} dans Keycloak...`);
      execSync(
        `docker exec keycloak /opt/keycloak/bin/kcadm.sh update clients/${idMatch[1]} -r ryvie -s secret="${clientSecret}"`,
        { stdio: 'pipe' }
      );
    } else {
      // Le client n'existe pas → créer
      console.log(`[appsOAuth] 🆕 Création du client ${clientId} dans Keycloak...`);
      const configFile = `/tmp/kc-client-${clientId}.json`;
      await fs.writeFile(configFile, JSON.stringify({
        clientId,
        secret: clientSecret,
        enabled: true,
        publicClient: false,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: true,
        redirectUris: ['*'],
        webOrigins: ['*']
      }));
      execSync(`docker exec keycloak /opt/keycloak/bin/kcadm.sh create clients -r ryvie -f - < ${configFile}`, { stdio: 'pipe' });
      await fs.unlink(configFile);
    }

    console.log(`[appsOAuth] ✅ Client ${clientId} synchronisé dans Keycloak`);
    return true;
  } catch (error: any) {
    console.error(`[appsOAuth] ❌ Erreur Keycloak pour ${clientId}:`, error.message);
    return false;
  }
}

// ───────── .env helpers ─────────

/**
 * Met à jour (ou ajoute) une variable dans un fichier .env
 */
function setEnvVar(content: string, varName: string, value: string): string {
  const regex = new RegExp(`^${varName}=.*$`, 'm');
  if (regex.test(content)) {
    return content.replace(regex, `${varName}=${value}`);
  }
  return content.trimEnd() + `\n${varName}=${value}\n`;
}

/**
 * Vérifie si le .env de l'app a déjà les bonnes valeurs OAuth
 */
function envAlreadySynced(envPath: string, clientId: string, clientSecret: string): boolean {
  try {
    if (!fsSync.existsSync(envPath)) return false;
    let content: string;
    try {
      content = fsSync.readFileSync(envPath, 'utf8');
    } catch (e: any) {
      if (e.code === 'EACCES') {
        content = execSync(`sudo cat "${envPath}"`, { encoding: 'utf8' });
      } else { return false; }
    }
    const hasClientId = new RegExp(`^${OAUTH_ENV_VARS.clientId}=${clientId}$`, 'm').test(content);
    const hasSecret = new RegExp(`^${OAUTH_ENV_VARS.clientSecret}=${clientSecret}$`, 'm').test(content);
    return hasClientId && hasSecret;
  } catch { return false; }
}

/**
 * Écrit les variables OAuth dans le .env d'une app
 */
async function syncAppEnv(envPath: string, clientId: string, clientSecret: string): Promise<boolean> {
  try {
    if (!fsSync.existsSync(envPath)) {
      console.warn(`[appsOAuth] ⚠️ .env non trouvé: ${envPath}`);
      return false;
    }
    // Lire le contenu (sudo fallback si permission denied)
    let content: string;
    try {
      content = await fs.readFile(envPath, 'utf8');
    } catch (readErr: any) {
      if (readErr.code === 'EACCES') {
        content = execSync(`sudo cat "${envPath}"`, { encoding: 'utf8' });
      } else { throw readErr; }
    }

    content = setEnvVar(content, OAUTH_ENV_VARS.clientId, clientId);
    content = setEnvVar(content, OAUTH_ENV_VARS.clientSecret, clientSecret);

    // Écrire (sudo fallback si permission denied)
    try {
      await fs.writeFile(envPath, content, 'utf8');
    } catch (writeErr: any) {
      if (writeErr.code === 'EACCES') {
        const tmpFile = `/tmp/oauth-env-${Date.now()}`;
        await fs.writeFile(tmpFile, content, 'utf8');
        execSync(`sudo cp "${tmpFile}" "${envPath}" && rm -f "${tmpFile}"`);
      } else { throw writeErr; }
    }

    console.log(`[appsOAuth] ✅ .env synchronisé: ${envPath}`);
    return true;
  } catch (error: any) {
    console.error(`[appsOAuth] ❌ Erreur .env ${envPath}:`, error.message);
    return false;
  }
}

// ───────── API publique ─────────

/**
 * Provisionne OAuth pour une app (appelé après install/update)
 * - Lit le manifest pour vérifier sso:true
 * - Génère ou récupère le secret depuis apps-oauth.json
 * - Ne touche Keycloak que si nécessaire
 * - Ne touche le .env que si les valeurs ont changé
 * @returns { success, envChanged } ou false en cas d'erreur
 */
async function provisionAppOAuth(appId: string): Promise<{ success: boolean; envChanged: boolean }> {
  try {
    const sso = getSsoManifest(appId);
    if (!sso) {
      return { success: true, envChanged: false };
    }

    const envPath = resolveAppEnvPath(sso.sourceDir, sso.dockerComposePath);
    const clientId = `ryvie-${appId}`;
    const data = await loadAppsOAuth();

    // Récupérer ou générer le secret
    let entry = data[appId];
    let needSave = false;

    if (!entry) {
      entry = { clientId, clientSecret: generateSecret(), keycloakSynced: false };
      data[appId] = entry;
      needSave = true;
      console.log(`[appsOAuth] 🔑 Nouveau secret généré pour ${appId}`);
    }

    // Synchro Keycloak si nécessaire
    if (!entry.keycloakSynced) {
      const ok = await ensureKeycloakClient(entry.clientId, entry.clientSecret);
      if (ok) {
        entry.keycloakSynced = true;
        needSave = true;
      }
    }

    if (needSave) await saveAppsOAuth(data);

    // Synchro .env si nécessaire
    let envChanged = false;
    if (!envAlreadySynced(envPath, entry.clientId, entry.clientSecret)) {
      await syncAppEnv(envPath, entry.clientId, entry.clientSecret);
      envChanged = true;
    } else {
      console.log(`[appsOAuth] ✅ .env de ${appId} déjà à jour (skip)`);
    }

    return { success: true, envChanged };
  } catch (error: any) {
    console.error(`[appsOAuth] ❌ Erreur provisionnement OAuth ${appId}:`, error.message);
    return { success: false, envChanged: false };
  }
}

/**
 * Redémarre une app (docker compose down/up) dans le bon dossier de travail
 */
async function restartApp(appId: string): Promise<void> {
  const sso = getSsoManifest(appId);
  if (!sso) return;

  const composePath = sso.dockerComposePath || 'docker-compose.yml';
  const workingDir = composePath.includes('/')
    ? path.join(sso.sourceDir, path.dirname(composePath))
    : sso.sourceDir;
  const composeFileName = path.basename(composePath);

  try {
    console.log(`[appsOAuth] 🔄 Redémarrage de ${appId} (secret OAuth modifié)...`);
    execSync(`docker compose -f ${composeFileName} down`, { cwd: workingDir, stdio: 'pipe' });
    execSync(`docker compose -f ${composeFileName} up -d`, { cwd: workingDir, stdio: 'pipe' });
    console.log(`[appsOAuth] ✅ ${appId} redémarré`);
  } catch (error: any) {
    console.error(`[appsOAuth] ❌ Erreur redémarrage ${appId}:`, error.message);
  }
}

/**
 * Vérifie si les conteneurs d'une app sont en cours d'exécution
 */
function isAppRunning(appId: string): boolean {
  try {
    const output = execSync(`docker ps --filter "name=app-${appId}" --format "{{.Names}}"`, {
      encoding: 'utf8', stdio: 'pipe'
    }).trim();
    return output.length > 0;
  } catch { return false; }
}

/**
 * Synchronise OAuth pour toutes les apps SSO installées
 * Appelé au démarrage du backend
 * Redémarre automatiquement les apps dont le .env a changé
 */
async function syncAllAppsOAuth(): Promise<void> {
  const ssoApps = listSsoApps();
  if (ssoApps.length === 0) {
    console.log('[appsOAuth] ℹ️ Aucune app SSO détectée');
    return;
  }

  console.log(`[appsOAuth] 🔐 ${ssoApps.length} app(s) SSO détectée(s): ${ssoApps.map(a => a.appId).join(', ')}`);

  for (const app of ssoApps) {
    const result = await provisionAppOAuth(app.appId);

    // Si le .env a changé et que les conteneurs tournent → redémarrer
    if (result.envChanged && isAppRunning(app.appId)) {
      await restartApp(app.appId);
    }
  }
}

module.exports = {
  provisionAppOAuth,
  syncAllAppsOAuth,
  loadAppsOAuth,
  listSsoApps
};
