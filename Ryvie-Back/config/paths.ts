// Configuration centralisée des chemins de fichiers
export {};
const path = require('path');

const RYVIE_DIR = '/opt/Ryvie';
const SETTINGS_FILE = '/data/config/global-preferences/server-settings.json';
const NETBIRD_FILE = '/data/config/netbird/netbird-data.json';
const PREFERENCES_DIR = '/data/config/user-preferences';
const BACKGROUNDS_DIR = '/data/images/backgrounds';
const PRESETS_DIR = '/opt/Ryvie/Ryvie-Front/public/images/backgrounds';
const MANIFESTS_DIR = '/data/config/manifests';
const APPS_DIR = '/data/apps';
const STORE_CATALOG = '/data/config/appStore';  
const REVERSE_PROXY_DIR = '/data/config/reverse-proxy';
const FRONTEND_CONFIG_DIR = '/data/config/frontend-view';

// Point central IA : LiteLLM headless (proxy OpenAI-compatible) piloté par Ryvie.
const AI_DIR = '/data/config/ai';                              // état + secrets IA
const AI_CONFIG_FILE = path.join(AI_DIR, 'ai-config.json');    // provider, modèle, apps connectées
const AI_KEY_FILE = path.join(AI_DIR, '.secret-key');          // clé de chiffrement locale (fallback)
const LITELLM_DIR = path.join(AI_DIR, 'litellm');              // stack LiteLLM
const LITELLM_COMPOSE_FILE = path.join(LITELLM_DIR, 'docker-compose.yml');
const LITELLM_CONFIG_YAML = path.join(LITELLM_DIR, 'config.yaml');
const LITELLM_ENV_FILE = path.join(LITELLM_DIR, '.env');       // master key + clé fournisseur (non versionné)

module.exports = {
  RYVIE_DIR,
  SETTINGS_FILE,
  NETBIRD_FILE,
  PREFERENCES_DIR,
  BACKGROUNDS_DIR,
  PRESETS_DIR,
  MANIFESTS_DIR,
  APPS_DIR,
  STORE_CATALOG,
  REVERSE_PROXY_DIR,
  FRONTEND_CONFIG_DIR,
  AI_DIR,
  AI_CONFIG_FILE,
  AI_KEY_FILE,
  LITELLM_DIR,
  LITELLM_COMPOSE_FILE,
  LITELLM_CONFIG_YAML,
  LITELLM_ENV_FILE
};
