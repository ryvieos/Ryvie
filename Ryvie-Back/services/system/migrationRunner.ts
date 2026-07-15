/**
 * Runner de migrations de données (/data).
 *
 * Objectif : rendre le saut direct entre versions Ryvie sûr, comme le fait iOS.
 * Le système de mise à jour remplace le CODE d'un coup (v0.0.30 -> v1.0.0 direct),
 * mais les DONNÉES dans /data survivent et peuvent être à un ancien format.
 *
 * Ce runner applique, au démarrage du backend, TOUTES les migrations dont le
 * numéro est supérieur au `dataVersion` enregistré, dans l'ordre croissant —
 * quel que soit le chemin de versions Ryvie emprunté.
 *
 * Règles pour écrire une migration (voir migrations/README.md) :
 *  - Fichier `migrations/<N>-description.ts` exportant { version:N, description, up() }.
 *  - `up()` doit être IDEMPOTENT et basé sur l'ÉTAT réel des données
 *    (« si le fichier est à l'ancien format, convertis-le »), JAMAIS sur la
 *    version de Ryvie. Ainsi elle est sûre même sur une installation neuve
 *    (l'ancien format n'existe pas -> no-op) et si elle est rejouée.
 */

export {};
const fs = require('fs');
const path = require('path');

// Fichier d'état : vit dans /data (portable, survit aux mises à jour de code).
// Ce numéro n'a AUCUN rapport avec la version de Ryvie (v0.0.30, v1.0.0...).
// C'est un compteur interne du format des données.
const DATA_VERSION_FILE = '/data/config/data-version.json';

// Dossier des migrations compilées. À l'exécution __dirname vaut
// dist/services/system, donc les migrations sont dans dist/migrations.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

interface Migration {
  version: number;
  description: string;
  up: () => Promise<void> | void;
  __file: string;
}

/**
 * Lit le dataVersion courant. Retourne 0 si absent/illisible
 * (installation neuve ou toute première exécution du runner).
 */
function readDataVersion(): number {
  try {
    if (!fs.existsSync(DATA_VERSION_FILE)) return 0;
    const raw = JSON.parse(fs.readFileSync(DATA_VERSION_FILE, 'utf8'));
    const v = Number(raw?.dataVersion);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  } catch (e: any) {
    console.warn(`[migration] Lecture de ${DATA_VERSION_FILE} impossible, on repart de 0: ${e.message}`);
    return 0;
  }
}

/**
 * Écrit le dataVersion de façon atomique (tmp + rename) pour ne jamais
 * laisser un fichier d'état à moitié écrit en cas de coupure.
 */
function writeDataVersion(version: number): void {
  fs.mkdirSync(path.dirname(DATA_VERSION_FILE), { recursive: true });
  const tmp = `${DATA_VERSION_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ dataVersion: version }, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_VERSION_FILE);
}

/**
 * Charge et valide toutes les migrations du dossier, triées par version.
 * Un fichier est une migration s'il s'appelle `<N>-*.js` (N = numéro).
 */
function loadMigrations(): Migration[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const files: string[] = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => /^\d+.*\.js$/.test(f) && !f.endsWith('.d.ts'));

  const migrations: Migration[] = [];
  for (const file of files) {
    const mod = require(path.join(MIGRATIONS_DIR, file));
    const m = mod?.default || mod;
    if (typeof m?.version !== 'number' || typeof m?.up !== 'function') {
      throw new Error(`Migration invalide (${file}) : { version:number, up:function } attendu`);
    }
    migrations.push({
      version: m.version,
      description: m.description || file,
      up: m.up,
      __file: file
    });
  }

  migrations.sort((a, b) => a.version - b.version);

  // Sécurité : deux migrations ne doivent jamais partager le même numéro.
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(
        `Deux migrations portent le numéro ${migrations[i].version} ` +
        `(${migrations[i - 1].__file} et ${migrations[i].__file})`
      );
    }
  }

  return migrations;
}

/**
 * Exécute, dans l'ordre, toutes les migrations non encore appliquées.
 * Avance `dataVersion` APRÈS chaque succès (reprise possible si coupure).
 * En cas d'échec : throw -> le démarrage échoue -> le health check de
 * update-and-restart.sh déclenche le rollback BTRFS automatique.
 */
async function runMigrations(): Promise<void> {
  const current = readDataVersion();
  const all = loadMigrations();
  const pending = all.filter(m => m.version > current);

  if (all.length === 0) {
    console.log('[migration] Aucune migration définie — rien à faire.');
    return;
  }
  if (pending.length === 0) {
    console.log(`[migration] Données à jour (dataVersion=${current}).`);
    return;
  }

  console.log(`[migration] dataVersion=${current}, ${pending.length} migration(s) à appliquer.`);
  for (const m of pending) {
    console.log(`[migration] ▶ ${m.version} — ${m.description}`);
    await m.up();
    writeDataVersion(m.version);
    console.log(`[migration] ✅ ${m.version} appliquée (dataVersion=${m.version}).`);
  }
  console.log('[migration] Toutes les migrations sont appliquées.');
}

module.exports = {
  runMigrations,
  readDataVersion,
  writeDataVersion,
  loadMigrations
};
