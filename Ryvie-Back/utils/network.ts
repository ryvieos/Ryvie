const os = require('os');
const { execSync } = require('child_process');

// Interfaces à ignorer (Docker, bridges, virtuelles, etc.)
const IGNORED_INTERFACE_PATTERNS = ['br-', 'docker', 'veth', 'lo', 'virbr', 'tun', 'tap'];

// Cache des IPs pour éviter les recherches répétées
let cachedLocalIP: string | null = null;
let cachedPrivateIP: string | null = null;
let cacheInitialized = false;

/**
 * Vérifie si l'interface doit être ignorée
 */
function shouldIgnoreInterface(interfaceName: string): boolean {
  const lowerName = interfaceName.toLowerCase();
  return IGNORED_INTERFACE_PATTERNS.some(pattern => lowerName.startsWith(pattern));
}

/**
 * Récupère l'interface utilisée pour la route par défaut (la plus fiable)
 * Utilise `ip route` pour trouver l'interface de sortie vers Internet
 */
function getDefaultRouteInterface(): { interface: string; ip: string } | null {
  try {
    // Récupérer l'interface de la route par défaut
    const routeOutput = execSync('ip route get 8.8.8.8 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    
    // Parse: "8.8.8.8 via 192.168.1.1 dev enp0s3 src 192.168.1.47 uid 1000"
    const devMatch = routeOutput.match(/dev\s+(\S+)/);
    const srcMatch = routeOutput.match(/src\s+(\S+)/);
    
    if (devMatch && srcMatch) {
      const interfaceName = devMatch[1];
      const ip = srcMatch[1];
      
      // Vérifier que ce n'est pas une interface Docker/virtuelle
      if (!shouldIgnoreInterface(interfaceName)) {
        return { interface: interfaceName, ip };
      }
    }
  } catch (error) {
    // Silently fail, will use fallback
  }
  return null;
}

/**
 * Récupère l'IP de l'interface par défaut via NetworkManager (si disponible)
 */
function getNetworkManagerIP(): string | null {
  try {
    // Essayer nmcli pour obtenir la connexion active
    const output = execSync('nmcli -t -f IP4.ADDRESS dev show 2>/dev/null | grep IP4.ADDRESS | head -1', { 
      encoding: 'utf8', 
      timeout: 5000 
    });
    
    // Parse: "IP4.ADDRESS[1]:192.168.1.47/24"
    const match = output.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }
  } catch (error) {
    // nmcli not available or failed
  }
  return null;
}

/**
 * Fallback: récupère n'importe quelle IP locale valide (hors Docker)
 */
function getFallbackIP(): string {
  const networkInterfaces = os.networkInterfaces();
  
  for (const interfaceName in networkInterfaces) {
    if (shouldIgnoreInterface(interfaceName)) continue;
    
    const addresses = networkInterfaces[interfaceName];
    for (const addressInfo of addresses) {
      if (addressInfo.family === 'IPv4' && !addressInfo.internal) {
        return addressInfo.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Récupère l'adresse IP locale de manière fiable (avec cache)
 * Ordre de priorité:
 * 1. Interface de la route par défaut (ip route get 8.8.8.8)
 * 2. NetworkManager (nmcli)
 * 3. Première interface non-Docker disponible
 */
function getLocalIP(): string {
  // Retourner le cache si déjà initialisé
  if (cacheInitialized && cachedLocalIP) {
    return cachedLocalIP;
  }
  
  // 1. Méthode la plus fiable: route par défaut
  const defaultRoute = getDefaultRouteInterface();
  if (defaultRoute) {
    cachedLocalIP = defaultRoute.ip;
    return defaultRoute.ip;
  }
  
  // 2. Essayer NetworkManager
  const nmIP = getNetworkManagerIP();
  if (nmIP) {
    cachedLocalIP = nmIP;
    return nmIP;
  }
  
  // 3. Fallback sur la première interface valide
  const fallbackIP = getFallbackIP();
  cachedLocalIP = fallbackIP;
  return fallbackIP;
}

/**
 * Attend qu'une interface réseau valide soit disponible et initialise le cache
 * @param maxWaitMs Temps maximum d'attente en ms (défaut: 30 secondes)
 * @param checkIntervalMs Intervalle entre les vérifications en ms (défaut: 1 seconde)
 */
async function waitForWifiInterface(maxWaitMs: number = 30000, checkIntervalMs: number = 1000): Promise<string> {
  const startTime = Date.now();
  
  console.log('[network] 🔍 Attente d\'une interface réseau valide...');
  
  while (Date.now() - startTime < maxWaitMs) {
    // Vérifier la route par défaut (méthode la plus fiable)
    const defaultRoute = getDefaultRouteInterface();
    if (defaultRoute) {
      console.log(`[network] ✅ Interface réseau trouvée: ${defaultRoute.interface} (${defaultRoute.ip})`);
      
      // Initialiser le cache
      cachedLocalIP = defaultRoute.ip;
      cachedPrivateIP = getPrivateIPInternal(); // Calculer aussi l'IP privée
      cacheInitialized = true;
      
      return defaultRoute.ip;
    }
    
    // Attendre avant la prochaine vérification
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }
  
  // Timeout atteint, utiliser le fallback
  const fallbackIP = getFallbackIP();
  console.warn(`[network] ⚠️  Timeout (${maxWaitMs}ms) - Utilisation du fallback:`, fallbackIP);
  
  // Initialiser le cache même en fallback
  cachedLocalIP = fallbackIP;
  cachedPrivateIP = getPrivateIPInternal();
  cacheInitialized = true;
  
  return fallbackIP;
}

/**
 * Version interne: Récupère l'adresse IP privée (VPN/Netbird) sans cache
 * Cherche 172.x.x.x ou 10.x.x.x
 */
function getPrivateIPInternal(): string {
  const networkInterfaces = os.networkInterfaces();
  
  // Chercher d'abord une adresse 172.x.x.x (hors Docker)
  for (const interfaceName in networkInterfaces) {
    if (shouldIgnoreInterface(interfaceName)) continue;
    
    const addresses = networkInterfaces[interfaceName];
    for (const addressInfo of addresses) {
      if (addressInfo.family === 'IPv4' && !addressInfo.internal) {
        const ip = addressInfo.address;
        // Vérifier si c'est une adresse privée 172.16.0.0 - 172.31.255.255
        if (ip.startsWith('172.')) {
          const secondOctet = parseInt(ip.split('.')[1]);
          if (secondOctet >= 16 && secondOctet <= 31) {
            return ip;
          }
        }
        // Accepter aussi les adresses 172.x.x.x hors plage Docker standard
        if (ip.startsWith('172.')) {
          const secondOctet = parseInt(ip.split('.')[1]);
          // Exclure les plages Docker communes: 172.17-27
          if (secondOctet < 16 || secondOctet > 31) {
            return ip;
          }
        }
      }
    }
  }
  
  // Sinon chercher une adresse 10.x.x.x (hors Docker)
  for (const interfaceName in networkInterfaces) {
    if (shouldIgnoreInterface(interfaceName)) continue;
    
    const addresses = networkInterfaces[interfaceName];
    for (const addressInfo of addresses) {
      if (addressInfo.family === 'IPv4' && !addressInfo.internal) {
        const ip = addressInfo.address;
        if (ip.startsWith('10.')) {
          return ip;
        }
      }
    }
  }
  
  // Par défaut, retourner l'IP locale standard
  return cachedLocalIP || getFallbackIP();
}

/**
 * Récupère l'adresse IP privée (VPN/Netbird) avec cache
 * Utilisé pour Ryvie-rDrive qui a besoin de l'IP du VPN
 */
function getPrivateIP(): string {
  // Retourner le cache si déjà initialisé
  if (cacheInitialized && cachedPrivateIP) {
    return cachedPrivateIP;
  }
  
  // Calculer et mettre en cache
  const privateIP = getPrivateIPInternal();
  cachedPrivateIP = privateIP;
  return privateIP;
}

/**
 * Liste toutes les interfaces réseau disponibles (pour debug)
 */
function listNetworkInterfaces(): void {
  const networkInterfaces = os.networkInterfaces();
  const defaultRoute = getDefaultRouteInterface();
  
  console.log('[network] 📋 Interfaces réseau disponibles:');
  for (const interfaceName in networkInterfaces) {
    const addresses = networkInterfaces[interfaceName];
    for (const addressInfo of addresses) {
      if (addressInfo.family === 'IPv4') {
        let status = '';
        if (defaultRoute && interfaceName === defaultRoute.interface) {
          status = '✅ Route par défaut';
        } else if (shouldIgnoreInterface(interfaceName)) {
          status = '🚫 Ignoré';
        }
        console.log(`  - ${interfaceName}: ${addressInfo.address} ${status}`);
      }
    }
  }
  
  if (defaultRoute) {
    console.log(`[network] 🎯 Interface active: ${defaultRoute.interface} → ${defaultRoute.ip}`);
  }
}

export = { getLocalIP, getPrivateIP, waitForWifiInterface, listNetworkInterfaces };
