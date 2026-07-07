export {};
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const { NETBIRD_FILE, MANIFESTS_DIR } = require('../../config/paths');
const { syncNetbirdConfig } = require('../../utils/syncNetbirdConfig');
const reverseProxy = require('../system/reverseProxyService');
const { composeUpWithRecovery } = require('../system/dockerService');

const execPromise = util.promisify(exec);

// Port du service d'enregistrement des domaines publics (sur le nœud cloud NetBird)
const REGISTER_PORT = 8088;
// Timeout long : la création d'un domaine côté cloud (DNS + Caddy + S3) prend ~30-90 s
const REGISTER_TIMEOUT_MS = 120000;

// Apps dont l'exposition publique est gérée nativement par Ryvie (jamais via ce service)
const EXCLUDED_APPS = new Set(['rdrive', 'rpictures', 'rtransfer', 'rdrop']);

// Variables .env « URL publique » reconnues : si l'app en référence une dans son
// docker-compose.yml (ou en a déjà une dans son .env), on la met à jour lors de
// l'exposition/dé-exposition puis on redémarre l'app.
const PUBLIC_URL_VAR_RE = /^(APP_URL|WEBHOOK_URL|PUBLIC_URL|[A-Z0-9_]*_(BASE_URL|EXTERNAL_URL|PUBLIC_URL|PUBLIC_HOST))$/;

// Cache de l'endpoint register découvert (évite de re-sonder les peers à chaque appel)
let cachedRegisterUrl: string | null = null;

function normalizeAppId(appId: string): string {
  return String(appId || '').toLowerCase().replace(/^ryvie-/, '');
}

function isExcluded(appId: string): boolean {
  return EXCLUDED_APPS.has(normalizeAppId(appId));
}

// ───────── netbird-data.json ─────────

async function readNetbirdData(): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(NETBIRD_FILE, 'utf8'));
  } catch (err: any) {
    if (err.code === 'EACCES') {
      // Fichier possédé par root : lecture via sudo (même pattern qu'appsOAuthService)
      try {
        const { execSync } = require('child_process');
        return JSON.parse(execSync(`sudo cat "${NETBIRD_FILE}"`, { encoding: 'utf8' }));
      } catch { return null; }
    }
    return null;
  }
}

/**
 * Écrit netbird-data.json avec fallback sudo si le fichier appartient à root
 * (cas fréquent : il est provisionné par le système, pas par le backend).
 */
async function writeNetbirdFile(content: string): Promise<void> {
  try {
    await fs.writeFile(NETBIRD_FILE, content, 'utf8');
  } catch (writeErr: any) {
    if (writeErr.code !== 'EACCES' && writeErr.code !== 'EPERM') throw writeErr;
    const { execSync } = require('child_process');
    const tmpFile = `/tmp/netbird-data-${process.pid}-${Date.now()}.json`;
    await fs.writeFile(tmpFile, content, 'utf8');
    execSync(`sudo cp "${tmpFile}" "${NETBIRD_FILE}" && rm -f "${tmpFile}"`);
  }
}

/**
 * Fusionne la réponse du service register dans netbird-data.json local.
 * La réponse est l'état complet (domains/blocks/...) mais son champ `received`
 * peut être partiel : on préserve les clés locales absentes de la réponse
 * (machineId, arch, os…).
 */
async function mergeNetbirdData(update: any): Promise<void> {
  const current = (await readNetbirdData()) || {};
  const merged = {
    ...current,
    ...update,
    received: { ...(current.received || {}), ...(update.received || {}) }
  };
  // caddyResults de la réponse ne concerne que l'opération courante : on la
  // garde uniquement pour trace, comme le fait le provisioning initial.
  await writeNetbirdFile(JSON.stringify(merged, null, 2));
  try { syncNetbirdConfig(); } catch (_) {}
}

// ───────── Découverte du service register (nœud cloud NetBird) ─────────

/**
 * Retourne l'URL de base du service register, ex. http://100.104.235.83:8088
 * - Override possible via NETBIRD_REGISTER_URL dans le .env du backend
 * - Sinon : sonde les peers NetBird connectés sur le port 8088
 */
async function getRegisterUrl(): Promise<string> {
  if (process.env.NETBIRD_REGISTER_URL) {
    return process.env.NETBIRD_REGISTER_URL.replace(/\/+$/, '');
  }
  if (cachedRegisterUrl) return cachedRegisterUrl;

  // Lister les peers connectés via la CLI netbird
  let stdout = '';
  try {
    ({ stdout } = await execPromise('netbird status -d', { timeout: 10000 }));
  } catch (err: any) {
    throw new Error(`Impossible de lister les peers NetBird: ${err.message}`);
  }

  // Parse: blocs peers avec "NetBird IP: 100.x.y.z" suivi de "Status: Connected"
  const candidates: string[] = [];
  const blocks = stdout.split(/\n\s*\n/);
  for (const block of blocks) {
    const ipMatch = block.match(/NetBird IP:\s*(\d+\.\d+\.\d+\.\d+)/);
    if (ipMatch && /Status:\s*Connected/.test(block)) {
      candidates.push(ipMatch[1]);
    }
  }
  // Fallback si le format ne sépare pas les blocs par des lignes vides
  if (candidates.length === 0) {
    const all = [...stdout.matchAll(/NetBird IP:\s*(\d+\.\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    candidates.push(...all);
  }

  for (const ip of candidates) {
    const base = `http://${ip}:${REGISTER_PORT}`;
    try {
      // N'importe quelle réponse HTTP (même 404) = service présent sur ce peer
      await axios.get(`${base}/`, { timeout: 2500, validateStatus: () => true });
      cachedRegisterUrl = base;
      console.log(`[publicExposure] ✅ Service register découvert: ${base}`);
      return base;
    } catch (_) { /* peer sans service register : suivant */ }
  }

  throw new Error('Service d\'exposition publique injoignable (aucun peer NetBird ne répond sur le port 8088)');
}

// ───────── Manifest / app helpers ─────────

function getManifest(appId: string): any | null {
  const manifestPath = path.join(MANIFESTS_DIR, appId, 'manifest.json');
  try {
    return JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveAppDir(manifest: any, appId: string): string {
  const sourceDir = manifest?.sourceDir || `/data/apps/${appId}`;
  const composePath = manifest?.dockerComposePath || 'docker-compose.yml';
  return composePath.includes('/') ? path.join(sourceDir, path.dirname(composePath)) : sourceDir;
}

// ───────── Mise à jour du .env de l'app ─────────

/**
 * Liste les variables « URL publique » pertinentes pour une app : celles
 * référencées par son docker-compose.yml (${VAR}) ou déjà présentes dans son .env.
 */
function findPublicUrlVars(appDir: string): string[] {
  const vars = new Set<string>();
  try {
    const compose = fsSync.readFileSync(path.join(appDir, 'docker-compose.yml'), 'utf8');
    for (const m of compose.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)) {
      if (PUBLIC_URL_VAR_RE.test(m[1])) vars.add(m[1]);
    }
  } catch (_) {}
  try {
    const env = fsSync.readFileSync(path.join(appDir, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=/);
      if (m && PUBLIC_URL_VAR_RE.test(m[1])) vars.add(m[1]);
    }
  } catch (_) {}
  return [...vars];
}

function setEnvVar(content: string, name: string, value: string): string {
  const regex = new RegExp(`^${name}=.*$`, 'm');
  if (regex.test(content)) return content.replace(regex, `${name}=${value}`);
  return content.trimEnd() + `\n${name}=${value}\n`;
}

/**
 * Met à jour les variables URL publiques du .env de l'app.
 * - exposé   → https://<domaine> (ou domaine nu si la valeur précédente l'était)
 * - dé-exposé → http://<hôte tunnel>:<port> (même logique de style)
 * Retourne true si le .env a changé.
 */
async function updateAppPublicUrlEnv(appId: string, appDir: string, domain: string | null, port: number): Promise<boolean> {
  const vars = findPublicUrlVars(appDir);
  if (vars.length === 0) return false;

  const envPath = path.join(appDir, '.env');
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (err: any) {
    if (err.code === 'EACCES') {
      const { execSync } = require('child_process');
      content = execSync(`sudo cat "${envPath}"`, { encoding: 'utf8' });
    } else if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  // Hôte local de repli (tunnel NetBird de la box) pour la dé-exposition
  const data = await readNetbirdData();
  const tunnelHost = data?.received?.backendHost || reverseProxy.getPrivateIP?.() || 'ryvie.local';

  let changed = false;
  for (const name of vars) {
    const current = (content.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1] || '';
    // Préserver le style existant : valeur nue (sans schéma) ou URL complète
    const bareStyle = current !== '' && !/^https?:\/\//.test(current);
    const value = domain
      ? (bareStyle ? domain : `https://${domain}`)
      : (bareStyle ? `${tunnelHost}:${port}` : `http://${tunnelHost}:${port}`);
    if (current.trim() === value) continue;
    content = setEnvVar(content, name, value);
    changed = true;
  }

  if (changed) {
    try {
      await fs.writeFile(envPath, content, 'utf8');
    } catch (writeErr: any) {
      if (writeErr.code !== 'EACCES' && writeErr.code !== 'EPERM') throw writeErr;
      const { execSync } = require('child_process');
      const tmpFile = `/tmp/exposure-env-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmpFile, content, 'utf8');
      execSync(`sudo cp "${tmpFile}" "${envPath}" && rm -f "${tmpFile}"`);
    }
    console.log(`[publicExposure] ✅ .env de ${appId} mis à jour (${vars.join(', ')})`);
  }
  return changed;
}

// ───────── Hooks d'exposition déclarés par l'app (ryvie-app.yml) ─────────
// Certaines apps doivent adapter leur config quand elles gagnent/perdent une
// adresse publique — p.ex. autoriser le domaine dans leurs CORS/allowedOrigins et
// déclarer le proxy de confiance (sinon leur UI peut refuser les connexions :
// « origin not allowed »). Plutôt que du code par-app dans le cœur, l'app décrit
// ELLE-MÊME quoi faire via des scripts (bloc `exposure.hooks` de son ryvie-app.yml),
// exécutés côté hôte comme les hooks IA. Le cœur reste agnostique : il ne connaît
// ni le format ni le stockage de config de l'app.

/** Lit le bloc `exposure` du ryvie-app.yml de l'app (source de la recette). */
function readExposureRecipe(manifest: any, appId: string): any | null {
  const sourceDir = manifest?.sourceDir || path.join('/data/apps', appId);
  try {
    const yaml = require('yaml');
    const cfg = yaml.parse(fsSync.readFileSync(path.join(sourceDir, 'ryvie-app.yml'), 'utf8'));
    return (cfg && cfg.exposure) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Exécute un hook d'exposition fourni par l'app (script côté hôte). Le script est
 * responsable d'appliquer ET de redémarrer l'app si besoin (comme ai/connect.sh).
 * Ne lève jamais : l'exposition doit aboutir même si le hook échoue.
 * Variables passées : RYVIE_APP_ID, RYVIE_APP_DIR, RYVIE_EXPOSURE_MODE,
 * RYVIE_PUBLIC_DOMAIN, RYVIE_PUBLIC_URL (les deux dernières vides en dé-exposition).
 */
function runExposureHook(hookRel: string, appDir: string, vars: Record<string, string>): Promise<void> {
  const scriptPath = path.join(appDir, hookRel);
  if (!fsSync.existsSync(scriptPath)) {
    console.warn(`[publicExposure] hook d'exposition introuvable: ${scriptPath}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    exec(`sh "${scriptPath}"`, { cwd: appDir, timeout: 120000, env: { ...process.env, ...vars } }, (err: any, stdout: string, stderr: string) => {
      if (err) console.error(`[publicExposure] ❌ hook ${hookRel}:`, String(stderr || err.message || '').trim().slice(0, 300));
      else if (stdout) console.log(`[publicExposure] hook ${hookRel}: ${String(stdout).trim().slice(0, 300)}`);
      resolve();
    });
  });
}

/**
 * Applique le hook d'exposition (`expose`) ou de dé-exposition (`unexpose`) déclaré
 * par l'app, si présent. Retourne true si un hook a été lancé.
 */
async function applyExposureHook(manifest: any, appId: string, appDir: string, domain: string | null): Promise<boolean> {
  const recipe = readExposureRecipe(manifest, appId);
  const hooks = recipe && recipe.hooks;
  const mode = domain ? 'expose' : 'unexpose';
  const hookRel = hooks && hooks[mode];
  if (!hookRel) return false;
  await runExposureHook(hookRel, appDir, {
    RYVIE_APP_ID: appId,
    RYVIE_APP_DIR: appDir,
    RYVIE_EXPOSURE_MODE: mode,
    RYVIE_PUBLIC_DOMAIN: domain || '',
    RYVIE_PUBLIC_URL: domain ? `https://${domain}` : ''
  });
  return true;
}

/**
 * Redémarre l'app en arrière-plan pour prendre en compte le nouveau .env
 */
function restartAppInBackground(appId: string, appDir: string): void {
  console.log(`[publicExposure] 🔄 Redémarrage de ${appId} en arrière-plan (.env modifié)...`);
  setImmediate(() => {
    try {
      composeUpWithRecovery('docker compose up -d --force-recreate', { cwd: appDir, label: appId });
      console.log(`[publicExposure] ✅ ${appId} redémarré`);
    } catch (err: any) {
      console.error(`[publicExposure] ❌ Erreur redémarrage ${appId}:`, err.message);
    }
  });
}

/**
 * Régénère le Caddyfile local + reload gracieux : le bloc local d'une app passe
 * de HTTPS (tls internal) à HTTP quand elle gagne un domaine public (le TLS est
 * alors terminé par l'ingress cloud), et inversement.
 */
async function refreshLocalProxy(): Promise<void> {
  try {
    await reverseProxy.updateCaddyfileIP();
    await reverseProxy.reloadCaddy();
  } catch (err: any) {
    console.warn('[publicExposure] ⚠️ Rechargement Caddy:', err.message);
  }
}

/**
 * Sonde UNE fois le domaine public. Prêt = vraie réponse HTTP de l'app :
 *  - pas d'erreur réseau (DNS/TLS pas prêts),
 *  - pas de « Route not configured » (route ingress pas encore active),
 *  - pas de 5xx (l'app redémarre / l'ingress ne joint pas encore la box).
 */
async function probeDomain(domain: string): Promise<boolean> {
  try {
    const res = await axios.get(`https://${domain}/`, {
      timeout: 5000,
      validateStatus: () => true
    });
    const body = typeof res.data === 'string' ? res.data : '';
    return res.status < 500 && !/route not configured/i.test(body);
  } catch (_) {
    return false;
  }
}

/**
 * Sonde UNE fois l'app en local. Le backend tourne sur l'hôte et chaque app
 * publie son `mainPort` sur l'hôte (Caddy local proxifie host.docker.internal:port).
 * Sert à savoir si l'app est de nouveau joignable après le redémarrage déclenché
 * par une suppression d'adresse publique (retour aux URLs locales).
 */
async function probeLocal(port: number): Promise<boolean> {
  try {
    const res = await axios.get(`http://127.0.0.1:${port}/`, {
      timeout: 5000,
      validateStatus: () => true
    });
    const body = typeof res.data === 'string' ? res.data : '';
    return res.status < 500 && !/route not configured/i.test(body);
  } catch (_) {
    return false;
  }
}

/**
 * Attend qu'une cible réponde RÉELLEMENT et de façon STABLE.
 *
 * Le `--force-recreate` du redémarrage coupe l'ancien conteneur puis en démarre
 * un neuf : sans précaution, une sonde lancée trop tôt validerait la réponse de
 * l'ANCIEN conteneur (avant sa coupure) et le spinner UI s'arrêterait juste avant
 * que l'app ne devienne injoignable (« connection refused » / « route not
 * configured » au clic). Pour éviter ça :
 *  - `initialDelayMs` : on laisse le recreate couper l'ancien conteneur avant de sonder,
 *  - `settleProbes`   : on exige N réponses OK consécutives (un flux down-then-up
 *                       casse la série → on ne valide qu'une app réellement stable).
 */
async function waitUntilReady(
  probe: () => Promise<boolean>,
  label: string,
  { initialDelayMs = 6000, settleProbes = 2, intervalMs = 3000, maxWaitMs = 90000 } = {}
): Promise<boolean> {
  if (initialDelayMs) await new Promise((r) => setTimeout(r, initialDelayMs));
  const deadline = Date.now() + maxWaitMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (await probe()) {
      if (++consecutive >= settleProbes) {
        console.log(`[publicExposure] ✅ ${label} répond (stable)`);
        return true;
      }
    } else {
      consecutive = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn(`[publicExposure] ⚠️ ${label} ne répond pas de façon stable après ${maxWaitMs / 1000}s`);
  return false;
}

/**
 * Attend que le domaine public réponde réellement. La création côté cloud est
 * asynchrone (DNS + route ingress) ET l'app redémarre pour pointer ses URLs sur
 * le nouveau domaine : on sonde jusqu'à une vraie réponse stable, pour que le
 * spinner côté UI dure jusqu'à ce que l'adresse fonctionne vraiment.
 */
async function waitForDomainReady(domain: string, maxWaitMs = 90000): Promise<boolean> {
  return waitUntilReady(() => probeDomain(domain), domain, { maxWaitMs });
}

/**
 * Attend que l'app réponde de nouveau en local après le redémarrage déclenché
 * par la suppression de son adresse publique (retour aux URLs locales).
 */
async function waitForLocalReady(port: number, maxWaitMs = 90000): Promise<boolean> {
  return waitUntilReady(() => probeLocal(port), `127.0.0.1:${port}`, { maxWaitMs });
}

/**
 * Statut d'accessibilité instantané de l'adresse publique d'une app.
 * Utilisé par le frontend pour faire durer le spinner de l'icône jusqu'à ce
 * que l'app soit RÉELLEMENT accessible à l'adresse générée.
 */
async function isExposureReady(appId: string): Promise<any> {
  const id = normalizeAppId(appId);
  const data = await readNetbirdData();
  const domain = data?.domains?.[id];
  if (domain) {
    const ready = await probeDomain(domain);
    return { exposed: true, domain, ready };
  }
  // Pas (ou plus) d'adresse publique : « prêt » = l'app répond de nouveau en
  // local. Utile pour faire durer le spinner pendant le redémarrage qui suit une
  // suppression d'adresse publique (retour aux URLs locales).
  const manifest = getManifest(appId) || getManifest(id);
  const port = manifest?.mainPort;
  if (!port) return { exposed: false, ready: true };
  const ready = await probeLocal(port);
  return { exposed: false, ready };
}

// ───────── API publique ─────────

/**
 * Statut d'exposition d'une app : { supported, reason?, exposed, domain?, port? }
 */
async function getExposure(appId: string): Promise<any> {
  const id = normalizeAppId(appId);

  if (isExcluded(appId)) {
    return { supported: false, reason: 'managed_natively', exposed: false };
  }

  const manifest = getManifest(appId) || getManifest(id);
  const port = manifest?.mainPort;
  if (!manifest || !port) {
    return { supported: false, reason: 'no_port', exposed: false };
  }

  const data = await readNetbirdData();
  const domain = data?.domains?.[id] || null;

  return { supported: true, exposed: !!domain, domain, port };
}

/**
 * Crée l'adresse publique d'une app (enregistrement cloud + Caddy + .env + restart)
 */
async function exposeApp(appId: string): Promise<any> {
  const id = normalizeAppId(appId);

  if (isExcluded(appId)) {
    throw Object.assign(new Error('L\'exposition publique de cette app est gérée nativement par Ryvie'), { status: 400 });
  }
  const manifest = getManifest(appId) || getManifest(id);
  const port = manifest?.mainPort;
  if (!manifest || !port) {
    throw Object.assign(new Error('Aucun port exposable trouvé pour cette app'), { status: 400 });
  }

  const baseUrl = await getRegisterUrl();
  console.log(`[publicExposure] 🌐 Enregistrement de ${id}:${port} via ${baseUrl}...`);

  let response: any;
  try {
    response = await axios.post(
      `${baseUrl}/api/register`,
      { services: [{ name: id, port }] },
      { timeout: REGISTER_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    cachedRegisterUrl = null; // forcer une redécouverte au prochain appel
    throw Object.assign(new Error(`Échec de la création de l'adresse publique: ${err.message}`), { status: 502 });
  }

  const state = response.data || {};
  const domain = state.domains?.[id];
  if (!domain) {
    throw Object.assign(new Error('Le service d\'exposition n\'a pas retourné de domaine'), { status: 502 });
  }

  // Persister l'état (source de vérité locale) + sync frontend-view
  await mergeNetbirdData(state);

  // Caddy local : bloc HTTPS → HTTP pour cette app (TLS terminé côté cloud)
  await refreshLocalProxy();

  // .env de l'app : pointer les URLs publiques sur le nouveau domaine, puis restart
  const appDir = resolveAppDir(manifest, id);
  let envChanged = false;
  try {
    envChanged = await updateAppPublicUrlEnv(id, appDir, domain, port);
  } catch (err: any) {
    console.warn(`[publicExposure] ⚠️ Mise à jour .env de ${id}:`, err.message);
  }
  if (envChanged) restartAppInBackground(id, appDir);
  // Hook d'exposition déclaré par l'app (best-effort) : lui laisse adapter sa
  // config au nouveau domaine (CORS/allowedOrigins, proxy de confiance…) et se
  // redémarrer si besoin. Le cœur n'a aucune logique par-app.
  let hookRan = false;
  try {
    hookRan = await applyExposureHook(manifest, id, appDir, domain);
  } catch (err: any) {
    console.warn(`[publicExposure] ⚠️ Hook d'exposition de ${id}:`, err.message);
  }

  // Attendre que l'adresse réponde vraiment (sinon l'utilisateur tombe sur
  // « Route not configured » en cliquant tout de suite). Best effort : au-delà
  // du délai, on rend la main quand même (la route s'active en arrière-plan).
  const ready = await waitForDomainReady(domain);

  console.log(`[publicExposure] ✅ ${id} exposé publiquement: ${domain}${ready ? '' : ' (activation en cours)'}`);
  return { success: true, domain, envChanged, restarted: envChanged || hookRan, ready };
}

/**
 * Cœur de la suppression : DELETE côté cloud + retrait du fichier local + reload Caddy.
 * (Sans mise à jour du .env ni redémarrage de l'app — gérés par l'appelant.)
 */
async function removeExposure(id: string): Promise<void> {
  const baseUrl = await getRegisterUrl();
  console.log(`[publicExposure] 🗑️ Suppression de l'adresse publique de ${id} via ${baseUrl}...`);

  try {
    await axios.delete(`${baseUrl}/api/service/${encodeURIComponent(id)}`, { timeout: REGISTER_TIMEOUT_MS });
  } catch (err: any) {
    cachedRegisterUrl = null;
    throw Object.assign(new Error(`Échec de la suppression de l'adresse publique: ${err.message}`), { status: 502 });
  }

  // La réponse DELETE ne contient pas l'état complet → retirer l'app du fichier local
  const data = (await readNetbirdData()) || {};
  if (data.domains) delete data.domains[id];
  if (Array.isArray(data.blocks)) data.blocks = data.blocks.filter((b: any) => b.service !== id);
  if (Array.isArray(data.caddyResults)) data.caddyResults = data.caddyResults.filter((c: any) => !String(c.domain || '').startsWith(`${id}-`));
  await writeNetbirdFile(JSON.stringify(data, null, 2));
  try { syncNetbirdConfig(); } catch (_) {}

  // Caddy local : l'app retrouve son bloc HTTPS local si elle l'exige
  await refreshLocalProxy();
}

/**
 * Supprime l'adresse publique d'une app
 */
async function unexposeApp(appId: string): Promise<any> {
  const id = normalizeAppId(appId);

  if (isExcluded(appId)) {
    throw Object.assign(new Error('L\'exposition publique de cette app est gérée nativement par Ryvie'), { status: 400 });
  }

  const existing = await readNetbirdData();
  if (!existing?.domains?.[id]) {
    throw Object.assign(new Error('Cette app n\'a pas d\'adresse publique'), { status: 400 });
  }

  await removeExposure(id);

  // .env de l'app : revenir aux URLs locales (tunnel), puis restart
  const manifest = getManifest(appId) || getManifest(id);
  const port = manifest?.mainPort || 0;
  let envChanged = false;
  let hookRan = false;
  let ready = true;
  if (manifest && port) {
    const appDir = resolveAppDir(manifest, id);
    try {
      envChanged = await updateAppPublicUrlEnv(id, appDir, null, port);
    } catch (err: any) {
      console.warn(`[publicExposure] ⚠️ Mise à jour .env de ${id}:`, err.message);
    }
    if (envChanged) restartAppInBackground(id, appDir);
    // Hook de dé-exposition déclaré par l'app (best-effort) : retire le domaine
    // public de sa config (allowedOrigins, proxy de confiance…) et se redémarre.
    try {
      hookRan = await applyExposureHook(manifest, id, appDir, null);
    } catch (err: any) {
      console.warn(`[publicExposure] ⚠️ Hook de dé-exposition de ${id}:`, err.message);
    }
    if (envChanged || hookRan) {
      // Attendre que l'app réponde de nouveau en local (elle redémarre pour
      // revenir aux URLs locales). On ne rend la main — donc le spinner UI ne
      // s'arrête — que lorsqu'elle est réellement de nouveau joignable, pour ne
      // pas tomber sur « connection refused » en cliquant juste après.
      ready = await waitForLocalReady(port);
    }
  }

  console.log(`[publicExposure] ✅ Adresse publique de ${id} supprimée${ready ? '' : ' (redémarrage en cours)'}`);
  return { success: true, envChanged, restarted: envChanged || hookRan, ready };
}

/**
 * Nettoyage à la désinstallation : supprime l'adresse publique si l'app en a une.
 * Best effort — ne lève JAMAIS d'erreur (la désinstallation doit continuer même
 * si le service cloud est injoignable) et ne touche ni au .env ni aux conteneurs
 * de l'app (ils sont en cours de suppression).
 */
async function cleanupExposure(appId: string): Promise<{ removed: boolean }> {
  try {
    const id = normalizeAppId(appId);
    if (isExcluded(appId)) return { removed: false };

    const data = await readNetbirdData();
    if (!data?.domains?.[id]) return { removed: false };

    await removeExposure(id);
    console.log(`[publicExposure] ✅ Adresse publique de ${id} supprimée (désinstallation)`);
    return { removed: true };
  } catch (err: any) {
    console.warn(`[publicExposure] ⚠️ Nettoyage de l'adresse publique de ${appId} échoué (désinstallation poursuivie):`, err.message);
    return { removed: false };
  }
}

module.exports = {
  getExposure,
  exposeApp,
  unexposeApp,
  cleanupExposure,
  isExposureReady,
  isExcluded
};
