const { execSync } = require('child_process');

/**
 * Détecte le mode actuel (dev ou prod) via pm2
 */
function detectMode() {
  try {
    const pm2List = execSync('pm2 list', { encoding: 'utf8' });
    if (pm2List.toLowerCase().includes('dev')) {
      return 'dev';
    }
  } catch (_) {}
  return 'prod';
}

module.exports = { detectMode };
