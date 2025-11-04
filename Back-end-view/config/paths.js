// Configuration centralisée des chemins de fichiers
const path = require('path');

const RYVIE_DIR = '/opt/Ryvie';
const SETTINGS_FILE = '/data/config/global-preferences/server-settings.json';
const NETBIRD_FILE = '/data/config/netbird/netbird-data.json';
const PREFERENCES_DIR = '/data/config/user-preferences';
const BACKGROUNDS_DIR = '/data/images/backgrounds';
const PRESETS_DIR = '/opt/Ryvie/Ryvie-Front/public/images/backgrounds';
const MANIFESTS_DIR = '/data/config/manifests';
const APPS_DIR = '/data/apps';
const REVERSE_PROXY_DIR = '/data/config/reverse-proxy';

module.exports = {
  RYVIE_DIR,
  SETTINGS_FILE,
  NETBIRD_FILE,
  PREFERENCES_DIR,
  BACKGROUNDS_DIR,
  PRESETS_DIR,
  MANIFESTS_DIR,
  APPS_DIR,
  REVERSE_PROXY_DIR
};
