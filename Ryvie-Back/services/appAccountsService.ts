/**
 * appAccountsService — Gestion des comptes internes des apps non-SSO.
 *
 * Permet à un admin de lister les comptes d'une app et de réinitialiser leur
 * mot de passe. Chaque app déclare une "recette" dans son ryvie-app.yml
 * (bloc `accounts:`), recopiée dans le manifest par appManagerService.
 * Le core n'exécute jamais de code livré par le store : il interprète une
 * poignée de stratégies connues, paramétrées par la recette.
 *
 * Règle transverse : ne JAMAIS logger un mot de passe en clair ni un hash.
 */

const Docker = require('dockerode');
const bcrypt = require('bcrypt');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const appManager = require('./appManagerService');
const { APPS_DIR } = require('../config/paths');

const docker = new Docker();

const BCRYPT_ROUNDS = 12;

// Provisioning par API à l'install : l'app vient de démarrer et son API REST peut ne pas
// être prête (connexion refusée, 5xx, réponse vide, ou — piège classique — le serveur web
// répond déjà en HTML 404/200/429 AVANT que /rest/* soit monté) au moment où l'on crée le
// compte par défaut. On retente jusqu'à PROVISION_READY_TIMEOUT_MS avant d'abandonner.
const PROVISION_READY_TIMEOUT_MS = 120000;
const PROVISION_RETRY_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Message renvoyé si la vérification post-reset échoue : le nouveau mot de passe
// n'authentifie pas réellement (format de hash inattendu, schéma modifié par une
// MAJ de l'app…). On lève une erreur plutôt que d'annoncer un faux succès.
const VERIFY_FAIL_MSG =
  "Réinitialisation effectuée mais NON vérifiée : le mot de passe ne semble pas accepté par l'app " +
  "(schéma/format de hash peut-être modifié par une mise à jour). À vérifier manuellement.";

/**
 * Exécute une commande dans un conteneur via l'API Docker (exec).
 * Les valeurs sensibles (mot de passe, hash) doivent être passées via `env`
 * et lues côté conteneur depuis l'environnement — jamais interpolées dans la
 * ligne de commande (anti-injection shell/SQL/Ruby).
 *
 * @param container Nom du conteneur (ex. "app-mealie")
 * @param cmd Tableau argv (ex. ['python3', '-c', '...'])
 * @param opts { env?: string[] ("KEY=val"), workingDir?: string }
 */
async function dockerExec(
  container: string,
  cmd: string[],
  opts: { env?: string[]; workingDir?: string; user?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const c = docker.getContainer(container);

  const exec = await c.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Env: opts.env,
    WorkingDir: opts.workingDir,
    // User optionnel : certains conteneurs doivent écrire des fichiers avec un
    // propriétaire précis (ex. Hermes WebUI tourne en `hermeswebui`).
    ...(opts.user ? { User: opts.user } : {}),
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    // Démultiplexe le flux multiplexé Docker (stdout / stderr séparés)
    docker.modem.demuxStream(
      stream,
      { write: (d: Buffer) => stdoutChunks.push(Buffer.from(d)) },
      { write: (d: Buffer) => stderrChunks.push(Buffer.from(d)) }
    );
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const info = await exec.inspect();

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode: typeof info.ExitCode === 'number' ? info.ExitCode : -1,
  };
}

export interface Account {
  id: string;
  email?: string;
  username?: string;
  isAdmin?: boolean;
}

export interface ListResult {
  supported: boolean;
  reason?: string;
  accounts: Account[];
  // Prévient l'UI qu'une réinitialisation de mot de passe redémarre/recrée l'app
  // (ex. hermes-webui / hermes-dashboard).
  restartsOnReset?: boolean;
}

/**
 * Récupère la recette `accounts` d'une app depuis son manifest.
 * Renvoie null si l'app est introuvable ou n'a pas de bloc accounts.
 * Renvoie également le flag sso pour permettre au routeur de refuser les apps SSO.
 */
async function getRecipe(
  appId: string
): Promise<{ recipe: any; sso: boolean; mainPort?: number } | null> {
  const manifest = await appManager.getAppManifest(appId);
  if (!manifest) return null;
  return {
    recipe: manifest.accounts || null,
    sso: manifest.sso === true,
    mainPort: manifest.mainPort,
  };
}

// ─────────────────── Stratégie : hermes-webui (mot de passe unique) ─────────
// Hermes WebUI s'authentifie par UN mot de passe (pas de multi-comptes), stocké
// hashé dans settings.json (HERMES_WEBUI_STATE_DIR). On le (ré)écrit via la
// fonction native save_settings({'_set_password': ...}) DANS le conteneur, en
// tant qu'utilisateur `hermeswebui` (propriétaire du fichier). Le serveur cache
// le hash en mémoire pour la durée du process → on redémarre le conteneur pour
// qu'il relise le nouveau mot de passe. (Le mot de passe ne transite que par
// l'environnement, jamais sur la ligne de commande.)
async function hermesWebuiReset(
  recipe: any,
  _accountId: string,
  newPassword: string
): Promise<void> {
  const container = recipe.container || 'app-hermes-webui';
  const py =
    'import os\n' +
    'from api.config import save_settings\n' +
    'save_settings({"_set_password": os.environ["NEW_PWD"]})\n' +
    'print("DONE")';
  const { stdout, stderr, exitCode } = await dockerExec(container, ['python3', '-c', py], {
    workingDir: '/app',
    user: recipe.user || 'hermeswebui',
    env: [`NEW_PWD=${newPassword}`],
  });
  if (exitCode !== 0 || !/DONE/.test(stdout)) {
    throw new Error(`hermes set-password échoué (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 200)}`);
  }
  // Le serveur webui cache le hash en mémoire → redémarrage du conteneur pour
  // qu'il relise settings.json. On SUSPEND le broadcast realtime pendant le
  // restart : sinon les événements Docker stop/start du conteneur remontent au
  // frontend et déclenchent une réaction parasite (l'app s'ouvre dans un onglet).
  const realtimeService = (global as any).realtimeService;
  try {
    if (realtimeService?.pauseBroadcast) realtimeService.pauseBroadcast();
    await docker.getContainer(container).restart({ t: 5 });
  } catch (e: any) {
    throw new Error(`hermes: mot de passe écrit mais redémarrage du conteneur échoué: ${e.message}`);
  } finally {
    if (realtimeService?.resumeBroadcast) realtimeService.resumeBroadcast();
  }
}

// ───────── Stratégie : hermes-dashboard (basic auth via .env, mdp unique) ─────
// Le dashboard natif de Hermes (`hermes dashboard`, provider `basic`) lit
// identifiant + mot de passe depuis des variables d'environnement, injectées via
// le fichier .env du stack. Pour changer le mot de passe : on réécrit la variable
// dans .env puis on RECRÉE le conteneur — un simple restart ne relit pas l'env,
// qui est figé à la création. Le dashboard relit alors le nouveau mot de passe au
// démarrage. Le mot de passe ne transite jamais par une ligne de commande shell
// (écriture directe dans le fichier).
async function hermesDashboardReset(
  recipe: any,
  appId: string,
  newPassword: string,
  mainPort?: number
): Promise<void> {
  const pwdVar = recipe.passwordVar || 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD';
  const appDir = path.join(APPS_DIR, appId);
  const envPath = path.join(appDir, '.env');

  // 1. Réécrit (ou ajoute) la variable de mot de passe dans .env, en préservant
  //    les autres lignes. Valeur écrite telle quelle (pas d'interpolation shell).
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envPath, 'utf8').split('\n');
  } catch (_) {
    lines = [];
  }
  const prefix = `${pwdVar}=`;
  let found = false;
  lines = lines.map((l: string) => {
    if (l.startsWith(prefix)) {
      found = true;
      return `${prefix}${newPassword}`;
    }
    return l;
  });
  if (!found) {
    if (lines.length && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, `${prefix}${newPassword}`);
    } else {
      lines.push(`${prefix}${newPassword}`);
    }
  }
  fs.writeFileSync(envPath, lines.join('\n'));

  // 2. Recrée le conteneur pour qu'il prenne la nouvelle valeur d'env (docker
  //    compose up -d détecte le changement et recrée le service).
  try {
    execSync('docker compose up -d', { stdio: 'pipe', timeout: 120000, cwd: appDir });
  } catch (e: any) {
    const msg = (e.stderr || e.message || '').toString().slice(0, 200);
    throw new Error(`hermes-dashboard: recréation du conteneur échouée: ${msg}`);
  }

  // 3. Vérification post-reset : le dashboard met quelques secondes à resservir →
  //    on tente le login avec le nouveau mot de passe (jusqu'à ~30s).
  const def = {
    username: (recipe.default && recipe.default.username) || recipe.accountLabel || 'admin',
    password: newPassword,
    login: (recipe.default && recipe.default.login) || {
      path: '/auth/password-login',
      port: mainPort,
      body: '{"provider":"basic","username":"{username}","password":"{password}"}',
      okCodes: [200],
    },
  };
  let ok = false;
  for (let i = 0; i < 15; i++) {
    try {
      ok = await loginVerify(def, mainPort);
    } catch (_) {
      ok = false;
    }
    if (ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ok) {
    throw new Error(VERIFY_FAIL_MSG);
  }
}

// ─────────────── Stratégie générique : container-exec ──────────────────────
// La logique de gestion des comptes vit DANS l'app : un script « fiche »
// (ex. ryvie-accounts.mjs / ryvie-accounts.py) embarqué avec l'app, écrit dans
// le langage de l'app et exécuté DANS son propre conteneur. Le core ne connaît
// ni le schéma ni le format de hash : il lance la fiche et lit son résultat.
// La fiche suit une convention de sous-commandes :
//   <runtime> <script> list    → stdout = JSON [{id,email,username,isAdmin}]
//   <runtime> <script> reset   → env RESET_ID/RESET_PWD ; stdout contient `expect` ("OK")
//   <runtime> <script> verify  → env RESET_ID/RESET_PWD ; stdout contient "OK" si le mdp matche
//
// SÉCURITÉ : la fiche ne s'exécute QUE dans un conteneur appartenant à l'app
// (préfixe `app-<appId>`), jamais dans le core ni avec le socket Docker. Une app
// peut déjà tout faire dans son propre conteneur → aucun privilège ajouté.

// Empêche une recette de viser le conteneur d'une AUTRE app ou un service système.
function assertContainerBelongsToApp(container: string, appId: string): void {
  const base = `app-${appId}`;
  if (!container || (container !== base && !container.startsWith(base + '-'))) {
    throw new Error(
      `container-exec: le conteneur « ${container} » n'appartient pas à l'app « ${appId} »`
    );
  }
}

// Construit l'argv [...préfixe, script, subcommand]. Le préfixe est soit
// `recipe.exec` (tableau, ex. ["rails","runner"]) soit `[recipe.runtime||'node']`
// (ex. "python3", "node"). Tous les tokens sont validés (pas d'espaces ni de
// métacaractères) — ils proviennent de la recette de l'app.
const CE_TOKEN_RE = /^[A-Za-z0-9_./-]+$/;
function containerExecArgv(recipe: any, sub: string): string[] {
  const script = recipe.script;
  if (!script) throw new Error('container-exec: `script` requis dans la recette');
  const prefix: string[] = Array.isArray(recipe.exec) && recipe.exec.length
    ? recipe.exec.map(String)
    : [recipe.runtime || 'node'];
  for (const tok of [...prefix, script]) {
    if (!CE_TOKEN_RE.test(tok)) {
      throw new Error(`container-exec: token de commande invalide: ${tok}`);
    }
  }
  return [...prefix, script, sub];
}

// Env statique déclaré par la recette (ex. DB_PATH) forwardé à la fiche.
function containerExecStaticEnv(recipe: any): string[] {
  const env = recipe.env || {};
  return Object.entries(env).map(([k, v]) => `${k}=${v == null ? '' : String(v)}`);
}

async function containerExecList(recipe: any, appId: string): Promise<Account[]> {
  assertContainerBelongsToApp(recipe.container, appId);
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    containerExecArgv(recipe, 'list'),
    { env: containerExecStaticEnv(recipe), workingDir: recipe.workingDir, user: recipe.user }
  );
  if (exitCode !== 0) {
    throw new Error(`container-exec list a échoué (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`);
  }
  return parseAccountsJson(stdout);
}

async function containerExecReset(
  recipe: any, appId: string, accountId: string, newPassword: string
): Promise<void> {
  assertContainerBelongsToApp(recipe.container, appId);
  const expect = (recipe.reset && recipe.reset.expect) || 'OK';
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    containerExecArgv(recipe, 'reset'),
    {
      env: [...containerExecStaticEnv(recipe), `RESET_ID=${accountId}`, `RESET_PWD=${newPassword}`],
      workingDir: recipe.workingDir,
      user: recipe.user,
    }
  );
  // exit≠0 → la fiche a planté ; stdout sans `expect` → reset non confirmé par la fiche.
  // (stderr peut contenir une trace, jamais le mot de passe — passé par env.)
  if (exitCode !== 0) {
    throw new Error(`container-exec reset a échoué (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`);
  }
  if (!stdout.includes(expect)) {
    throw new Error(VERIFY_FAIL_MSG);
  }

  // Certaines apps cachent leurs identifiants en mémoire (ex. Home Assistant) : le
  // nouveau mot de passe n'est écrit que dans le stockage et n'est pris en compte au
  // login qu'après un redémarrage. `resetRestarts: true` dans la recette demande de
  // recréer/relancer le conteneur. On SUSPEND le broadcast realtime pendant le restart
  // (sinon les événements Docker stop/start remontent au frontend → réaction parasite).
  if (recipe.resetRestarts) {
    const realtimeService = (global as any).realtimeService;
    try {
      if (realtimeService?.pauseBroadcast) realtimeService.pauseBroadcast();
      await docker.getContainer(recipe.container).restart({ t: 10 });
    } catch (e: any) {
      throw new Error(
        `mot de passe écrit mais redémarrage du conteneur échoué: ${e.message}. ` +
        `Redémarrez l'app manuellement pour appliquer le nouveau mot de passe.`
      );
    } finally {
      if (realtimeService?.resumeBroadcast) realtimeService.resumeBroadcast();
    }
  }
}

// Vérifie un mot de passe via la sous-commande `verify` de la fiche (utilisé pour
// le statut « compte par défaut inchangé ? » quand l'app n'a pas d'API de login).
async function containerExecVerify(
  recipe: any, appId: string, accountId: string, password: string
): Promise<boolean> {
  assertContainerBelongsToApp(recipe.container, appId);
  try {
    const { stdout } = await dockerExec(
      recipe.container,
      containerExecArgv(recipe, 'verify'),
      {
        env: [...containerExecStaticEnv(recipe), `RESET_ID=${accountId}`, `RESET_PWD=${password}`],
        workingDir: recipe.workingDir,
        user: recipe.user,
      }
    );
    return /\bOK\b/.test(stdout);
  } catch (_) {
    return false;
  }
}

// Crée (idempotent) le compte par défaut via la sous-commande `provision` de la
// fiche. Utilisé par provisionDefault pour les apps container-exec dont le compte
// par défaut n'est pas créé par leur install.sh (ex. docuseal). La fiche reçoit
// DEFAULT_EMAIL/DEFAULT_USER/DEFAULT_PWD et doit imprimer "DONE".
async function containerExecProvision(recipe: any, appId: string, def: any): Promise<void> {
  assertContainerBelongsToApp(recipe.container, appId);
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    containerExecArgv(recipe, 'provision'),
    {
      env: [
        ...containerExecStaticEnv(recipe),
        `DEFAULT_EMAIL=${def.email || ''}`,
        `DEFAULT_USER=${def.username || ''}`,
        `DEFAULT_PWD=${def.password || ''}`,
      ],
      workingDir: recipe.workingDir,
      user: recipe.user,
    }
  );
  if (exitCode !== 0 || !/\bDONE\b/.test(stdout)) {
    throw new Error(
      `container-exec provision échoué (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 200)}`
    );
  }
}

// ───────────────────────────── Helpers ────────────────────────────────────

function parseAccountsJson(stdout: string): Account[] {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`Sortie inattendue lors du listing des comptes`);
  }
  const arr = JSON.parse(trimmed.slice(start, end + 1));
  return arr.map((a: any) => ({
    id: String(a.id),
    email: a.email || undefined,
    username: a.username || undefined,
    isAdmin: !!a.isAdmin,
  }));
}

function minPasswordOk(pwd: string): boolean {
  return typeof pwd === 'string' && pwd.length >= 8;
}

// Liste les comptes selon la stratégie (sans la logique supported/reason).
async function listAccountsByRecipe(recipe: any, appId: string): Promise<Account[]> {
  switch (recipe.strategy) {
    case 'container-exec':
      return containerExecList(recipe, appId);
    case 'hermes-webui':
    case 'hermes-dashboard':
      // Auth par MOT DE PASSE unique (pas de multi-utilisateurs) → un seul « compte ».
      return [{ id: 'admin', username: recipe.accountLabel || 'admin', isAdmin: true }];
    default:
      return [];
  }
}

// ─────────────── Vérification d'un mot de passe (sans modifier) ─────────────
// Réutilisé par la détection « compte par défaut encore inchangé ? ».

async function verifyAccountPassword(recipe: any, account: Account, password: string, appId: string): Promise<boolean> {
  switch (recipe.strategy) {
    case 'container-exec':
      return containerExecVerify(recipe, appId, account.id, password);
    default:
      return false;
  }
}

// ─────────────────── Provisioning du compte par défaut ─────────────────────
// Idempotent : crée le compte `default.email` s'il n'existe pas encore, selon
// `default.provision` (installScript/shipped = déjà présent ; adapter = création).

// Appelle une API de l'app DEPUIS le backend, via son port publié sur l'hôte
// (manifest.mainPort) — aucune dépendance aux outils du conteneur (curl/sh).
// Renvoie le code HTTP. Ne logge jamais le corps (contient le mot de passe).
function buildBody(tpl: string, def: any): any {
  const filled = tpl
    .replace(/\{email\}/g, def.email || '')
    .replace(/\{username\}/g, def.username || '')
    .replace(/\{password\}/g, def.password || '');
  return JSON.parse(filled);
}

// Résultat d'un appel API : le code HTTP NE SUFFIT PAS. Au démarrage, l'app peut renvoyer
// du HTML (page d'erreur 404, éditeur 200, « too many requests » 429) tant que son API REST
// n'est pas montée — un code 200/4xx sur un corps HTML n'est donc pas un vrai résultat API.
interface ApiResult {
  status: number;
  isJson: boolean; // corps réellement JSON → l'API REST répond pour de vrai
  isHtml: boolean; // corps HTML → serveur web up mais route API pas (encore) montée
}

async function apiCall(spec: any, def: any, mainPort?: number): Promise<ApiResult> {
  if (!spec || !spec.path) throw new Error('spec API incomplète (path requis)');
  const port = spec.port || mainPort;
  if (!port) throw new Error('port de l\'app inconnu pour l\'appel API');
  const url = `http://127.0.0.1:${port}${spec.path}`;
  const res = await axios.request({
    url,
    method: spec.method || 'POST',
    headers: { 'Content-Type': 'application/json', ...(spec.headers || {}) },
    data: buildBody(spec.body || '{}', def),
    timeout: 10000,
    responseType: 'text',                 // corps brut → on décide JSON vs HTML nous-mêmes
    transformResponse: [(d: any) => d],   // ne pas laisser axios parser/transformer
    validateStatus: () => true,           // on lit le code nous-mêmes
  });
  const ctype = String((res.headers && res.headers['content-type']) || '').toLowerCase();
  const raw = typeof res.data === 'string' ? res.data : res.data == null ? '' : String(res.data);
  const head = raw.trim().slice(0, 64).toLowerCase();
  const isHtml = ctype.includes('text/html') || head.startsWith('<!doctype') || head.startsWith('<html');
  let isJson = ctype.includes('application/json');
  if (!isJson && !isHtml && (head.startsWith('{') || head.startsWith('['))) {
    try { JSON.parse(raw); isJson = true; } catch (_) { /* pas du JSON */ }
  }
  return { status: res.status, isJson, isHtml };
}

// signup peut être un objet (1 appel) ou un tableau (wizard multi-étapes, ex. jellyfin).
async function apiSignup(def: any, mainPort?: number): Promise<void> {
  const steps = Array.isArray(def.signup) ? def.signup : [def.signup];
  for (const step of steps) {
    const okCodes: number[] = Array.isArray(step?.okCodes) && step.okCodes.length
      ? step.okCodes : [200, 201, 204];
    const r = await apiCall(step, def, mainPort);
    // Corps HTML = route API pas encore montée (404/200/429 au boot) → PAS un vrai résultat
    // de création. On lève SANS httpStatus → apiSignupResilient retentera (au lieu de croire
    // à tort que c'est créé, ou d'abandonner sur un « 404 définitif » qui n'en est pas un).
    if (r.isHtml) {
      throw new Error(`signup ${step?.path} → HTML (API REST pas prête)`);
    }
    if (!okCodes.includes(r.status)) {
      const err: any = new Error(`signup ${step?.path} → HTTP ${r.status}`);
      err.httpStatus = r.status; // 4xx JSON réel → erreur cliente définitive (distinguée du « pas prêt »)
      throw err;
    }
  }
}

// Variante résiliente de apiSignup pour l'INSTALL : retente la création du compte par
// défaut tant que l'API de l'app n'est pas prête (connexion refusée, 5xx, réponse vide),
// jusqu'à PROVISION_READY_TIMEOUT_MS. Idempotent : re-vérifie l'existence du compte (via
// login) à chaque tour, donc s'arrête dès qu'une tentative précédente — ou l'app — l'a
// créé. N'insiste PAS sur une erreur client définitive (4xx hors 408/429 : payload ou mot
// de passe refusé → un retry n'y changerait rien).
async function apiSignupResilient(def: any, mainPort?: number): Promise<void> {
  const deadline = Date.now() + PROVISION_READY_TIMEOUT_MS;
  let lastErr: any = null;
  let warnedNotReady = false;
  for (;;) {
    // 1) Sonder l'état RÉEL via une vraie réponse JSON (loginProbe distingue 'notready' =
    //    HTML/refus de l'état du compte). Sans login déclaré, on suppose « à créer ».
    const state = def.login ? await loginProbe(def, mainPort) : 'absent';
    if (state === 'exists') return; // idempotent : compte déjà présent
    if (state === 'notready') {
      // API REST pas encore montée (corps HTML, connexion refusée, rate-limit 429…) → on attend.
      if (!warnedNotReady) {
        console.log('[appAccounts] API REST de l\'app pas encore prête, attente de sa disponibilité réelle...');
        warnedNotReady = true;
      }
    } else {
      // state === 'absent' : API prête ET compte réellement absent → on crée.
      try {
        await apiSignup(def, mainPort);
        // 2) Vérifier que la création a VRAIMENT abouti (jamais se fier à un seul code OK).
        if (!def.login) return;
        if ((await loginProbe(def, mainPort)) === 'exists') return;
        lastErr = new Error('signup a répondu OK mais le login ne passe pas (création non confirmée)');
      } catch (e: any) {
        lastErr = e;
        const code = e && e.httpStatus;
        const definitiveClientError =
          typeof code === 'number' && code >= 400 && code < 500 && code !== 408 && code !== 429;
        if (definitiveClientError) throw e; // 4xx JSON réel (payload/mot de passe) → inutile de retenter
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(PROVISION_RETRY_DELAY_MS);
  }
  throw lastErr || new Error('apiSignup: API de l\'app non prête après attente');
}

// Sonde de login TRI-ÉTAT, robuste au démarrage de l'app (générique, sans accès DB) :
//   'exists'   = réponse JSON de succès (okCodes) → le compte existe et s'authentifie
//   'absent'   = réponse JSON d'échec (ex. 401 wrong credentials) → API prête, compte à créer
//   'notready' = HTML / corps vide / connexion refusée → API REST PAS encore montée
// Crucial : au boot, n8n (et autres) renvoient des réponses HTTP en text/html (404 route
// non montée, 429 rate-limit) AVANT que /rest/* réponde vraiment ; se fier au seul code HTTP
// produit des faux positifs (« login OK » sur du HTML → on croit le compte créé alors que non).
async function loginProbe(def: any, mainPort?: number): Promise<'exists' | 'absent' | 'notready'> {
  const s = def.login || {};
  if (!s.path) return 'notready';
  const okCodes: number[] = Array.isArray(s.okCodes) && s.okCodes.length ? s.okCodes : [200];
  try {
    const r = await apiCall(s, def, mainPort);
    if (r.isHtml) return 'notready';                 // page HTML → API pas prête
    if (okCodes.includes(r.status)) return 'exists'; // vrai succès → compte présent
    if (r.isJson) return 'absent';                   // vrai échec JSON (401…) → API prête, compte absent
    return 'notready';                               // ni HTML ni JSON (vide) → prudence
  } catch (_) {
    return 'notready';                               // connexion refusée / timeout
  }
}

// Compat : « le compte par défaut s'authentifie-t-il ? » — true UNIQUEMENT sur vrai succès JSON.
async function loginVerify(def: any, mainPort?: number): Promise<boolean> {
  return (await loginProbe(def, mainPort)) === 'exists';
}

// Transforme le compte embarqué d'une app bcrypt-sqlite (ex. mealie
// changeme@example.com) en compte par défaut uniforme Ryvie : met à jour
// email + username + mot de passe (et déverrouille). No-op si introuvable.
async function bcryptSqliteUpdateAccount(recipe: any, def: any): Promise<void> {
  const cols = recipe.columns || {};
  const emailC = cols.email || 'email';
  const userC = cols.username || 'username';
  const pwdC = cols.password || 'password';
  const table = recipe.table || 'users';
  const hash = await bcrypt.hash(def.password, BCRYPT_ROUNDS);

  // Colonnes de déverrouillage éventuelles (clearOnReset)
  const clear = recipe.clearOnReset || {};
  let clearSql = '';
  const clearPy: string[] = [];
  for (const [col, val] of Object.entries(clear)) {
    clearSql += `, "${col}"=?`;
    clearPy.push(val === null ? 'None' : JSON.stringify(val));
  }
  const clearArgs = clearPy.length ? `,${clearPy.join(',')}` : '';

  const py =
    'import os,sqlite3\n' +
    'c=sqlite3.connect(os.environ["DB_PATH"])\n' +
    `cur=c.execute('UPDATE "${table}" SET "${emailC}"=?, "${userC}"=?, "${pwdC}"=?${clearSql} ` +
    `WHERE "${emailC}"=?',` +
    `(os.environ["NEW_EMAIL"],os.environ["NEW_USER"],os.environ["NEW_HASH"]${clearArgs},os.environ["SHIPPED_EMAIL"]))\n` +
    'c.commit()\n' +
    'print("ROWS="+str(cur.rowcount))';
  const { stdout, stderr, exitCode } = await dockerExec(recipe.container, ['python3', '-c', py], {
    env: [
      `DB_PATH=${recipe.dbPath}`,
      `NEW_EMAIL=${def.email}`,
      `NEW_USER=${def.username || ''}`,
      `NEW_HASH=${hash}`,
      `SHIPPED_EMAIL=${def.shippedEmail || ''}`,
    ],
  });
  if (exitCode !== 0 || !stdout.includes('ROWS=')) {
    throw new Error(`sql-update du compte par défaut échoué: ${stderr.trim().slice(0, 200)}`);
  }
}

async function provisionDefault(appId: string, opts?: { apiOnly?: boolean }): Promise<'created' | 'exists' | void> {
  const info = await getRecipe(appId);
  if (info === null || info.sso) return;
  const recipe = info.recipe;
  const def = recipe && recipe.default;
  if (!def || !def.email) return;

  const mode = def.provision || 'shipped';
  if (mode === 'installScript' || mode === 'shipped') return; // compte déjà présent
  // Auto-réparation (poller temps-réel) : ne traiter QUE le provisioning par API (le seul
  // sensible au boot de l'API REST). Évite tout docker exec inutile (adapter/sql-update)
  // quand le heal balaie toutes les apps `running`.
  if (opts && opts.apiOnly && mode !== 'api') return;

  // Idempotent : ne (re)crée que si le compte par défaut est absent.
  // Vérif d'existence : par login (apps sans outils DB) sinon par listing DB.
  let exists = false;
  if (def.login) {
    try { exists = await loginVerify(def, info.mainPort); } catch (_) { /* pas prêt */ }
  } else {
    try {
      const accounts = await listAccountsByRecipe(recipe, appId);
      exists = accounts.some(
        (a) =>
          (a.email || '').toLowerCase() === def.email.toLowerCase() ||
          (!!def.username && (a.username || '').toLowerCase() === String(def.username).toLowerCase())
      );
    } catch (_) { /* on tente quand même la création */ }
  }
  if (exists) return 'exists';

  console.log(`[appAccounts] provisionDefault(${appId}): compte par défaut absent → création (mode=${mode})...`);

  if (mode === 'api') {
    await apiSignupResilient(def, info.mainPort);
    console.log(`[appAccounts] provisionDefault(${appId}): compte par défaut créé et vérifié ✅`);
    return 'created';
  }
  if (mode === 'sql-update') {
    return bcryptSqliteUpdateAccount(recipe, def);
  }
  if (mode === 'adapter') {
    switch (recipe.strategy) {
      case 'container-exec':
        return containerExecProvision(recipe, appId, def);
      default:
        console.warn(
          `[appAccounts] provisionDefault: création non implémentée pour la stratégie ${recipe.strategy} (${appId})`
        );
    }
  }
}

// ─────────────── Statut du compte par défaut (affichage UI) ─────────────────

export interface DefaultStatus {
  hasDefault: boolean;
  changed: boolean;
  email?: string;
  username?: string;
  password?: string;
}

async function getDefaultStatus(appId: string): Promise<DefaultStatus> {
  const info = await getRecipe(appId);
  if (info === null) {
    const err: any = new Error('App introuvable');
    err.status = 404;
    throw err;
  }
  if (info.sso) {
    const err: any = new Error('App SSO : comptes gérés par Keycloak');
    err.status = 400;
    throw err;
  }
  const recipe = info.recipe;
  const def = recipe && recipe.default;
  // Apps « mot de passe seul » (ex. Hermes WebUI) : pas d'email/username mais un
  // mot de passe par défaut + un login de vérification → on accepte aussi ce cas.
  if (!def || (!def.email && !def.username && !def.password)) return { hasDefault: false, changed: false };

  // Détection par login (apps sans outils DB) : on tente une authentification
  // avec les identifiants par défaut ; succès = inchangé, échec = changé.
  if (def.login) {
    let ok = false;
    try { ok = await loginVerify(def, info.mainPort); } catch (_) { ok = false; }
    if (!ok) return { hasDefault: true, changed: true };
    return { hasDefault: true, changed: false, email: def.email, username: def.username, password: def.password };
  }

  // Apps « mot de passe seul » (pas d'email ni username, ex. OpenClaw) : le compte
  // unique n'a rien à matcher par email/username → on vérifie directement le mot de
  // passe par défaut via la stratégie (fiche `verify`) sur le premier compte listé.
  if (!def.email && !def.username && def.password) {
    let ok = false;
    try {
      const accts = await listAccountsByRecipe(recipe, appId);
      if (accts[0]) ok = await verifyAccountPassword(recipe, accts[0], def.password, appId);
    } catch (_) { ok = false; }
    if (!ok) return { hasDefault: true, changed: true };
    return { hasDefault: true, changed: false, password: def.password };
  }

  let accounts: Account[] = [];
  try {
    accounts = await listAccountsByRecipe(recipe, appId);
  } catch (_) {
    // App pas prête / erreur de lecture → on n'affiche rien (prudence).
    return { hasDefault: true, changed: true };
  }

  const acc =
    accounts.find((a) => (a.email || '').toLowerCase() === def.email.toLowerCase()) ||
    (def.username
      ? accounts.find((a) => (a.username || '').toLowerCase() === String(def.username).toLowerCase())
      : undefined);

  // Compte par défaut introuvable (renommé/supprimé) → considéré « changé ».
  if (!acc) return { hasDefault: true, changed: true };

  let stillDefault = false;
  try {
    stillDefault = await verifyAccountPassword(recipe, acc, def.password, appId);
  } catch (_) {
    stillDefault = false;
  }
  if (!stillDefault) return { hasDefault: true, changed: true };

  // Toujours par défaut → on renvoie les identifiants à afficher.
  return {
    hasDefault: true,
    changed: false,
    email: def.email,
    username: def.username,
    password: def.password,
  };
}

// ───────────────────────────── API publique ───────────────────────────────

/**
 * Liste les comptes d'une app. Lève une erreur typée si app SSO / introuvable.
 */
async function listAccounts(appId: string): Promise<ListResult> {
  const info = await getRecipe(appId);
  if (info === null) {
    const err: any = new Error('App introuvable');
    err.status = 404;
    throw err;
  }
  if (info.sso) {
    const err: any = new Error('App SSO : comptes gérés par Keycloak');
    err.status = 400;
    throw err;
  }
  const recipe = info.recipe;
  if (!recipe || !recipe.strategy) {
    return { supported: false, reason: 'Gestion des comptes non disponible pour cette app.', accounts: [] };
  }

  switch (recipe.strategy) {
    case 'container-exec':
    case 'hermes-webui':
    case 'hermes-dashboard':
      // restartsOnReset : prévient l'UI qu'une réinitialisation redémarre l'app
      // (ex. Hermes, dont le hash est caché en mémoire). Déclaré dans le manifeste.
      return { supported: true, accounts: await listAccountsByRecipe(recipe, appId), restartsOnReset: !!recipe.resetRestarts };
    case 'unsupported':
      return { supported: false, reason: recipe.reason || 'Réinitialisation non supportée.', accounts: [] };
    default: {
      const err: any = new Error(`Stratégie inconnue: ${recipe.strategy}`);
      err.status = 400;
      throw err;
    }
  }
}

/**
 * Réinitialise le mot de passe d'un compte d'une app.
 */
async function resetPassword(appId: string, accountId: string, newPassword: string): Promise<void> {
  if (!minPasswordOk(newPassword)) {
    const err: any = new Error('Mot de passe trop court (8 caractères minimum)');
    err.status = 400;
    throw err;
  }
  const info = await getRecipe(appId);
  if (info === null) {
    const err: any = new Error('App introuvable');
    err.status = 404;
    throw err;
  }
  if (info.sso) {
    const err: any = new Error('App SSO : comptes gérés par Keycloak');
    err.status = 400;
    throw err;
  }
  const recipe = info.recipe;
  if (!recipe || !recipe.strategy || recipe.strategy === 'unsupported') {
    const err: any = new Error(
      (recipe && recipe.reason) || 'Réinitialisation non supportée pour cette app.'
    );
    err.status = 400;
    throw err;
  }

  switch (recipe.strategy) {
    case 'container-exec':
      return containerExecReset(recipe, appId, accountId, newPassword);
    case 'hermes-webui':
      return hermesWebuiReset(recipe, accountId, newPassword);
    case 'hermes-dashboard':
      return hermesDashboardReset(recipe, appId, newPassword, info.mainPort);
    default: {
      const err: any = new Error(`Stratégie inconnue: ${recipe.strategy}`);
      err.status = 400;
      throw err;
    }
  }
}

/**
 * Réinitialise l'ACCÈS d'une app via sa commande CLI native (ex. n8n
 * `user-management:reset`) — pour les apps sans stratégie de reset par compte.
 * Non destructif pour les données (workflows, etc.) : remet seulement le compte
 * propriétaire à zéro. Redémarre l'app si la recette l'exige.
 */
async function resetOwner(appId: string): Promise<{ success: boolean; message: string }> {
  const info = await getRecipe(appId);
  if (info === null) {
    const err: any = new Error('App introuvable');
    err.status = 404;
    throw err;
  }
  if (info.sso) {
    const err: any = new Error('App SSO : comptes gérés par Keycloak');
    err.status = 400;
    throw err;
  }
  const orec = info.recipe && info.recipe.ownerReset;
  if (!orec || !orec.container || !Array.isArray(orec.cmd) || !orec.cmd.length) {
    const err: any = new Error("Réinitialisation d'accès non disponible pour cette app.");
    err.status = 400;
    throw err;
  }

  const { stderr, exitCode } = await dockerExec(orec.container, orec.cmd);
  if (exitCode !== 0) {
    throw new Error(`Réinitialisation d'accès échouée (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`);
  }

  // Certaines apps (n8n) doivent redémarrer pour reprendre l'écran de setup.
  if (orec.restart) {
    try {
      await appManager.restartApp(appId);
    } catch (e: any) {
      console.warn(`[appAccounts] redémarrage après resetOwner ${appId}:`, e.message);
    }
  }

  return {
    success: true,
    message: orec.message || "Accès réinitialisé. Rouvrez l'app pour reconfigurer le compte.",
  };
}

module.exports = { dockerExec, listAccounts, resetPassword, provisionDefault, getDefaultStatus, resetOwner };
export {};
