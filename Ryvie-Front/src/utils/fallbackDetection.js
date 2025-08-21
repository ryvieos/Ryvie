/**
 * Détection de fallback plus robuste avec gestion d'erreurs avancée
 * Gère les cas où les serveurs ne sont pas accessibles ou n'ont pas CORS configuré
 */

const { getServerUrl } = require('../config/urls');

/**
 * Teste la connectivité avec une approche progressive
 * 1. Test simple sans credentials
 * 2. Test avec une requête HEAD si disponible
 * 3. Fallback vers mode public si tout échoue
 */
export async function detectAccessModeRobust(timeout = 3000) {
  console.log('[FallbackDetection] Démarrage de la détection robuste...');
  
  // Test 1: Tentative de connexion simple au serveur privé
  const privateAccessible = await testSimpleConnectivity('private', timeout);
  if (privateAccessible) {
    console.log('[FallbackDetection] Serveur privé accessible - Mode PRIVATE');
    localStorage.setItem('accessMode', 'private');
    return 'private';
  }
  
  // Test 2: Vérifier si le serveur public est accessible
  const publicAccessible = await testSimpleConnectivity('public', timeout);
  if (publicAccessible) {
    console.log('[FallbackDetection] Serveur public accessible - Mode PUBLIC');
    localStorage.setItem('accessMode', 'public');
    return 'public';
  }
  
  // Fallback: Si aucun serveur n'est accessible, utiliser le mode public par défaut
  console.log('[FallbackDetection] Aucun serveur accessible - Fallback vers PUBLIC');
  localStorage.setItem('accessMode', 'public');
  return 'public';
}

/**
 * Test de connectivité simple avec gestion d'erreurs
 */
async function testSimpleConnectivity(mode, timeout = 2000) {
  const serverUrl = getServerUrl(mode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    console.log(`[FallbackDetection] Test ${mode}: ${serverUrl}`);
    
    // Essayer d'abord avec une requête HEAD (plus légère)
    let response;
    try {
      response = await fetch(`${serverUrl}/api/server-info`, {
        method: 'HEAD',
        mode: 'no-cors', // Éviter les problèmes CORS pour le test
        signal: controller.signal
      });
    } catch (headError) {
      // Si HEAD échoue, essayer avec GET
      response = await fetch(`${serverUrl}/api/server-info`, {
        method: 'GET',
        mode: 'no-cors',
        signal: controller.signal
      });
    }
    
    clearTimeout(timeoutId);
    
    // En mode no-cors, response.ok n'est pas fiable, on vérifie juste que la requête n'a pas échoué
    console.log(`[FallbackDetection] ${mode} - Réponse reçue (type: ${response.type})`);
    return true;
    
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      console.log(`[FallbackDetection] ${mode} - Timeout`);
    } else {
      console.log(`[FallbackDetection] ${mode} - Erreur: ${error.message}`);
    }
    
    return false;
  }
}

/**
 * Test de connectivité avec CORS approprié (pour les requêtes réelles)
 */
export async function testCorsConnectivity(mode, timeout = 2000) {
  const serverUrl = getServerUrl(mode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(`${serverUrl}/api/server-info`, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json'
      }
    });
    
    clearTimeout(timeoutId);
    return response.ok;
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.log(`[FallbackDetection] CORS test ${mode} échoué:`, error.message);
    return false;
  }
}

/**
 * Détection avec retry automatique
 */
export async function detectWithRetry(maxRetries = 2, timeout = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[FallbackDetection] Tentative ${attempt}/${maxRetries}`);
    
    try {
      const result = await detectAccessModeRobust(timeout);
      return result;
    } catch (error) {
      console.log(`[FallbackDetection] Tentative ${attempt} échouée:`, error.message);
      
      if (attempt === maxRetries) {
        console.log('[FallbackDetection] Toutes les tentatives ont échoué - Fallback vers PUBLIC');
        localStorage.setItem('accessMode', 'public');
        return 'public';
      }
      
      // Attendre un peu avant la prochaine tentative
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
