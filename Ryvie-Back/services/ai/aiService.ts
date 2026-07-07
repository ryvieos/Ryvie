// Point central IA de Ryvie. Pilote LiteLLM (cf. litellmService) et injecte la
// configuration IA dans les apps du catalogue qui la déclarent (bloc `ai:` du
// ryvie-app.yml). L'utilisateur configure UN fournisseur + UNE clé dans Ryvie ;
// les apps reçoivent une base OpenAI-compatible (LiteLLM) + une master key
// interne (la vraie clé fournisseur n'est jamais exposée aux apps).
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const litellm = require('./litellmService');
const appManager = require('./appManagerService');
const { getLocalIP } = require('../utils/network');
const { readEnvFile, writeEnvFile, getEnvVar, setEnvVar, unsetEnvVar } = require('./appEnvService');
const { AI_DIR, AI_CONFIG_FILE, AI_KEY_FILE, MANIFESTS_DIR, APPS_DIR, LITELLM_CONFIG_YAML } = require('../config/paths');

// ───────── Catalogue des fournisseurs ─────────
// prefix : préfixe de routage LiteLLM (openai/, anthropic/, …)
// needsKey : une clé d'API fournisseur est requise
// needsBaseUrl : l'utilisateur doit fournir une URL de base (custom / ollama)
// `models` = suggestions affichées (datalist) ; le champ reste LIBRE côté UI, donc
// n'importe quel identifiant de modèle du fournisseur est accepté (même un nouveau).
const PROVIDERS: Record<string, any> = {
  openai:    { label: 'OpenAI',                   prefix: 'openai',    needsKey: true,  needsBaseUrl: false, models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3-mini'] },
  anthropic: { label: 'Anthropic (Claude)',       prefix: 'anthropic', needsKey: true,  needsBaseUrl: false, models: ['claude-sonnet-4-latest', 'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] },
  mistral:   { label: 'Mistral',                  prefix: 'mistral',   needsKey: true,  needsBaseUrl: false, models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'] },
  gemini:    { label: 'Google Gemini',            prefix: 'gemini',    needsKey: true,  needsBaseUrl: false, models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
  groq:      { label: 'Groq',                      prefix: 'groq',      needsKey: true,  needsBaseUrl: false, models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-32b'] },
  ollama:    { label: 'Ollama (local)',           prefix: 'ollama',    needsKey: false, needsBaseUrl: true,  models: ['llama3.1', 'qwen2.5', 'mistral', 'phi3'] },
  custom:    { label: 'OpenAI-compatible (custom)', prefix: 'openai',  needsKey: true,  needsBaseUrl: true,  models: [] },
  // Claude CLI : relaie vers le binaire `claude` local déjà authentifié (shim Ryvie-Back,
  // cf. claudeCliService). Pas de clé ni d'URL : on réutilise la session Claude Code.
  'claude-cli': { label: 'Claude CLI',            prefix: 'openai',    needsKey: false, needsBaseUrl: false, models: ['sonnet', 'opus', 'haiku'] }
};

// Hôte joint depuis le conteneur LiteLLM. On utilise le nom DNS `host.docker.internal`
// (résolu via `extra_hosts: host-gateway`, cf. litellmService) plutôt que l'IP LAN de
// la machine : ainsi un changement d'IP (déplacement, DHCP…) n'impacte PAS l'IA.
const DOCKER_HOST_ALIAS = 'host.docker.internal';

function providerDefaultBaseUrl(provider: string): string {
  if (provider === 'ollama') return `http://${DOCKER_HOST_ALIAS}:11434`;
  // Claude CLI : LiteLLM (conteneur) appelle le shim sur l'hôte (Ryvie-Back :PORT).
  if (provider === 'claude-cli') return `http://${DOCKER_HOST_ALIAS}:${process.env.PORT || 3002}/api/ai/cli/v1`;
  return '';
}

// ───────── Chiffrement des secrets (clé fournisseur) ─────────
function getCipherKey(): Buffer {
  const fromEnv = process.env.ENCRYPTION_KEY;
  if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) return Buffer.from(fromEnv, 'hex');
  try {
    if (fs.existsSync(AI_KEY_FILE)) return Buffer.from(fs.readFileSync(AI_KEY_FILE, 'utf8').trim(), 'hex');
  } catch (_) { /* régénère ci-dessous */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(AI_DIR, { recursive: true });
  fs.writeFileSync(AI_KEY_FILE, key.toString('hex'), 'utf8');
  try { fs.chmodSync(AI_KEY_FILE, 0o600); } catch (_) { /* best effort */ }
  return key;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getCipherKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(blob: string): string {
  try {
    const [ivh, tagh, ench] = String(blob).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getCipherKey(), Buffer.from(ivh, 'hex'));
    decipher.setAuthTag(Buffer.from(tagh, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ench, 'hex')), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

// ───────── Store de configuration ─────────
function loadConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
  } catch (_) {
    return { provider: null, model: null, baseUrl: '', apiKeyEnc: null, masterKey: null, connectedApps: [] };
  }
}

function saveConfig(cfg: any): void {
  fs.mkdirSync(AI_DIR, { recursive: true });
  fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  try { fs.chmodSync(AI_CONFIG_FILE, 0o600); } catch (_) { /* best effort */ }
}

function getMasterKey(cfg: any): string {
  if (cfg.masterKey) return cfg.masterKey;
  cfg.masterKey = 'sk-ryvie-' + crypto.randomBytes(24).toString('hex');
  return cfg.masterKey;
}

// Réseau DÉDIÉ à l'IA (cf. litellmService). Les apps connectées y sont rattachées
// (ai.containers) pour joindre `ryvie-litellm` par DNS, SANS accès à l'infra sensible
// de ryvie-network (keycloak, openldap, base SSO…).
const LITELLM_NETWORK = litellm.AI_NETWORK;

/**
 * Base OpenAI-compatible que les apps utilisent pour joindre LiteLLM. On adresse le
 * conteneur par son NOM (ryvie-litellm) via le DNS Docker plutôt que par l'IP de
 * l'hôte : ainsi un changement d'IP de la machine n'impacte PAS les apps connectées
 * (elles sont rattachées au réseau ryvie-network, cf. ensureContainersOnNetwork).
 */
function appBaseUrl(): string {
  return `http://${litellm.CONTAINER}:${litellm.PORT}/v1`;
}

/**
 * Rattache (ou détache) les conteneurs déclarés par l'app (bloc `ai.containers`) au
 * réseau de LiteLLM, pour qu'ils résolvent `ryvie-litellm` par DNS Docker. Idempotent
 * et silencieux : `docker network connect/disconnect` échoue sans gravité si l'état
 * est déjà celui voulu. Fait APRÈS un éventuel `up -d` (sinon un recreate le perdrait).
 */
function ensureContainersOnNetwork(ai: any, attach: boolean): Promise<void> {
  const containers: string[] = Array.isArray(ai && ai.containers) ? ai.containers : [];
  if (!containers.length) return Promise.resolve();
  if (attach) litellm.ensureNetwork(); // le réseau doit exister avant de rattacher
  const { exec } = require('child_process');
  const action = attach ? 'connect' : 'disconnect';
  return Promise.all(containers.map((c: string) => new Promise<void>((resolve) => {
    exec(`docker network ${action} ${LITELLM_NETWORK} ${c}`, { timeout: 30000 }, (err: any) => {
      if (err && !/already exists|not connected|endpoint/i.test(String(err.message || ''))) {
        console.warn(`[ai] network ${action} ${c}:`, err.message);
      }
      resolve();
    });
  }))).then(() => undefined);
}

// Nom de modèle STABLE exposé aux apps. LiteLLM le remappe vers le vrai modèle
// courant → les apps pointent dessus une fois pour toutes, et changer de
// modèle/fournisseur dans Ryvie ne nécessite AUCUNE reconfiguration des apps.
const RYVIE_MODEL_ALIAS = 'ryvie-ai';

/** Modèle override d'une app (bloc `appModels` de la config), '' si aucun. */
function appModelOverride(cfg: any, appId: string): string {
  const m = cfg && cfg.appModels && cfg.appModels[appId];
  return (m && String(m).trim()) || '';
}

/** Alias LiteLLM à utiliser pour une app : dédié `ryvie-ai-<appId>` si l'app a un
 *  override de modèle, sinon l'alias global `ryvie-ai`. */
function appModelAlias(cfg: any, appId: string): string {
  return appModelOverride(cfg, appId) ? `${RYVIE_MODEL_ALIAS}-${appId}` : RYVIE_MODEL_ALIAS;
}

// ───────── Génération du config.yaml LiteLLM ─────────
function buildConfigYaml(cfg: any): string {
  const p = PROVIDERS[cfg.provider];
  const base = cfg.baseUrl || providerDefaultBaseUrl(cfg.provider);
  const paramsBlock = (m: string): string => {
    // `*` en début de scalaire = alias YAML → on quote la valeur passthrough.
    const target = m === '*' ? `"${p.prefix}/*"` : `${p.prefix}/${m}`;
    const lines = [`      model: ${target}`];
    if (p.needsKey) lines.push('      api_key: os.environ/PROVIDER_API_KEY');
    // Claude CLI : le shim Ryvie-Back valide la master key → on la passe comme api_key.
    else if (cfg.provider === 'claude-cli') lines.push('      api_key: os.environ/LITELLM_MASTER_KEY');
    if (base) lines.push(`      api_base: ${base}`);
    return lines.join('\n');
  };
  const entries: string[] = [];
  const seen = new Set<string>();
  const addEntry = (name: string, target: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    // Idem : `*` doit être quoté en YAML (sinon interprété comme alias).
    const yamlName = name === '*' ? '"*"' : name;
    entries.push(`  - model_name: ${yamlName}\n    litellm_params:\n${paramsBlock(target)}`);
  };

  // ⭐ Alias STABLE que les apps utilisent (RYVIE_MODEL_ALIAS) : il pointe toujours
  // vers le modèle courant. Changer de modèle/fournisseur dans Ryvie ne fait que
  // remapper cet alias ici → les apps n'ont RIEN à changer (vrai intérêt du gateway).
  if (cfg.model) addEntry(RYVIE_MODEL_ALIAS, cfg.model);

  // Override par app : une app peut utiliser un modèle DIFFÉRENT du modèle global
  // (même fournisseur). On expose alors un alias dédié `ryvie-ai-<appId>` routé vers
  // ce modèle ; le hook de l'app reçoit cet alias via RYVIE_AI_MODEL (cf. hookVars).
  // Les apps sans override gardent l'alias global `ryvie-ai`.
  const appModels = (cfg.appModels && typeof cfg.appModels === 'object') ? cfg.appModels : {};
  for (const appId of Object.keys(appModels)) {
    const am = appModels[appId];
    if (am && String(am).trim()) addEntry(`${RYVIE_MODEL_ALIAS}-${appId}`, String(am).trim());
  }

  // Alias OpenAI : beaucoup d'apps (ex. AFFiNE Copilot) ont un registre interne de
  // modèles et n'acceptent QUE des noms OpenAI standards. Quand le fournisseur n'est
  // pas OpenAI, on expose ces noms et on les route vers le modèle configuré → l'app
  // « voit » un modèle qu'elle connaît, servi en réalité par Gemini/Anthropic/etc.
  if (p.prefix !== 'openai' && cfg.model) {
    for (const alias of [
      'gpt-4o', 'gpt-4o-mini', 'gpt-4o-2024-08-06',
      'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-2025-04-14',
      'gpt-4-turbo', 'gpt-3.5-turbo', 'gpt-5-mini', 'o4-mini', 'o3-mini'
    ]) {
      addEntry(alias, cfg.model);
    }
  }

  // Catch-all : route TOUT autre nom de modèle vers le fournisseur courant en
  // passthrough (`<prefix>/*`). Indispensable pour tester un modèle précis (ex.
  // « sonnet ») avant de l'enregistrer, et pour qu'une app puisse demander un
  // modèle brut. Les entrées explicites ci-dessus restent prioritaires (LiteLLM
  // ne retombe sur le wildcard que pour un nom non listé). Sans clé (claude-cli),
  // c'est le shim Ryvie-Back qui reçoit le vrai nom et le passe à `claude --model`.
  addEntry('*', '*');

  return [
    '# Généré par Ryvie — LiteLLM. Ne pas éditer à la main.',
    'model_list:',
    entries.join('\n'),
    'general_settings:',
    '  master_key: os.environ/LITELLM_MASTER_KEY',
    'litellm_settings:',
    '  drop_params: true',
    '  telemetry: false',
    ''
  ].join('\n');
}

// ───────── Secrets par app (round-trip avec les hooks) ─────────
// Certains hooks d'apps doivent MÉMORISER un secret entre deux exécutions (ex. n8n :
// une clé API créée à la 1ère connexion, réutilisée ensuite SANS le mot de passe → la
// connexion IA survit à un changement d'identifiants de l'app). Ryvie stocke ce secret
// chiffré dans AI_CONFIG_FILE (appSecrets[appId]) et le transmet au hook (RYVIE_APP_SECRET),
// qui peut en écrire une version à jour dans le fichier RYVIE_APP_SECRET_OUT (relu ici).
function loadAppSecret(appId: string): any {
  const cfg = loadConfig();
  const blob = cfg.appSecrets && cfg.appSecrets[appId];
  if (!blob) return {};
  try { return JSON.parse(decrypt(blob)) || {}; } catch (_) { return {}; }
}

function saveAppSecret(appId: string, secretObj: any): void {
  const cfg = loadConfig();
  cfg.appSecrets = cfg.appSecrets || {};
  cfg.appSecrets[appId] = encrypt(JSON.stringify(secretObj || {}));
  saveConfig(cfg);
}

// ───────── Helpers apps ─────────
function resolveAppDir(manifest: any, appId: string): string {
  const sourceDir = manifest?.sourceDir || path.join(APPS_DIR, appId);
  const composePath = manifest?.dockerComposePath || 'docker-compose.yml';
  return composePath.includes('/') ? path.join(sourceDir, path.dirname(composePath)) : sourceDir;
}

/**
 * Redémarre une app de façon ASYNCHRONE (jamais execSync : sinon `docker compose`
 * gèle toute la boucle d'événements Node → backend qui ne répond plus). `up -d`
 * ne recrée que les conteneurs dont la config a changé. Awaité pour séquencer
 * correctement les hooks qui doivent tourner APRÈS le redémarrage.
 */
function composeUp(appDir: string): Promise<void> {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('docker compose up -d', { cwd: appDir, timeout: 300000 }, (err: any) => {
      if (err) console.error(`[ai] ❌ Redémarrage (${appDir}):`, err.message);
      resolve();
    });
  });
}

/** Normalise le bloc `ai.set` (string|array) en listes de noms de variables. */
function normalizeAiSet(ai: any): { apiKey: string[]; baseUrl: string[]; model: string[] } {
  const s = (ai && ai.set) || {};
  const arr = (x: any): string[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
  return { apiKey: arr(s.apiKey), baseUrl: arr(s.baseUrl), model: arr(s.model) };
}

/**
 * Pose (ou retire) les variables d'env IA dans le .env de l'app — SANS redémarrer.
 * `set` → master key / base LiteLLM / modèle. `extraEnv` → constantes. `generateEnv`
 * → secrets stables générés UNE fois (jamais retirés au débranchement, sinon les
 * données chiffrées par l'app deviendraient illisibles, ex. OPEN_NOTEBOOK_ENCRYPTION_KEY).
 */
function mutateAppEnv(appDir: string, ai: any, remove: boolean): void {
  const cfg = loadConfig();
  const values: Record<string, string> = { apiKey: getMasterKey(cfg), baseUrl: appBaseUrl(), model: cfg.model || '' };
  const envPath = path.join(appDir, '.env');
  let content = readEnvFile(envPath);

  const sets = normalizeAiSet(ai);
  for (const canon of ['apiKey', 'baseUrl', 'model'] as const) {
    for (const varName of sets[canon]) {
      content = remove ? unsetEnvVar(content, varName) : setEnvVar(content, varName, values[canon]);
    }
  }
  const extra = (ai.extraEnv && typeof ai.extraEnv === 'object') ? ai.extraEnv : {};
  for (const k of Object.keys(extra)) {
    content = remove ? unsetEnvVar(content, k) : setEnvVar(content, k, String(extra[k]));
  }
  if (!remove && Array.isArray(ai.generateEnv)) {
    for (const v of ai.generateEnv) {
      const cur = getEnvVar(content, v);
      if (cur == null || cur === '') content = setEnvVar(content, v, crypto.randomBytes(32).toString('hex'));
    }
  }
  writeEnvFile(envPath, content);
}

/** Variables passées aux scripts de hook (ai/connect.sh, ai/disconnect.sh). */
function hookVars(appId: string, appDir: string, mode: 'connect' | 'disconnect', manifest?: any): Record<string, string> {
  const cfg = loadConfig();
  const override = appModelOverride(cfg, appId);
  const vars: Record<string, string> = {
    RYVIE_AI_API_KEY: getMasterKey(cfg),
    RYVIE_AI_BASE_URL: appBaseUrl(),
    // Les apps utilisent un alias STABLE, pas le vrai nom de modèle → un changement
    // de modèle ultérieur côté Ryvie ne les impacte pas. Alias dédié `ryvie-ai-<app>`
    // si l'app a un modèle personnalisé, sinon l'alias global `ryvie-ai`. Le vrai
    // modèle est exposé séparément pour info (RYVIE_AI_BACKEND_MODEL).
    RYVIE_AI_MODEL: appModelAlias(cfg, appId),
    RYVIE_AI_BACKEND_MODEL: override || cfg.model || '',
    RYVIE_AI_PROVIDER: cfg.provider || '',
    RYVIE_AI_MODE: mode,
    RYVIE_APP_ID: appId,
    RYVIE_APP_DIR: appDir,
    RYVIE_LOCAL_IP: getLocalIP()
  };
  // Identifiants du compte par défaut (bloc `accounts.default` du manifeste) —
  // utiles aux hooks d'apps qui exigent une auth pour créer une credential (ex. n8n).
  const def = manifest && manifest.accounts && manifest.accounts.default;
  if (def && def.email) vars.RYVIE_APP_LOGIN_EMAIL = String(def.email);
  if (def && def.password) vars.RYVIE_APP_LOGIN_PASSWORD = String(def.password);
  return vars;
}

/**
 * Exécute un hook fourni par l'app (script côté hôte, comme install.sh) : c'est
 * ce qui permet aux apps à registre interne (open-notebook…) de décrire ELLES-MÊMES
 * comment se connecter à l'IA (appels API, SQL, etc.). Ne lève jamais.
 */
function runHook(scriptRel: string, appDir: string, vars: Record<string, string>, appId?: string): Promise<void> {
  const fs = require('fs');
  const scriptPath = path.join(appDir, scriptRel);
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[ai] hook introuvable: ${scriptPath}`);
    return Promise.resolve();
  }
  // Round-trip du secret par app : on passe le secret courant (RYVIE_APP_SECRET) et un
  // fichier de sortie (RYVIE_APP_SECRET_OUT) où le hook peut écrire un secret mis à jour.
  const outFile = appId
    ? path.join(require('os').tmpdir(), `ryvie-secret-${appId}-${process.pid}-${Date.now()}.json`)
    : '';
  const secretEnv = appId
    ? { RYVIE_APP_SECRET: JSON.stringify(loadAppSecret(appId)), RYVIE_APP_SECRET_OUT: outFile }
    : {};
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec(`sh "${scriptPath}"`, { cwd: appDir, env: { ...process.env, ...vars, ...secretEnv }, timeout: 180000 },
      (err: any, stdout: string, stderr: string) => {
        if (err) console.error(`[ai] ❌ hook ${scriptRel}:`, err.message, String(stderr || '').slice(0, 400));
        else console.log(`[ai] ✅ hook ${scriptRel}:`, String(stdout || '').trim().slice(-300));
        // Persiste le secret si le hook en a écrit un nouveau.
        if (outFile) {
          try {
            if (fs.existsSync(outFile)) {
              const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
              saveAppSecret(appId as string, data);
            }
          } catch (e: any) {
            console.warn(`[ai] secret ${appId}: lecture impossible`, e.message);
          } finally {
            try { fs.unlinkSync(outFile); } catch (_) { /* best effort */ }
          }
        }
        resolve();
      });
  });
}

/** Provisionne une app : env (set+generateEnv) → redémarrage → hook connect. */
async function provisionApp(appId: string): Promise<void> {
  const manifest = await appManager.getAppManifest(appId);
  const ai = manifest && manifest.ai;
  if (!ai) throw Object.assign(new Error(`L'app ${appId} ne déclare pas de support IA`), { status: 400 });
  const appDir = resolveAppDir(manifest, appId);
  mutateAppEnv(appDir, ai, false);
  if (ai.restart !== false) await composeUp(appDir);
  // APRÈS un éventuel recreate : rattache les conteneurs de l'app au réseau LiteLLM
  // (pour résoudre `ryvie-litellm` par DNS → adressage indépendant de l'IP hôte).
  await ensureContainersOnNetwork(ai, true);
  if (ai.hooks && ai.hooks.connect) await runHook(ai.hooks.connect, appDir, hookVars(appId, appDir, 'connect', manifest), appId);
}

/** Déprovisionne : hook disconnect (app encore up) → retrait env → redémarrage. */
async function deprovisionApp(appId: string): Promise<void> {
  const manifest = await appManager.getAppManifest(appId);
  const ai = manifest && manifest.ai;
  const appDir = resolveAppDir(manifest, appId);
  if (ai && ai.hooks && ai.hooks.disconnect) await runHook(ai.hooks.disconnect, appDir, hookVars(appId, appDir, 'disconnect', manifest), appId);
  if (ai) mutateAppEnv(appDir, ai, true);
  if (ai && ai.restart !== false) await composeUp(appDir);
  // Détache les conteneurs de l'app du réseau LiteLLM (symétrique du connect).
  if (ai) await ensureContainersOnNetwork(ai, false);
}

// ───────── API publique ─────────

/** État courant : fournisseur, modèle, clé présente, LiteLLM up, base apps. */
function getStatus(runningOverride?: boolean): any {
  const cfg = loadConfig();
  const p = cfg.provider ? PROVIDERS[cfg.provider] : null;
  return {
    configured: !!cfg.provider,
    provider: cfg.provider || null,
    model: cfg.model || null,
    baseUrl: cfg.baseUrl || '',
    hasKey: !!cfg.apiKeyEnc || (!!p && !p.needsKey),
    // enabled absent = activé (rétro-compatibilité). Désactivé => LiteLLM arrêté pour libérer la RAM.
    enabled: cfg.enabled !== false,
    running: runningOverride != null ? runningOverride : litellm.isRunning(),
    appBaseUrl: cfg.provider ? appBaseUrl() : null
  };
}

/** Catalogue des fournisseurs (pour le front), sans secrets. */
function getProviders(): any[] {
  return Object.entries(PROVIDERS).map(([id, p]: any) => ({
    id, label: p.label, needsKey: p.needsKey, needsBaseUrl: p.needsBaseUrl,
    models: p.models, defaultBaseUrl: providerDefaultBaseUrl(id)
  }));
}

/** Liste des apps installées qui déclarent un support IA, avec leur état connecté. */
async function listApps(): Promise<any[]> {
  const cfg = loadConfig();
  const connected = new Set<string>(cfg.connectedApps || []);
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(MANIFESTS_DIR); } catch (_) { dirs = []; }
  const out: any[] = [];
  for (const d of dirs) {
    let m: any = null;
    try { m = await appManager.getAppManifest(d); } catch (_) { m = null; }
    if (m && m.ai) out.push({
      id: d,
      name: m.name || d,
      connected: connected.has(d),
      // « redémarre » = Ryvie recrée la stack (restart !== false) OU le hook de l'app
      // redémarre lui-même un conteneur (hookRestarts, ex. Hermes). Sert à l'UI pour
      // prévenir avant connexion/déconnexion/changement de modèle.
      restarts: m.ai.restart !== false || m.ai.hookRestarts === true,
      // Modèle propre à l'app (override) ou null → utilise le modèle global par défaut.
      model: appModelOverride(cfg, d) || null
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Définit/maj le fournisseur IA : persiste (clé chiffrée), régénère la config
 * LiteLLM, (re)démarre le proxy, puis ré-applique la config aux apps connectées.
 */
async function setProviderConfig(input: any): Promise<any> {
  const { provider, apiKey, baseUrl, model } = input || {};
  if (!provider || !PROVIDERS[provider]) {
    throw Object.assign(new Error('Fournisseur IA inconnu'), { status: 400 });
  }
  const p = PROVIDERS[provider];
  const cfg = loadConfig();
  const keyChanged = !!(apiKey && String(apiKey).trim());

  cfg.provider = provider;
  // Le modèle ne doit JAMAIS valoir l'id du fournisseur (ex. 'claude-cli') : ce nom
  // sert de sentinelle « pas de --model » dans le shim claudeCliService → les apps
  // retomberaient toujours sur le modèle par défaut du CLI. On rejette donc cette
  // valeur et on retombe sur le 1er modèle suggéré (sonnet pour claude-cli).
  const requestedModel = (model && String(model).trim());
  cfg.model = (requestedModel && requestedModel !== provider) ? requestedModel : (p.models[0] || '');
  // On ne PERSISTE une baseUrl que pour les fournisseurs qui en exigent une (ollama,
  // custom). Pour les autres (claude-cli…), on laisse vide → buildConfigYaml recalcule
  // toujours `host.docker.internal` à la volée, sans jamais figer l'IP de la machine.
  cfg.baseUrl = (p.needsBaseUrl && baseUrl && String(baseUrl).trim()) || '';

  if (p.needsBaseUrl && !cfg.baseUrl && !providerDefaultBaseUrl(provider)) {
    throw Object.assign(new Error('Une URL de base est requise pour ce fournisseur'), { status: 400 });
  }
  // Clé : nouvelle valeur si fournie, sinon réutilise l'existante.
  if (keyChanged) cfg.apiKeyEnc = encrypt(String(apiKey).trim());
  if (p.needsKey && !cfg.apiKeyEnc) {
    throw Object.assign(new Error('Une clé d\'API est requise pour ce fournisseur'), { status: 400 });
  }

  getMasterKey(cfg);
  saveConfig(cfg);

  const { ready, restarted } = await applyLitellmConfig(cfg, { keyChanged });

  // PAS de re-provisioning des apps connectées : elles pointent sur l'alias STABLE
  // `ryvie-ai` (ou leur alias dédié `ryvie-ai-<app>`), que LiteLLM vient de remapper
  // vers le nouveau modèle. Changer de modèle/fournisseur est donc TRANSPARENT pour
  // les apps (rien à redémarrer). Le re-provision n'a lieu qu'au connect explicite
  // d'une app ou lors d'un changement de modèle par app (setAppModel).

  return { ...getStatus(ready), ready, restarted };
}

/**
 * (Re)génère la config LiteLLM depuis `cfg` et NE redémarre le proxy QUE si le
 * contenu effectif change (nouvelle clé, YAML différent, ou proxy à l'arrêt) :
 * réécrire une config identique ne provoque aucun redémarrage. Mutualisé entre
 * setProviderConfig (changement de fournisseur) et setAppModel (modèle par app).
 */
async function applyLitellmConfig(cfg: any, opts: { keyChanged?: boolean } = {}): Promise<{ ready: boolean; restarted: boolean }> {
  // Fournisseur IA désactivé par l'admin : on persiste la config mais on NE démarre
  // pas le proxy (économie de RAM). Il sera (re)démarré à la réactivation.
  if (cfg.enabled === false) {
    return { ready: false, restarted: false };
  }
  const masterKey = getMasterKey(cfg);
  const newYaml = buildConfigYaml(cfg);
  let curYaml = '';
  try { curYaml = require('fs').readFileSync(LITELLM_CONFIG_YAML, 'utf8'); } catch (_) { curYaml = ''; }
  const needRestart =
    !!opts.keyChanged ||
    !litellm.isConfigured() ||
    !litellm.isRunning() ||
    newYaml !== curYaml;

  let ready: boolean;
  if (needRestart) {
    const providerKey = cfg.apiKeyEnc ? decrypt(cfg.apiKeyEnc) : '';
    litellm.writeCompose();
    litellm.writeConfigYaml(newYaml);
    litellm.writeEnv({ masterKey, providerKey });
    litellm.restart();
    ready = await litellm.probe(masterKey);
  } else {
    ready = litellm.isRunning();
  }
  return { ready, restarted: needRestart };
}

/**
 * Définit (ou efface) le modèle PROPRE à une app. Modèle vide/null ou égal au modèle
 * global → pas d'override, l'app retombe sur l'alias global `ryvie-ai`. Régénère la
 * config LiteLLM (pour créer/retirer l'alias dédié) puis, si l'app est connectée,
 * la re-provisionne pour que son hook reçoive le bon alias dans RYVIE_AI_MODEL.
 */
async function setAppModel(appId: string, model: any): Promise<any> {
  const cfg = loadConfig();
  if (!cfg.provider) throw Object.assign(new Error('Configurez d\'abord un fournisseur IA'), { status: 400 });
  cfg.appModels = (cfg.appModels && typeof cfg.appModels === 'object') ? cfg.appModels : {};
  const m = (model && String(model).trim()) || '';
  if (m && m !== cfg.model) cfg.appModels[appId] = m;
  else delete cfg.appModels[appId]; // vide ou identique au modèle global → override retiré
  saveConfig(cfg);

  const { ready } = await applyLitellmConfig(cfg, {});

  // Ré-applique à l'app SI elle est connectée : son hook relit RYVIE_AI_MODEL (alias
  // dédié ou global). Une app non connectée prendra le bon alias à sa prochaine connexion.
  if ((cfg.connectedApps || []).includes(appId)) {
    await provisionApp(appId);
  }
  return { ...getStatus(ready), ready, appId, appModel: cfg.appModels[appId] || null };
}

/** Connecte une app : env + redémarrage + hook connect + ajout à la liste. */
async function connectApp(appId: string): Promise<any> {
  if (!loadConfig().provider) throw Object.assign(new Error('Configurez d\'abord un fournisseur IA'), { status: 400 });
  await provisionApp(appId);
  // RECHARGE après provisionApp : le hook a pu écrire dans la config (ex. appSecrets),
  // sinon on écraserait ces écritures avec un cfg périmé.
  const cfg = loadConfig();
  cfg.connectedApps = cfg.connectedApps || [];
  if (!cfg.connectedApps.includes(appId)) cfg.connectedApps.push(appId);
  saveConfig(cfg);
  return { connected: true };
}

/**
 * Bootstrap d'un secret d'app au moment de l'INSTALL, pendant que le compte par
 * défaut (et son mot de passe) est encore valide. Exécute le hook
 * `ai.hooks.bootstrap` de l'app (s'il existe) avec les identifiants du compte par
 * défaut + le round-trip de secret (RYVIE_APP_SECRET / RYVIE_APP_SECRET_OUT). Le
 * secret produit (ex. clé API n8n) est stocké chiffré dans appSecrets : la connexion
 * IA ultérieure devient INDÉPENDANTE du mot de passe (l'utilisateur peut le changer
 * avant de connecter l'IA). N'exige PAS qu'un fournisseur IA soit configuré.
 * Best-effort : ne lève jamais (l'install ne doit pas échouer pour ça).
 */
async function bootstrapAppSecret(appId: string): Promise<void> {
  let manifest: any = null;
  try { manifest = await appManager.getAppManifest(appId); } catch (_) { return; }
  const ai = manifest && manifest.ai;
  if (!ai || !ai.hooks || !ai.hooks.bootstrap) return; // app sans hook bootstrap → no-op
  const appDir = resolveAppDir(manifest, appId);
  const def = manifest.accounts && manifest.accounts.default;
  const vars: Record<string, string> = {
    RYVIE_APP_ID: appId,
    RYVIE_APP_DIR: appDir,
    RYVIE_LOCAL_IP: getLocalIP(),
  };
  // Identifiants du compte par défaut (valides à l'install) → le hook se logue sans
  // dépendre d'un mot de passe que l'utilisateur aurait déjà changé.
  if (def && def.email) vars.RYVIE_APP_LOGIN_EMAIL = String(def.email);
  if (def && def.password) vars.RYVIE_APP_LOGIN_PASSWORD = String(def.password);
  try {
    await runHook(ai.hooks.bootstrap, appDir, vars, appId);
  } catch (e: any) {
    console.warn(`[ai] bootstrapAppSecret(${appId}):`, e?.message);
  }
}

/** Déconnecte une app : hook disconnect + retrait des variables IA + redémarrage. */
async function disconnectApp(appId: string): Promise<any> {
  await deprovisionApp(appId);
  // RECHARGE après deprovisionApp (cohérence avec connectApp : le hook a pu écrire).
  const cfg = loadConfig();
  cfg.connectedApps = (cfg.connectedApps || []).filter((a: string) => a !== appId);
  saveConfig(cfg);
  return { connected: false };
}

/**
 * Purge COMPLÈTE de l'état IA d'une app — à appeler lors de la DÉSINSTALLATION,
 * AVANT que les conteneurs/fichiers de l'app soient supprimés (le hook disconnect
 * a besoin que l'app tourne encore pour s'exécuter / nettoyer sa config).
 * Best-effort : ne lève jamais (la désinstallation ne doit pas échouer pour ça).
 *   1) déconnexion (hook disconnect + retrait env + détache du réseau LiteLLM),
 *   2) purge des entrées de config (connectedApps, appSecrets, appModels),
 *   3) régénération + application de la config LiteLLM (retire l'alias fantôme).
 */
async function purgeApp(appId: string): Promise<void> {
  // 1) Déconnexion (lance le hook disconnect tant que l'app tourne encore).
  try {
    await deprovisionApp(appId);
  } catch (e: any) {
    console.warn(`[ai] purgeApp: déconnexion de ${appId} échouée (on continue):`, e?.message);
  }

  // 2) Purge des entrées de config propres à l'app.
  let cfg: any;
  try { cfg = loadConfig(); } catch (_) { return; }
  if (!cfg) return;
  let touched = false;
  if (Array.isArray(cfg.connectedApps) && cfg.connectedApps.includes(appId)) {
    cfg.connectedApps = cfg.connectedApps.filter((a: string) => a !== appId);
    touched = true;
  }
  if (cfg.appSecrets && cfg.appSecrets[appId]) { delete cfg.appSecrets[appId]; touched = true; }
  if (cfg.appModels && cfg.appModels[appId]) { delete cfg.appModels[appId]; touched = true; }
  if (!touched) return;
  try { saveConfig(cfg); } catch (e: any) {
    console.warn(`[ai] purgeApp: sauvegarde config échouée:`, e?.message);
    return;
  }

  // 3) Régénère + applique la config LiteLLM (retire l'alias de modèle fantôme).
  try {
    await applyLitellmConfig(loadConfig(), {});
  } catch (e: any) {
    console.warn(`[ai] purgeApp: régénération LiteLLM échouée:`, e?.message);
  }
}

/**
 * Récupère EN DIRECT la liste des modèles d'un fournisseur via son API native.
 * Utilise la clé fournie (formulaire) ou, à défaut, celle déjà enregistrée.
 * Ne lève jamais : renvoie { ok, models } ou { ok:false, error }.
 */
async function listProviderModels(input: any = {}): Promise<any> {
  const axios = require('axios');
  const cfg = loadConfig();
  const provider = input.provider || cfg.provider;
  if (!provider || !PROVIDERS[provider]) return { ok: false, error: 'Fournisseur inconnu' };
  const key = (input.apiKey && String(input.apiKey).trim())
    || (cfg.provider === provider && cfg.apiKeyEnc ? decrypt(cfg.apiKeyEnc) : '');
  const baseUrl = (input.baseUrl && String(input.baseUrl).trim()) || cfg.baseUrl || providerDefaultBaseUrl(provider);
  const p = PROVIDERS[provider];
  if (p.needsKey && !key) return { ok: false, error: 'Clé requise pour lister les modèles' };

  // Construit (url, headers, extracteur) selon le fournisseur.
  let url = '';
  let headers: Record<string, string> = {};
  let extract: (d: any) => string[] = () => [];
  const openaiStyle = (base: string) => {
    const b = base.replace(/\/+$/, '');
    url = /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
    headers = { Authorization: `Bearer ${key}` };
    extract = (d) => (d?.data || []).map((m: any) => m.id).filter(Boolean);
  };

  try {
    switch (provider) {
      case 'openai': openaiStyle('https://api.openai.com'); break;
      case 'mistral': openaiStyle('https://api.mistral.ai'); break;
      case 'groq': openaiStyle('https://api.groq.com/openai'); break;
      case 'custom': openaiStyle(baseUrl || ''); break;
      case 'ollama':
        url = `${(baseUrl || '').replace(/\/+$/, '')}/api/tags`;
        extract = (d) => (d?.models || []).map((m: any) => m.name).filter(Boolean);
        break;
      case 'anthropic':
        url = 'https://api.anthropic.com/v1/models';
        headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        extract = (d) => (d?.data || []).map((m: any) => m.id).filter(Boolean);
        break;
      case 'gemini':
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`;
        extract = (d) => (d?.models || [])
          .filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m: any) => String(m.name || '').replace(/^models\//, ''))
          .filter(Boolean);
        break;
      default: return { ok: false, error: 'Listing non supporté pour ce fournisseur' };
    }

    if (!url) return { ok: false, error: 'URL de base manquante' };
    const res = await axios.get(url, { timeout: 15000, headers, validateStatus: () => true });
    if (res.status !== 200) {
      let msg = res.data?.error?.message || res.data?.error || `HTTP ${res.status}`;
      if (typeof msg === 'object') msg = JSON.stringify(msg);
      return { ok: false, status: res.status, error: String(msg).slice(0, 300) };
    }
    const models = Array.from(new Set(extract(res.data))).sort();
    return { ok: true, models };
  } catch (err: any) {
    return { ok: false, error: `Listing impossible: ${err.message}` };
  }
}

/**
 * Teste réellement la chaîne app → LiteLLM → fournisseur : petit chat completion
 * avec le modèle configuré. Renvoie { ok, reply?, error?, status? } sans jamais
 * lever (les erreurs fournisseur — quota, clé invalide… — sont remontées telles quelles).
 */
async function testConnection(input: any = {}): Promise<any> {
  const cfg = loadConfig();
  // Fournisseur à tester : celui SÉLECTIONNÉ dans le formulaire (input.provider)
  // sinon l'enregistré. Permet de tester avant d'avoir cliqué « Enregistrer ».
  const provider = (input && input.provider && String(input.provider).trim()) || cfg.provider;
  if (!provider) return { ok: false, error: 'Aucun fournisseur configuré' };
  const masterKey = getMasterKey(cfg);
  // Modèle à tester : celui passé par le formulaire (sélection courante) sinon
  // celui enregistré.
  const testModel = (input && input.model && String(input.model).trim()) || cfg.model || 'gpt-4o-mini';

  // Claude CLI : on teste DIRECTEMENT le shim local (relais vers le binaire `claude`),
  // SANS passer par la passerelle LiteLLM. Raison : la passerelle reflète le fournisseur
  // ENREGISTRÉ (souvent un autre, ex. Gemini) ; la router vers Claude CLI exigerait de
  // l'enregistrer d'abord, ce qui basculerait toutes les apps connectées. Le test reste
  // ainsi non destructif et valide réellement ce que l'utilisateur vient de sélectionner.
  if (provider === 'claude-cli') {
    const axios = require('axios');
    const port = process.env.PORT || 3002;
    try {
      const res = await axios.post(
        `http://127.0.0.1:${port}/api/ai/cli/v1/chat/completions`,
        { model: testModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 },
        { timeout: 60000, headers: { Authorization: `Bearer ${masterKey}`, 'Content-Type': 'application/json' }, validateStatus: () => true }
      );
      if (res.status === 200) {
        const reply = res.data?.choices?.[0]?.message?.content || '';
        return { ok: true, model: testModel, reply: String(reply).slice(0, 200) };
      }
      let msg = res.data?.error?.message || res.data?.error || `HTTP ${res.status}`;
      if (typeof msg === 'object') msg = JSON.stringify(msg);
      return { ok: false, status: res.status, model: testModel, error: String(msg).slice(0, 400) };
    } catch (err: any) {
      return { ok: false, model: testModel, error: `Claude CLI injoignable: ${err.message}` };
    }
  }

  // S'assurer que LiteLLM tourne (au cas où il aurait été arrêté).
  if (!litellm.isRunning()) {
    const r = litellm.ensureRunning();
    if (!r.success) return { ok: false, error: `LiteLLM injoignable: ${r.error || 'démarrage impossible'}` };
    await litellm.probe(masterKey, 20000);
  }

  const axios = require('axios');
  try {
    const res = await axios.post(
      `http://127.0.0.1:${litellm.PORT}/v1/chat/completions`,
      { model: testModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 },
      { timeout: 30000, headers: { Authorization: `Bearer ${masterKey}`, 'Content-Type': 'application/json' }, validateStatus: () => true }
    );
    if (res.status === 200) {
      const reply = res.data?.choices?.[0]?.message?.content || '';
      return { ok: true, model: testModel, reply: String(reply).slice(0, 200) };
    }
    // Extrait un message lisible de l'erreur LiteLLM/fournisseur.
    let msg = res.data?.error?.message || res.data?.error || `HTTP ${res.status}`;
    if (typeof msg === 'object') msg = JSON.stringify(msg);
    return { ok: false, status: res.status, model: testModel, error: String(msg).slice(0, 400) };
  } catch (err: any) {
    return { ok: false, error: `Appel impossible: ${err.message}` };
  }
}

/** Démarrage backend : relance LiteLLM s'il est configuré ET non désactivé. */
function ensureRunning() {
  const cfg = loadConfig();
  if (cfg.enabled === false) return { success: true, skipped: true, disabled: true };
  return litellm.ensureRunning();
}

/**
 * Active ou désactive le fournisseur IA (LiteLLM). Désactiver arrête le conteneur
 * `ryvie-litellm` (docker compose down) pour libérer la RAM ; réactiver le redémarre
 * avec la config existante. L'état est persisté (cfg.enabled) donc respecté au boot.
 */
async function setEnabled(enabled: boolean): Promise<any> {
  const cfg = loadConfig();
  cfg.enabled = !!enabled;
  saveConfig(cfg);

  if (!enabled) {
    litellm.stop();
    return { ...getStatus(false), enabled: false, ready: false };
  }

  // Réactivation : redémarre le proxy avec la config courante (si un fournisseur existe).
  let ready = false;
  if (cfg.provider) {
    const r = await applyLitellmConfig(cfg, {});
    ready = r.ready;
  } else {
    const r = litellm.ensureRunning();
    ready = (r.success && !r.skipped) || litellm.isRunning();
  }
  return { ...getStatus(ready), enabled: true, ready };
}

module.exports = {
  getStatus,
  getProviders,
  listApps,
  setProviderConfig,
  setAppModel,
  connectApp,
  disconnectApp,
  bootstrapAppSecret,
  purgeApp,
  testConnection,
  listProviderModels,
  ensureRunning,
  setEnabled
};
