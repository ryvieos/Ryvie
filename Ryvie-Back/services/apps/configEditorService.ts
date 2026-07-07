/**
 * configEditorService — Édition « zéro terminal » des fichiers de config des apps.
 *
 * Permet à un admin de lire/modifier, depuis l'UI Ryvie, les fichiers de
 * configuration qu'une app déclare comme éditables dans son manifeste
 * (bloc `configEditor:`). C'est ce qui débloque les intégrations « avancées »
 * (ex. Home Assistant : `configuration.yaml`) sans jamais ouvrir de terminal.
 *
 * Le cœur n'exécute jamais de code livré par le store : il lit/écrit uniquement
 * les fichiers EXPLICITEMENT déclarés par la recette, résolus DANS le dossier
 * source de l'app (anti-traversée de chemin), avec validation (YAML) et backup.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { execFileSync } = require('child_process');
const appManager = require('./appManagerService');

// Les apps tournant en root créent souvent leurs fichiers de config en root
// (ex. Home Assistant). Le backend Ryvie (utilisateur non-root) ne peut alors pas
// les écrire directement → on retombe sur une écriture privilégiée (tmpfile puis
// `sudo -n cp`, qui préserve le propriétaire root du fichier cible, donc l'app
// continue de le lire). sudo est configuré NOPASSWD sur les hôtes Ryvie.

// Lecture : directe, sinon `sudo -n cat` si le fichier n'est pas lisible.
function readFilePrivileged(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return '';
    if (e && e.code === 'EACCES') {
      try { return execFileSync('sudo', ['-n', 'cat', abs], { encoding: 'utf8' }); }
      catch (_) { throw e; }
    }
    throw e;
  }
}

// Copie best-effort du fichier existant en `.ryvie-bak` (directe puis privilégiée).
function backupPrivileged(abs: string): void {
  if (!fs.existsSync(abs)) return;
  const bak = `${abs}.ryvie-bak`;
  try { fs.copyFileSync(abs, bak); return; }
  catch (e: any) {
    if (e && e.code === 'EACCES') {
      try { execFileSync('sudo', ['-n', 'cp', abs, bak], { stdio: 'pipe' }); } catch (_) { /* best-effort */ }
    }
  }
}

// Écriture : directe, sinon tmpfile + `sudo -n cp` (préserve le owner de la cible).
function writeFilePrivileged(abs: string, content: string): void {
  try {
    fs.writeFileSync(abs, content, 'utf8');
    return;
  } catch (e: any) {
    if (!e || e.code !== 'EACCES') throw e;
  }
  const tmp = path.join('/tmp', `ryvie-config-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    execFileSync('sudo', ['-n', 'cp', tmp, abs], { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

export interface ConfigFileMeta {
  key: string;
  label: string;
  language: string; // 'yaml' | 'text' | ...
  path: string;     // chemin relatif déclaré (pour info)
  exists: boolean;
  size: number;
}

// Récupère la recette configEditor + le dossier source de l'app.
async function getRecipe(
  appId: string
): Promise<{ recipe: any; sourceDir: string } | null> {
  const manifest = await appManager.getAppManifest(appId);
  if (!manifest) return null;
  const recipe = manifest.configEditor || null;
  if (!recipe || !Array.isArray(recipe.files) || recipe.files.length === 0) return null;
  const sourceDir = manifest.sourceDir;
  if (!sourceDir) return null;
  return { recipe, sourceDir };
}

// Résout le chemin absolu d'un fichier déclaré, en garantissant qu'il reste DANS
// le dossier source de l'app (défense anti path-traversal).
function resolveDeclaredFile(sourceDir: string, relPath: string): string {
  const base = path.resolve(sourceDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err: any = new Error('Chemin de fichier hors du dossier de l\'app');
    err.status = 400;
    throw err;
  }
  return target;
}

// Retrouve la déclaration d'un fichier par sa clé.
function findFile(recipe: any, fileKey: string): any {
  const file = recipe.files.find((f: any) => String(f.key) === String(fileKey));
  if (!file) {
    const err: any = new Error('Fichier de configuration inconnu');
    err.status = 404;
    throw err;
  }
  return file;
}

function notFoundIfNull(info: any, appId: string): void {
  if (info === null) {
    const err: any = new Error(`Édition de configuration non disponible pour « ${appId} »`);
    err.status = 400;
    throw err;
  }
}

/**
 * Liste les fichiers de config éditables d'une app (métadonnées, sans contenu).
 */
async function listConfigFiles(appId: string): Promise<{ supported: boolean; restartOnSave: boolean; files: ConfigFileMeta[] }> {
  const info = await getRecipe(appId);
  if (info === null) return { supported: false, restartOnSave: false, files: [] };
  const { recipe, sourceDir } = info;
  const files: ConfigFileMeta[] = recipe.files.map((f: any) => {
    const abs = resolveDeclaredFile(sourceDir, f.path);
    let exists = false;
    let size = 0;
    try {
      const st = fs.statSync(abs);
      exists = st.isFile();
      size = st.size;
    } catch (_) { /* fichier pas encore créé */ }
    return {
      key: String(f.key),
      label: f.label || f.path,
      language: f.language || 'text',
      path: f.path,
      exists,
      size,
    };
  });
  return { supported: true, restartOnSave: recipe.restartOnSave !== false, files };
}

/**
 * Lit le contenu d'un fichier de config déclaré.
 */
async function readConfigFile(appId: string, fileKey: string): Promise<{ key: string; label: string; language: string; content: string }> {
  const info = await getRecipe(appId);
  notFoundIfNull(info, appId);
  const { recipe, sourceDir } = info!;
  const file = findFile(recipe, fileKey);
  const abs = resolveDeclaredFile(sourceDir, file.path);
  let content = '';
  try {
    content = readFilePrivileged(abs);
  } catch (_) {
    content = ''; // fichier absent / illisible → éditeur vide (création à la sauvegarde)
  }
  return { key: String(file.key), label: file.label || file.path, language: file.language || 'text', content };
}

/**
 * Écrit un fichier de config déclaré. Valide le YAML, sauvegarde un backup
 * `.ryvie-bak`, puis redémarre l'app si demandé/déclaré.
 */
async function writeConfigFile(
  appId: string,
  fileKey: string,
  content: string,
  opts: { restart?: boolean } = {}
): Promise<{ success: boolean; restarted: boolean }> {
  if (typeof content !== 'string') {
    const err: any = new Error('Contenu invalide');
    err.status = 400;
    throw err;
  }
  const info = await getRecipe(appId);
  notFoundIfNull(info, appId);
  const { recipe, sourceDir } = info!;
  const file = findFile(recipe, fileKey);
  const abs = resolveDeclaredFile(sourceDir, file.path);

  // Validation selon le langage déclaré : on refuse d'écrire un YAML invalide
  // (sinon on casserait l'app, ex. HA ne démarre plus).
  const language = file.language || 'text';
  if (language === 'yaml') {
    try {
      yaml.parse(content);
    } catch (e: any) {
      const err: any = new Error(`YAML invalide : ${(e && e.message ? e.message : 'erreur de syntaxe').slice(0, 200)}`);
      err.status = 400;
      throw err;
    }
  }

  // Backup du dernier état connu avant écrasement (best-effort, privilégié si besoin).
  backupPrivileged(abs);
  // Crée le dossier parent si absent (best-effort ; l'écriture privilégiée gère le reste).
  try { if (!fs.existsSync(path.dirname(abs))) fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) { /* ok */ }

  writeFilePrivileged(abs, content);

  // Redémarrage : demandé explicitement OU imposé par la recette (restartOnSave).
  const shouldRestart = opts.restart === true || recipe.restartOnSave === true;
  let restarted = false;
  if (shouldRestart) {
    try {
      await appManager.restartApp(appId);
      restarted = true;
    } catch (e: any) {
      const err: any = new Error(
        `Fichier enregistré mais redémarrage de l'app échoué : ${e.message}. Redémarrez l'app manuellement.`
      );
      err.status = 500;
      throw err;
    }
  }
  return { success: true, restarted };
}

module.exports = { listConfigFiles, readConfigFile, writeConfigFile };
export {};
