// Helpers de manipulation des fichiers .env des apps (lecture/écriture avec
// fallback sudo pour les fichiers appartenant à root, et édition de variables).
// Extrait pour être réutilisé par l'injection IA (aiService) sans dupliquer la
// logique déjà présente dans publicExposureService.
export {};

const fs = require('fs');
const { execSync } = require('child_process');

/**
 * Lit un fichier .env. Renvoie '' si absent. Bascule sur `sudo cat` si le
 * fichier appartient à root (EACCES), comme le reste du backend.
 */
function readEnvFile(envPath: string): string {
  try {
    return fs.readFileSync(envPath, 'utf8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    if (err.code === 'EACCES') {
      try {
        return execSync(`sudo cat "${envPath}"`, { encoding: 'utf8' });
      } catch {
        return '';
      }
    }
    throw err;
  }
}

/**
 * Écrit un fichier .env. Bascule sur `sudo cp` depuis un fichier temporaire si
 * l'écriture directe est refusée (EACCES/EPERM).
 */
function writeEnvFile(envPath: string, content: string): void {
  try {
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const tmpFile = `/tmp/ryvie-env-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpFile, content, 'utf8');
      execSync(`sudo cp "${tmpFile}" "${envPath}" && rm -f "${tmpFile}"`);
    } else {
      throw err;
    }
  }
}

/** Valeur actuelle d'une variable dans un contenu .env (ou null). */
function getEnvVar(content: string, name: string): string | null {
  const m = content.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1] : null;
}

/** Pose/maj une variable (ajoute la ligne si absente). Renvoie le nouveau contenu. */
function setEnvVar(content: string, name: string, value: string): string {
  const regex = new RegExp(`^${name}=.*$`, 'm');
  if (regex.test(content)) return content.replace(regex, `${name}=${value}`);
  return content.replace(/\s*$/, '') + `\n${name}=${value}\n`;
}

/** Retire une variable si présente. Renvoie le nouveau contenu. */
function unsetEnvVar(content: string, name: string): string {
  return content.replace(new RegExp(`^${name}=.*\\r?\\n?`, 'm'), '');
}

module.exports = { readEnvFile, writeEnvFile, getEnvVar, setEnvVar, unsetEnvVar };
