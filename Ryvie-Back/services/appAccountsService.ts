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
// être prête (connexion refusée, 5xx, réponse vide) au moment où l'on crée le compte par
// défaut. On retente jusqu'à PROVISION_READY_TIMEOUT_MS avant d'abandonner.
const PROVISION_READY_TIMEOUT_MS = 60000;
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

// ───────────────────────── Stratégie : rails-devise (docuseal) ─────────────

const RAILS_LIST_RUBY =
  'require "json"; ' +
  'puts User.all.map { |u| { id: u.id.to_s, email: u.email, ' +
  'isAdmin: (u.respond_to?(:admin?) ? !!u.admin? : (u.respond_to?(:role) ? u.role.to_s == "admin" : false)) } }.to_json';

const RAILS_RESET_RUBY =
  'u = User.find(ENV["RESET_ID"]); ' +
  'u.password = ENV["RESET_PWD"]; ' +
  'u.password_confirmation = ENV["RESET_PWD"] if u.respond_to?(:password_confirmation=); ' +
  'u.save!; ' +
  // Vérification post-reset : le nouveau mot de passe authentifie-t-il réellement ?
  'puts "VERIFY=" + u.reload.valid_password?(ENV["RESET_PWD"]).to_s';

async function railsList(recipe: any): Promise<Account[]> {
  const workingDir = recipe.workingDir || '/app';
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    ['rails', 'runner', RAILS_LIST_RUBY],
    { workingDir }
  );
  if (exitCode !== 0) {
    throw new Error(`rails list a échoué (exit ${exitCode}): ${stderr.trim()}`);
  }
  return parseAccountsJson(stdout);
}

async function railsReset(
  recipe: any,
  accountId: string,
  newPassword: string
): Promise<void> {
  const workingDir = recipe.workingDir || '/app';
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    ['rails', 'runner', RAILS_RESET_RUBY],
    { workingDir, env: [`RESET_ID=${accountId}`, `RESET_PWD=${newPassword}`] }
  );
  if (exitCode !== 0) {
    throw new Error(`rails reset a échoué (exit ${exitCode}): ${stderr.trim()}`);
  }
  if (!/VERIFY=true/.test(stdout)) {
    throw new Error(VERIFY_FAIL_MSG);
  }
}

// ──────────────────── Stratégie : bcrypt-sqlite (mealie) ───────────────────
// Pas de binaire sqlite3 dans certaines images (ex. mealie) : on utilise
// python3 (présent dans les apps Python) avec des requêtes paramétrées.

function pyListScript(recipe: any): string {
  const cols = recipe.columns || {};
  const idC = cols.id || 'id';
  const emailC = cols.email || 'email';
  const userC = cols.username || 'username';
  const adminC = cols.admin || null;
  const table = recipe.table || 'users';
  const adminSel = adminC ? `, "${adminC}"` : '';
  return (
    'import os,sqlite3,json\n' +
    `c=sqlite3.connect(os.environ["DB_PATH"])\n` +
    `rows=c.execute('SELECT "${idC}","${emailC}","${userC}"${adminSel} FROM "${table}"').fetchall()\n` +
    'out=[]\n' +
    'for r in rows:\n' +
    '    out.append({"id":str(r[0]),"email":r[1],"username":r[2],"isAdmin":bool(r[3]) if len(r)>3 else False})\n' +
    'print(json.dumps(out))'
  );
}

function pyResetScript(recipe: any): string {
  const cols = recipe.columns || {};
  const idC = cols.id || 'id';
  const pwdC = cols.password || 'password';
  const table = recipe.table || 'users';
  // clearOnReset : colonnes à remettre à zéro (ex. déverrouillage mealie)
  const clear = recipe.clearOnReset || {};
  let clearSql = '';
  const clearVals: string[] = [];
  for (const [col, val] of Object.entries(clear)) {
    clearSql += `, "${col}"=?`;
    clearVals.push(val === null ? 'None' : JSON.stringify(val));
  }
  const clearPy = clearVals.length
    ? `,${clearVals.map((v) => (v === 'None' ? 'None' : v)).join(',')}`
    : '';
  return (
    'import os,sqlite3\n' +
    `c=sqlite3.connect(os.environ["DB_PATH"])\n` +
    `c.execute('UPDATE "${table}" SET "${pwdC}"=?${clearSql} WHERE "${idC}"=?',` +
    `(os.environ["NEW_HASH"]${clearPy},os.environ["ACCOUNT_ID"]))\n` +
    'c.commit()\n' +
    // Relit le hash réellement stocké pour vérification post-reset côté backend
    `r=c.execute('SELECT "${pwdC}" FROM "${table}" WHERE "${idC}"=?',(os.environ["ACCOUNT_ID"],)).fetchone()\n` +
    'print("STORED="+(r[0] if r and r[0] else ""))'
  );
}

async function bcryptSqliteList(recipe: any): Promise<Account[]> {
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    ['python3', '-c', pyListScript(recipe)],
    { env: [`DB_PATH=${recipe.dbPath}`] }
  );
  if (exitCode !== 0) {
    throw new Error(`sqlite list a échoué (exit ${exitCode}): ${stderr.trim()}`);
  }
  return parseAccountsJson(stdout);
}

async function bcryptSqliteReset(
  recipe: any,
  accountId: string,
  newPassword: string
): Promise<void> {
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const { stdout, stderr, exitCode } = await dockerExec(
    recipe.container,
    ['python3', '-c', pyResetScript(recipe)],
    {
      env: [
        `DB_PATH=${recipe.dbPath}`,
        `ACCOUNT_ID=${accountId}`,
        `NEW_HASH=${hash}`,
      ],
    }
  );
  if (exitCode !== 0 || !stdout.includes('STORED=')) {
    throw new Error(`sqlite reset a échoué (exit ${exitCode}): ${stderr.trim()}`);
  }
  // Vérification post-reset : le hash stocké correspond-il au mot de passe ?
  const stored = (stdout.split('STORED=')[1] || '').trim();
  const ok = !!stored && (await bcrypt.compare(newPassword, stored));
  if (!ok) {
    throw new Error(VERIFY_FAIL_MSG);
  }
}

// ───────────────────── Stratégie : affine-argon2 (affine) ──────────────────
// Liste via lecture postgres (read-only). Reset : AFFiNE hache les mots de
// passe en argon2id SANS secret/pepper (CryptoHelper.verifyPassword = argon2.verify
// sans clé). On génère donc le hash DANS le conteneur affine (sa propre lib
// @node-rs/argon2, paramètres identiques) puis on l'écrit directement en base.
// Aucun identifiant admin requis.

async function affineList(recipe: any): Promise<Account[]> {
  const dbUser = (recipe.db && recipe.db.user) || 'affine';
  const dbName = (recipe.db && recipe.db.name) || 'affine';
  const { stdout, stderr, exitCode } = await dockerExec(recipe.dbContainer, [
    'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-F', '|',
    '-c', 'SELECT id, email, name FROM users',
  ]);
  if (exitCode !== 0) {
    throw new Error(`affine list a échoué (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, email, name] = line.split('|');
      return { id, email, username: name } as Account;
    });
}

// Hash argon2 valide : pas de quote simple ni d'antislash (alphabet $ , = + / b64).
const ARGON2_HASH_RE = /^\$argon2(id|i|d)\$[^']+$/;
const AFFINE_UUID_RE = /^[A-Za-z0-9-]+$/;

async function affineReset(
  recipe: any,
  accountId: string,
  newPassword: string
): Promise<void> {
  const appContainer = recipe.appContainer || 'app-affine-web';
  const dbUser = (recipe.db && recipe.db.user) || 'affine';
  const dbName = (recipe.db && recipe.db.name) || 'affine';

  if (!AFFINE_UUID_RE.test(accountId)) {
    throw new Error('Identifiant de compte AFFiNE invalide');
  }

  // 1. Génère le hash argon2 avec la lib d'AFFiNE (mot de passe passé par env,
  //    jamais sur la ligne de commande). Sortie = le hash encodé, rien d'autre.
  const hashScript =
    'const a=require("@node-rs/argon2");' +
    'process.stdout.write(a.hashSync(process.env.RPWD));';
  const hres = await dockerExec(appContainer, ['node', '-e', hashScript], {
    env: [`RPWD=${newPassword}`],
  });
  const hash = hres.stdout.trim();
  if (hres.exitCode !== 0 || !ARGON2_HASH_RE.test(hash)) {
    throw new Error(
      `affine: génération du hash argon2 échouée (exit ${hres.exitCode})`
    );
  }

  // 2. Écrit le hash en base. Pas de shell (argv direct) → le `$` du hash n'est
  //    pas interprété. Le hash et l'UUID ne contiennent jamais de quote simple,
  //    donc le quoting SQL est sûr (et le mot de passe en clair n'apparaît pas).
  const sql = `UPDATE users SET password='${hash}' WHERE id='${accountId}'`;
  const ures = await dockerExec(recipe.dbContainer, [
    'psql', '-U', dbUser, '-d', dbName, '-c', sql,
  ]);
  if (ures.exitCode !== 0 || !/UPDATE 1/.test(ures.stdout)) {
    throw new Error(
      `affine reset a échoué (exit ${ures.exitCode}): ${(ures.stderr || ures.stdout).trim().slice(0, 200)}`
    );
  }

  // 3. Vérification post-reset : relit le hash stocké et le vérifie avec la
  //    lib argon2 d'AFFiNE (la même que celle utilisée au login).
  const rres = await dockerExec(recipe.dbContainer, [
    'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-c',
    `SELECT password FROM users WHERE id='${accountId}'`,
  ]);
  const storedHash = rres.stdout.trim();
  if (rres.exitCode !== 0 || !ARGON2_HASH_RE.test(storedHash)) {
    throw new Error(VERIFY_FAIL_MSG);
  }
  const vScript =
    'const a=require("@node-rs/argon2");' +
    'process.stdout.write(a.verifySync(process.env.RHASH, process.env.RPWD) ? "OK" : "NO");';
  const vres = await dockerExec(appContainer, ['node', '-e', vScript], {
    env: [`RHASH=${storedHash}`, `RPWD=${newPassword}`],
  });
  if (vres.exitCode !== 0 || !/OK/.test(vres.stdout)) {
    throw new Error(VERIFY_FAIL_MSG);
  }
}

// ───────────────── Stratégie : bcrypt-postgres (Twenty CRM) ─────────────────
// Comptes stockés dans Postgres avec un hash bcrypt (ex. Twenty : table
// core."user", colonne "passwordHash"). On liste/lit/écrit via psql DANS le
// conteneur de la base ; le hash bcrypt est généré côté backend (comme
// bcrypt-sqlite). Le mot de passe ne transite jamais par la ligne de commande.
// Le hash bcrypt et l'UUID écrits en base ne contiennent pas de quote simple
// (alphabet $ . / b64 / tirets) → interpolation SQL sûre (même garantie qu'affine).

const PG_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;            // schéma / table / colonne
const PG_ACCOUNT_ID_RE = /^[A-Za-z0-9-]+$/;                // identifiant de compte (UUID)
const BCRYPT_HASH_RE = /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/;

// Renvoie `"schema"."table"` (idents validés) — `user` est un mot réservé → quoté.
function pgTableRef(recipe: any): string {
  const schema = recipe.schema || 'public';
  const table = recipe.table || 'users';
  if (!PG_IDENT_RE.test(schema) || !PG_IDENT_RE.test(table)) {
    throw new Error('bcrypt-postgres: schéma ou table invalide');
  }
  return `"${schema}"."${table}"`;
}

// Noms de colonnes (validés). `password` = colonne du hash. Libellé du compte :
// `username` si fourni, sinon concaténation firstName/lastName si fournis.
function pgColumns(recipe: any): { id: string; email: string; password: string; first: string | null; last: string | null; username: string | null } {
  const cols = recipe.columns || {};
  const out = {
    id: cols.id || 'id',
    email: cols.email || 'email',
    password: cols.password || 'password_hash',
    first: cols.firstName || null,
    last: cols.lastName || null,
    username: cols.username || null,
  };
  for (const v of [out.id, out.email, out.password, out.first, out.last, out.username]) {
    if (v && !PG_IDENT_RE.test(v)) throw new Error('bcrypt-postgres: nom de colonne invalide');
  }
  return out;
}

// argv psql en mode lecture (tuples seuls, séparateur `|`).
function pgSelectArgv(recipe: any, sql: string): string[] {
  const dbUser = (recipe.db && recipe.db.user) || 'postgres';
  const dbName = (recipe.db && recipe.db.name) || 'postgres';
  return ['psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-F', '|', '-c', sql];
}

// argv psql en mode écriture (on lit le tag de commande « UPDATE 1 » sur stdout).
function pgExecArgv(recipe: any, sql: string): string[] {
  const dbUser = (recipe.db && recipe.db.user) || 'postgres';
  const dbName = (recipe.db && recipe.db.name) || 'postgres';
  return ['psql', '-U', dbUser, '-d', dbName, '-c', sql];
}

async function bcryptPostgresList(recipe: any): Promise<Account[]> {
  const c = pgColumns(recipe);
  const nameParts: string[] = [];
  if (c.first) nameParts.push(`coalesce("${c.first}",'')`);
  if (c.last) nameParts.push(`coalesce("${c.last}",'')`);
  const nameSel = c.username
    ? `"${c.username}"`
    : nameParts.length
      ? `trim(${nameParts.join(" || ' ' || ")})`
      : `''`;
  const sql = `SELECT "${c.id}", "${c.email}", ${nameSel} FROM ${pgTableRef(recipe)} ORDER BY "${c.email}"`;
  const { stdout, stderr, exitCode } = await dockerExec(recipe.dbContainer, pgSelectArgv(recipe, sql));
  if (exitCode !== 0) {
    throw new Error(`bcrypt-postgres list a échoué (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, email, name] = line.split('|');
      return { id, email: email || undefined, username: (name || '').trim() || undefined } as Account;
    });
}

async function bcryptPostgresReadHash(recipe: any, id: string): Promise<string> {
  if (!PG_ACCOUNT_ID_RE.test(id)) return '';
  const c = pgColumns(recipe);
  const sql = `SELECT "${c.password}" FROM ${pgTableRef(recipe)} WHERE "${c.id}"='${id}'`;
  const { stdout } = await dockerExec(recipe.dbContainer, pgSelectArgv(recipe, sql));
  return stdout.trim();
}

async function bcryptPostgresReset(recipe: any, accountId: string, newPassword: string): Promise<void> {
  if (!PG_ACCOUNT_ID_RE.test(accountId)) {
    throw new Error('bcrypt-postgres: identifiant de compte invalide');
  }
  const c = pgColumns(recipe);
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  if (!BCRYPT_HASH_RE.test(hash)) {
    throw new Error('bcrypt-postgres: hash bcrypt généré invalide');
  }
  const sql = `UPDATE ${pgTableRef(recipe)} SET "${c.password}"='${hash}' WHERE "${c.id}"='${accountId}'`;
  const { stdout, stderr, exitCode } = await dockerExec(recipe.dbContainer, pgExecArgv(recipe, sql));
  if (exitCode !== 0 || !/UPDATE 1/.test(stdout)) {
    throw new Error(`bcrypt-postgres reset a échoué (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 200)}`);
  }
  // Vérification post-reset : relit le hash stocké et le compare au mot de passe.
  const stored = await bcryptPostgresReadHash(recipe, accountId);
  const ok = !!stored && (await bcrypt.compare(newPassword, stored));
  if (!ok) {
    throw new Error(VERIFY_FAIL_MSG);
  }
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
async function listAccountsByRecipe(recipe: any): Promise<Account[]> {
  switch (recipe.strategy) {
    case 'rails-devise':
      return railsList(recipe);
    case 'bcrypt-sqlite':
      return bcryptSqliteList(recipe);
    case 'affine-argon2':
      return affineList(recipe);
    case 'bcrypt-postgres':
      return bcryptPostgresList(recipe);
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

async function bcryptSqliteReadHash(recipe: any, id: string): Promise<string> {
  const cols = recipe.columns || {};
  const idC = cols.id || 'id';
  const pwdC = cols.password || 'password';
  const table = recipe.table || 'users';
  const py =
    'import os,sqlite3\n' +
    'c=sqlite3.connect(os.environ["DB_PATH"])\n' +
    `r=c.execute('SELECT "${pwdC}" FROM "${table}" WHERE "${idC}"=?',(os.environ["ID"],)).fetchone()\n` +
    'print("HASH="+(r[0] if r and r[0] else ""))';
  const { stdout } = await dockerExec(recipe.container, ['python3', '-c', py], {
    env: [`DB_PATH=${recipe.dbPath}`, `ID=${id}`],
  });
  return (stdout.split('HASH=')[1] || '').trim();
}

async function affineReadHash(recipe: any, id: string): Promise<string> {
  const dbUser = (recipe.db && recipe.db.user) || 'affine';
  const dbName = (recipe.db && recipe.db.name) || 'affine';
  if (!AFFINE_UUID_RE.test(id)) return '';
  const { stdout } = await dockerExec(recipe.dbContainer, [
    'psql', '-U', dbUser, '-d', dbName, '-t', '-A', '-c',
    `SELECT password FROM users WHERE id='${id}'`,
  ]);
  return stdout.trim();
}

async function verifyAccountPassword(recipe: any, account: Account, password: string): Promise<boolean> {
  switch (recipe.strategy) {
    case 'rails-devise': {
      const ruby =
        'u = (ENV["VID"].empty? ? nil : User.find_by(id: ENV["VID"])) || User.find_by(email: ENV["VEMAIL"]); ' +
        'puts "V=" + (u ? u.valid_password?(ENV["VPWD"]).to_s : "false")';
      const { stdout } = await dockerExec(recipe.container, ['rails', 'runner', ruby], {
        workingDir: recipe.workingDir || '/app',
        env: [`VID=${account.id || ''}`, `VEMAIL=${account.email || ''}`, `VPWD=${password}`],
      });
      return /V=true/.test(stdout);
    }
    case 'bcrypt-sqlite': {
      const hash = await bcryptSqliteReadHash(recipe, account.id);
      return !!hash && (await bcrypt.compare(password, hash));
    }
    case 'bcrypt-postgres': {
      const hash = await bcryptPostgresReadHash(recipe, account.id);
      return !!hash && (await bcrypt.compare(password, hash));
    }
    case 'affine-argon2': {
      const hash = await affineReadHash(recipe, account.id);
      if (!hash || !ARGON2_HASH_RE.test(hash)) return false;
      const vScript =
        'const a=require("@node-rs/argon2");' +
        'process.stdout.write(a.verifySync(process.env.RHASH, process.env.RPWD) ? "OK" : "NO");';
      const { stdout } = await dockerExec(recipe.appContainer || 'app-affine-web', ['node', '-e', vScript], {
        env: [`RHASH=${hash}`, `RPWD=${password}`],
      });
      return /OK/.test(stdout);
    }
    default:
      return false;
  }
}

// ─────────────────── Provisioning du compte par défaut ─────────────────────
// Idempotent : crée le compte `default.email` s'il n'existe pas encore, selon
// `default.provision` (installScript/shipped = déjà présent ; adapter = création).

async function railsCreateDefault(recipe: any, def: any): Promise<void> {
  const ruby =
    'email=ENV["EMAIL"]; pwd=ENV["PWD"]; uname=ENV["UNAME"]; ' +
    'if User.find_by(email: email).nil?; ' +
    '  base=User.first; ' +
    '  acc=base ? base.account : (defined?(Account) ? Account.create!(name: "Ryvie") : nil); ' +
    '  u=User.new(email: email); ' +
    '  u.first_name=uname if u.respond_to?(:first_name=); ' +
    '  u.last_name="Ryvie" if u.respond_to?(:last_name=); ' +
    '  u.role=(base ? base.role : "admin") if u.respond_to?(:role=); ' +
    '  (u.account=acc if acc) if u.respond_to?(:account=); ' +
    '  u.password=pwd; u.password_confirmation=pwd if u.respond_to?(:password_confirmation=); ' +
    '  u.save!; ' +
    'end; puts "DONE"';
  const { stdout, stderr, exitCode } = await dockerExec(recipe.container, ['rails', 'runner', ruby], {
    workingDir: recipe.workingDir || '/app',
    env: [`EMAIL=${def.email}`, `PWD=${def.password}`, `UNAME=${def.username || 'ryvie'}`],
  });
  if (exitCode !== 0 || !/DONE/.test(stdout)) {
    throw new Error(`rails create default a échoué: ${(stderr || stdout).trim().slice(0, 200)}`);
  }
}

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

async function apiCall(spec: any, def: any, mainPort?: number): Promise<number> {
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
    validateStatus: () => true, // on lit le code nous-mêmes
  });
  return res.status;
}

// signup peut être un objet (1 appel) ou un tableau (wizard multi-étapes, ex. jellyfin).
async function apiSignup(def: any, mainPort?: number): Promise<void> {
  const steps = Array.isArray(def.signup) ? def.signup : [def.signup];
  for (const step of steps) {
    const okCodes: number[] = Array.isArray(step?.okCodes) && step.okCodes.length
      ? step.okCodes : [200, 201, 204];
    const code = await apiCall(step, def, mainPort);
    if (!okCodes.includes(code)) {
      const err: any = new Error(`signup ${step?.path} → HTTP ${code}`);
      err.httpStatus = code; // permet à apiSignupResilient de distinguer 4xx définitif vs « pas prêt »
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
  for (;;) {
    // Idempotence + sonde de disponibilité : si le login passe, le compte existe → fini.
    if (def.login) {
      try { if (await loginVerify(def, mainPort)) return; } catch (_) { /* pas prêt */ }
    }
    try {
      await apiSignup(def, mainPort);
      return;
    } catch (e: any) {
      lastErr = e;
      const code = e && e.httpStatus;
      const definitiveClientError =
        typeof code === 'number' && code >= 400 && code < 500 && code !== 408 && code !== 429;
      if (definitiveClientError) throw e; // inutile de retenter
    }
    if (Date.now() >= deadline) break;
    await sleep(PROVISION_RETRY_DELAY_MS);
  }
  throw lastErr || new Error('apiSignup: API de l\'app non prête après attente');
}

// Vérifie « le compte par défaut s'authentifie-t-il encore ? » via une tentative
// de login sur l'API de l'app — générique, sans accès DB ni couplage au hash.
// Adapté aux images sans outils (memos, n8n, jellyfin…). La recette déclare
// `default.login: { container, url, method?, body, okCodes? }`.
async function loginVerify(def: any, mainPort?: number): Promise<boolean> {
  const s = def.login || {};
  if (!s.path) return false;
  const okCodes: number[] = Array.isArray(s.okCodes) && s.okCodes.length ? s.okCodes : [200];
  try {
    const code = await apiCall(s, def, mainPort);
    return okCodes.includes(code);
  } catch (_) {
    return false;
  }
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

async function provisionDefault(appId: string): Promise<void> {
  const info = await getRecipe(appId);
  if (info === null || info.sso) return;
  const recipe = info.recipe;
  const def = recipe && recipe.default;
  if (!def || !def.email) return;

  const mode = def.provision || 'shipped';
  if (mode === 'installScript' || mode === 'shipped') return; // compte déjà présent

  // Idempotent : ne (re)crée que si le compte par défaut est absent.
  // Vérif d'existence : par login (apps sans outils DB) sinon par listing DB.
  let exists = false;
  if (def.login) {
    try { exists = await loginVerify(def, info.mainPort); } catch (_) { /* pas prêt */ }
  } else {
    try {
      const accounts = await listAccountsByRecipe(recipe);
      exists = accounts.some(
        (a) =>
          (a.email || '').toLowerCase() === def.email.toLowerCase() ||
          (!!def.username && (a.username || '').toLowerCase() === String(def.username).toLowerCase())
      );
    } catch (_) { /* on tente quand même la création */ }
  }
  if (exists) return;

  if (mode === 'api') {
    return apiSignupResilient(def, info.mainPort);
  }
  if (mode === 'sql-update') {
    return bcryptSqliteUpdateAccount(recipe, def);
  }
  if (mode === 'adapter') {
    switch (recipe.strategy) {
      case 'rails-devise':
        return railsCreateDefault(recipe, def);
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

  let accounts: Account[] = [];
  try {
    accounts = await listAccountsByRecipe(recipe);
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
    stillDefault = await verifyAccountPassword(recipe, acc, def.password);
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
    case 'rails-devise':
    case 'bcrypt-sqlite':
    case 'affine-argon2':
    case 'bcrypt-postgres':
    case 'hermes-webui':
    case 'hermes-dashboard':
      // restartsOnReset : prévient l'UI qu'une réinitialisation redémarre l'app
      // (ex. Hermes, dont le hash est caché en mémoire). Déclaré dans le manifeste.
      return { supported: true, accounts: await listAccountsByRecipe(recipe), restartsOnReset: !!recipe.resetRestarts };
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
    case 'rails-devise':
      return railsReset(recipe, accountId, newPassword);
    case 'bcrypt-sqlite':
      return bcryptSqliteReset(recipe, accountId, newPassword);
    case 'affine-argon2':
      return affineReset(recipe, accountId, newPassword);
    case 'bcrypt-postgres':
      return bcryptPostgresReset(recipe, accountId, newPassword);
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
