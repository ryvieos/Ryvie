// Cycle de vie du proxy LiteLLM headless (OpenAI-compatible) piloté par Ryvie.
// LiteLLM tourne en conteneur (port 4000) ; son UI n'est jamais exposée. Ryvie
// génère sa config (config.yaml + .env master/clé fournisseur) et le (re)démarre.
// La construction du model_list et la gestion des secrets sont dans aiService.
export {};

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');
const { composeUpWithRecovery } = require('../system/dockerService');
const {
  LITELLM_DIR,
  LITELLM_COMPOSE_FILE,
  LITELLM_CONFIG_YAML,
  LITELLM_ENV_FILE
} = require('../../config/paths');

const CONTAINER = 'ryvie-litellm';
// 4000 est déjà pris par app-rdrive-node → on utilise 4010 (hôte + conteneur).
const PORT = 4010;
// Version ÉPINGLÉE (pas de tag flottant `main-stable`) : une version de Ryvie = une
// version LiteLLM reproductible. Pour monter de version, bumper ce tag dans une release
// (le changement de tag force docker à re-pull au prochain recreate du conteneur).
const IMAGE = 'ghcr.io/berriai/litellm:v1.91.1';

// Réseau DÉDIÉ à l'IA : LiteLLM + les apps connectées y vivent. Les apps joignent
// `ryvie-litellm` par DNS SANS être exposées à l'infra sensible de ryvie-network
// (keycloak, openldap, keycloak-postgres, caddy…). LiteLLM reste AUSSI sur
// ryvie-network (joignable comme avant), mais les apps IA ne touchent que ryvie-ai.
const AI_NETWORK = 'ryvie-ai';

const COMPOSE = `# Généré par Ryvie — proxy IA central (LiteLLM headless). Ne pas éditer à la main.
services:
  litellm:
    image: ${IMAGE}
    container_name: ${CONTAINER}
    restart: unless-stopped
    command: ["--config", "/app/config.yaml", "--port", "${PORT}"]
    ports:
      - "${PORT}:${PORT}"
    env_file:
      - .env
    # Permet au conteneur de joindre l'HOTE (shim Claude CLI, Ollama local...) par le
    # nom host.docker.internal au lieu de l'IP LAN de la machine -> l'IA continue de
    # fonctionner meme si l'IP change (deplacement de la machine, DHCP, etc.).
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./config.yaml:/app/config.yaml:ro
    networks:
      - ryvie-network
      - ${AI_NETWORK}
networks:
  ryvie-network:
    external: true
  ${AI_NETWORK}:
    external: true
`;

/** Crée le réseau dédié IA (ryvie-ai) s'il n'existe pas. Idempotent. Doit exister
 * AVANT le `docker compose up` (réseau external) et avant de rattacher des apps. */
function ensureNetwork(): void {
  try {
    execSync(`docker network inspect ${AI_NETWORK}`, { timeout: 10000, stdio: 'pipe' });
  } catch (_) {
    try {
      execSync(`docker network create ${AI_NETWORK}`, { timeout: 15000, stdio: 'pipe' });
    } catch (err: any) {
      console.warn(`[litellm] ⚠️ création réseau ${AI_NETWORK}:`, err.message);
    }
  }
}

function ensureDirs(): void {
  fs.mkdirSync(LITELLM_DIR, { recursive: true });
}

/** Écrit le docker-compose.yml (idempotent) et garantit l'existence du réseau IA. */
function writeCompose(): void {
  ensureDirs();
  ensureNetwork();
  fs.writeFileSync(LITELLM_COMPOSE_FILE, COMPOSE, 'utf8');
}

/** Écrit le config.yaml (généré par aiService). */
function writeConfigYaml(yamlStr: string): void {
  ensureDirs();
  fs.writeFileSync(LITELLM_CONFIG_YAML, yamlStr, 'utf8');
}

/**
 * Écrit le .env du conteneur : master key (auth des apps) + clé fournisseur réelle
 * (jamais exposée aux apps, référencée via os.environ/PROVIDER_API_KEY).
 * Permissions resserrées (600) car contient des secrets.
 */
function writeEnv({ masterKey, providerKey }: { masterKey: string; providerKey?: string }): void {
  ensureDirs();
  const lines = [
    '# Généré par Ryvie — secrets LiteLLM. Ne pas committer.',
    `LITELLM_MASTER_KEY=${masterKey}`,
    `PROVIDER_API_KEY=${providerKey || ''}`,
    'LITELLM_LOG=ERROR'
  ];
  fs.writeFileSync(LITELLM_ENV_FILE, lines.join('\n') + '\n', 'utf8');
  try { fs.chmodSync(LITELLM_ENV_FILE, 0o600); } catch (_) { /* best effort */ }
}

function isConfigured(): boolean {
  return fs.existsSync(LITELLM_CONFIG_YAML) && fs.existsSync(LITELLM_ENV_FILE);
}

function isRunning(): boolean {
  try {
    const out = execSync(
      `docker ps --filter "name=^${CONTAINER}$" --filter "status=running" -q`,
      { encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** (Re)démarre le conteneur en appliquant la config courante. */
function restart(): void {
  writeCompose();
  composeUpWithRecovery(`docker compose up -d --force-recreate`, {
    cwd: LITELLM_DIR,
    timeout: 120000,
    label: 'litellm'
  });
}

/** Démarre LiteLLM s'il est configuré (appelé au boot). Toujours writeCompose + up -d,
 *  même si le conteneur tourne déjà : idempotent, mais permet de détecter un changement
 *  de compose/image (ex. bump du tag LiteLLM ÉPINGLÉ lors d'un update Ryvie) → docker
 *  re-pull et recrée le conteneur. Aligné sur le comportement de Keycloak
 *  (ensureKeycloakRunning) pour que « une version de Ryvie = des versions de composants
 *  reproductibles » s'applique vraiment aux mises à jour, pas seulement aux fresh installs. */
function ensureRunning(): { success: boolean; alreadyRunning?: boolean; started?: boolean; skipped?: boolean; error?: string } {
  try {
    if (!isConfigured()) {
      return { success: true, skipped: true };
    }
    const wasRunning = isRunning();
    writeCompose();
    composeUpWithRecovery(`docker compose up -d`, { cwd: LITELLM_DIR, timeout: 120000, label: 'litellm' });
    return { success: true, started: !wasRunning, alreadyRunning: wasRunning };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function stop(): void {
  if (!fs.existsSync(LITELLM_COMPOSE_FILE)) return;
  try {
    execSync(`docker compose down`, { cwd: LITELLM_DIR, timeout: 60000, stdio: 'pipe' });
  } catch (err: any) {
    console.warn('[litellm] ⚠️ Arrêt:', err.message);
  }
}

/**
 * Sonde l'API LiteLLM (GET /v1/models avec la master key). Prêt = 200.
 * Attend jusqu'à `maxWaitMs` (LiteLLM met quelques secondes à démarrer).
 */
async function probe(masterKey: string, maxWaitMs = 30000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(`http://127.0.0.1:${PORT}/v1/models`, {
        timeout: 4000,
        headers: { Authorization: `Bearer ${masterKey}` },
        validateStatus: () => true
      });
      if (res.status === 200) return true;
    } catch (_) { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

module.exports = {
  CONTAINER,
  PORT,
  AI_NETWORK,
  ensureNetwork,
  writeCompose,
  writeConfigYaml,
  writeEnv,
  isConfigured,
  isRunning,
  restart,
  ensureRunning,
  stop,
  probe
};
