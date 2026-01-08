import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;

type AccessMode = 'private' | 'public';

export async function detectAccessModeRobust(timeout: number = 3000): Promise<AccessMode> {
  console.log('[FallbackDetection] Démarrage de la détection robuste...');
  
  const privateAccessible = await testSimpleConnectivity('private', timeout);
  if (privateAccessible) {
    console.log('[FallbackDetection] Serveur privé accessible - Mode PRIVATE');
    localStorage.setItem('accessMode', 'private');
    return 'private';
  }
  
  const publicAccessible = await testSimpleConnectivity('public', timeout);
  if (publicAccessible) {
    console.log('[FallbackDetection] Serveur remote accessible - Mode REMOTE');
    localStorage.setItem('accessMode', 'public');
    return 'public';
  }
  
  console.log('[FallbackDetection] Aucun serveur accessible - Fallback vers REMOTE');
  localStorage.setItem('accessMode', 'public');
  return 'public';
}

async function testSimpleConnectivity(mode: AccessMode, timeout: number = 2000): Promise<boolean> {
  const serverUrl = getServerUrl(mode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    console.log(`[FallbackDetection] Test ${mode}: ${serverUrl}`);
    
    let response: Response;
    try {
      response = await fetch(`${serverUrl}/api/server-info`, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal
      });
    } catch (headError) {
      response = await fetch(`${serverUrl}/api/server-info`, {
        method: 'GET',
        mode: 'no-cors',
        signal: controller.signal
      });
    }
    
    clearTimeout(timeoutId);
    
    console.log(`[FallbackDetection] ${mode} - Réponse reçue (type: ${response.type})`);
    return true;
    
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      console.log(`[FallbackDetection] ${mode} - Timeout`);
    } else {
      console.log(`[FallbackDetection] ${mode} - Erreur: ${error.message}`);
    }
    
    return false;
  }
}

export async function testCorsConnectivity(mode: AccessMode, timeout: number = 2000): Promise<boolean> {
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
    
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.log(`[FallbackDetection] CORS test ${mode} échoué:`, error.message);
    return false;
  }
}

export async function detectWithRetry(maxRetries: number = 2, timeout: number = 2000): Promise<AccessMode> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[FallbackDetection] Tentative ${attempt}/${maxRetries}`);
    
    try {
      const result = await detectAccessModeRobust(timeout);
      return result;
    } catch (error: any) {
      console.log(`[FallbackDetection] Tentative ${attempt} échouée:`, error.message);
      
      if (attempt === maxRetries) {
        console.log('[FallbackDetection] Toutes les tentatives ont échoué - Fallback vers REMOTE');
        localStorage.setItem('accessMode', 'public');
        return 'public';
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return 'public';
}
