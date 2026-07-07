import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DATA_ROOT = process.env.DATA_ROOT || '/data';

/**
 * Exécute une commande shell de manière silencieuse et renvoie un booléen en cas de succès
 */
function execSafe(cmd: string): boolean {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function hasDirectoryContent(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function readTextFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeTextFileWithSudo(filePath: string, content: string): void {
  const tmpFile = `/tmp/ryvie-compose-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  execSync(`sudo cp "${tmpFile}" "${filePath}" && sudo chown root:root "${filePath}"`, { stdio: 'pipe', timeout: 120000 });
  try {
    fs.unlinkSync(tmpFile);
  } catch {
    execSafe(`rm -f "${tmpFile}"`);
  }
}

function findLegacyOpenLdapVolume(): string | null {
  try {
    const output = execSync(
      `sudo docker volume ls -q | grep -E '(^|_)openldap_data$|openldap_data$' | head -1`,
      { encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function ensureDirectory(dirPath: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    execSafe(`sudo mkdir -p "${dirPath}"`);
  }
}

function extractComposeValue(content: string, key: string, fallback: string): string {
  const regex = new RegExp(`${key}=([^\n]+)`);
  const match = content.match(regex);
  return match ? match[1].trim() : fallback;
}

function ensureCorePersistentDirectories(): void {
  const requiredDirs = [
    `${DATA_ROOT}/config/ldap/data`,
    `${DATA_ROOT}/config/keycloak/postgres`,
    `${DATA_ROOT}/config/keycloak/import`,
    `${DATA_ROOT}/config/keycloak/themes`,
    `${DATA_ROOT}/config/reverse-proxy/data`,
    `${DATA_ROOT}/config/reverse-proxy/config`,
    `${DATA_ROOT}/config/portainer`,
    `${DATA_ROOT}/portainer`
  ];

  for (const dirPath of requiredDirs) {
    ensureDirectory(dirPath);
  }
}

function ensureDockerNetworkExists(networkName: string): void {
  if (!execSafe(`sudo docker network ls | grep -q '${networkName}'`)) {
    console.log(`[Architecture] 🌐 Création du réseau docker manquant: ${networkName}`);
    execSafe(`sudo docker network create ${networkName}`);
  }
}

function migrateLegacyOpenLdapVolume(): boolean {
  const ldapBindMount = '/data/config/ldap/data';

  if (hasDirectoryContent(ldapBindMount)) {
    return false;
  }

  const legacyVolume = findLegacyOpenLdapVolume();
  if (!legacyVolume) {
    return false;
  }

  try {
    fs.mkdirSync(ldapBindMount, { recursive: true });
  } catch {
    execSafe(`sudo mkdir -p "${ldapBindMount}"`);
  }

  console.log(`[Architecture] 📦 Migration des données OpenLDAP du volume Docker (${legacyVolume}) vers /data/config/ldap/data...`);
  execSync(
    `sudo docker run --rm -v ${legacyVolume}:/from -v "${ldapBindMount}":/to alpine sh -c 'cp -a /from/. /to/'`,
    { encoding: 'utf8', stdio: 'pipe', timeout: 120000 }
  );
  console.log('[Architecture] ✅ Données OpenLDAP migrées vers le bind mount persistant');
  return true;
}

function normalizeLdapCompose(content: string): { content: string; changed: boolean } {
  const adminPassword = extractComposeValue(content, 'LDAP_ADMIN_PASSWORD', 'admin');
  const ldapRoot = extractComposeValue(content, 'LDAP_ROOT', 'dc=example,dc=org');

  const canonicalContent = `version: '3.8'

services:
  openldap:
    image: julescloud/ryvieldap:latest
    container_name: openldap
    environment:
      - LDAP_ADMIN_USERNAME=admin
      - LDAP_ADMIN_PASSWORD=${adminPassword}
      - LDAP_ROOT=${ldapRoot}
    ports:
      - "389:1389"  # Port LDAP
      - "636:1636"  # Port LDAP sécurisé
    networks:
      - ldap_my_custom_network
      - ryvie-network
    volumes:
      - /data/config/ldap/data:/bitnami/openldap
    restart: unless-stopped

networks:
  ldap_my_custom_network:
    external: true
  ryvie-network:
    external: true
`;

  const normalizedCurrent = content.trim().replace(/\s+$/gm, '');
  const normalizedTarget = canonicalContent.trim().replace(/\s+$/gm, '');
  if (normalizedCurrent === normalizedTarget) {
    return { content, changed: false };
  }

  return { content: canonicalContent, changed: true };
}

function ensureLdapComposeIsHealthy(): boolean {
  const ldapComposeFile = path.join(DATA_ROOT, 'config', 'ldap', 'docker-compose.yml');
  const currentContent = readTextFileSafe(ldapComposeFile);
  if (!currentContent) {
    return false;
  }

  const { content: normalizedContent, changed } = normalizeLdapCompose(currentContent);
  if (!changed) {
    return false;
  }

  console.log('[Architecture] 🔧 Normalisation du docker-compose LDAP legacy...');
  writeTextFileWithSudo(ldapComposeFile, normalizedContent);
  return true;
}

function ensureOpenLdapOnNetworks(): void {
  try {
    const running = execSync(
      `sudo docker ps --filter "name=^openldap$" --filter "status=running" -q`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }
    ).trim();

    if (!running) {
      return;
    }

    const inspect = execSync(
      `sudo docker inspect openldap --format '{{json .NetworkSettings.Networks}}'`,
      { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }
    ).trim();

    for (const networkName of ['ldap_my_custom_network', 'ryvie-network']) {
      if (!inspect.includes(networkName)) {
        execSafe(`sudo docker network connect ${networkName} openldap`);
        console.log(`[Architecture] 🌐 openldap connecté au réseau ${networkName}`);
      }
    }
  } catch (error: any) {
    console.warn('[Architecture] ⚠️ Impossible de vérifier les réseaux d\'OpenLDAP:', error.message);
  }
}

/**
 * Analyse et applique proactivement les règles d'architecture fondamentales
 * Pour réparer dynamiquement les configurations legacy
 */
export async function enforceArchitectureBase(): Promise<void> {
  console.log('[Architecture] Vérification de la robustesse fondamentale du système...');

  try {
    // 1. Vérification BTRFS
    const isBtrfs = execSafe(`findmnt -f ${DATA_ROOT} | grep -q btrfs`);
    if (!isBtrfs) {
      console.warn(`[Architecture] ⚠️ ATTENTION: ${DATA_ROOT} n'est pas vu comme un volume BTRFS.`);
    }

    // 1.b Garantir les répertoires persistants des services critiques
    ensureCorePersistentDirectories();

    // 2. Création/Vérification des réseaux Docker critiques
    ensureDockerNetworkExists('ryvie-network');
    ensureDockerNetworkExists('ldap_my_custom_network');

    // 3. Migration LDAP
    const ldapComposeFile = path.join(DATA_ROOT, 'config', 'ldap', 'docker-compose.yml');
    const ldapMigrated = migrateLegacyOpenLdapVolume();
    const ldapComposeRepaired = ensureLdapComposeIsHealthy();
    ensureOpenLdapOnNetworks();
    if (ldapMigrated || ldapComposeRepaired) {
      console.log('[Architecture] 🔄 Redémarrage de LDAP après migration/normalisation...');
      execSafe(`cd "${path.dirname(ldapComposeFile)}" && sudo docker compose up -d`);
    }

    // 4. Portainer : Enveloppement Compose (si la stack versionnée n'existe pas)
    const portainerDir = path.join(DATA_ROOT, 'config', 'portainer');
    const portainerComposePath = path.join(portainerDir, 'docker-compose.yml');
    
    if (!fs.existsSync(portainerComposePath)) {
      console.log('[Architecture] 🐳 Stabilisation de Portainer (transformation en stack compose)...');
      
      execSafe(`sudo mkdir -p "${portainerDir}"`);
      execSafe(`sudo mkdir -p "${DATA_ROOT}/portainer"`);

      const portainerComposeContent = `version: '3.8'

services:
  portainer:
    image: portainer/portainer-ce:latest
    container_name: portainer
    restart: always
    ports:
      - "8000:8000"
      - "9443:9443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DATA_ROOT}/portainer:/data
`;
      // Write it as Ryvie user, so no sudo needed here as it's just under /data/config
      // We'll create it directly (ensure owner is ryvie)
      fs.writeFileSync('/tmp/portainer-compose.yml', portainerComposeContent);
      execSafe(`sudo mv /tmp/portainer-compose.yml "${portainerComposePath}"`);
      execSafe(`sudo chown ryvie:ryvie "${portainerComposePath}"`);

      // Destroy potential unmanaged standalone portainer
      if (execSafe(`sudo docker ps -a --format '{{.Names}}' | grep -q '^portainer$'`)) {
        console.log('[Architecture] 🛑 Remplacement de l\'ancien conteneur Portainer non-versionné...');
        execSafe(`sudo docker rm -f portainer`);
      }

      console.log('[Architecture] 🚀 Lancement de Portainer géré par compose...');
      execSafe(`cd "${portainerDir}" && sudo docker compose up -d`);
    }

    console.log('[Architecture] ✅ Architecture fondamentale saine et vérifiée.');

  } catch (error: any) {
    console.error('[Architecture] ❌ Erreur lors de la vérification architecture:', error.message);
  }
}
