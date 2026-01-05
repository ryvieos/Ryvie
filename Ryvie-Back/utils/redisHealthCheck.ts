export {};
const { execSync } = require('child_process');

/**
 * Check if Redis is running and restart it if down
 * @returns Promise<boolean> - true if Redis is running or was successfully restarted
 */
async function ensureRedisRunning(): Promise<boolean> {
  try {
    console.log('🔍 Vérification du statut de Redis...');
    
    // Check Redis status
    try {
      const status = execSync('systemctl is-active redis-server', { encoding: 'utf8' }).trim();
      if (status === 'active') {
        console.log('✅ Redis est déjà en cours d\'exécution');
        return true;
      }
    } catch (statusError) {
      console.log('⚠️  Redis n\'est pas actif, tentative de redémarrage...');
    }
    
    // Try to restart Redis
    try {
      execSync('sudo systemctl restart redis-server', { stdio: 'inherit' });
      console.log('✅ Redis a été redémarré avec succès');
      
      // Wait a moment for Redis to fully start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify it's running
      const status = execSync('systemctl is-active redis-server', { encoding: 'utf8' }).trim();
      if (status === 'active') {
        console.log('✅ Redis est maintenant actif');
        return true;
      } else {
        console.error('❌ Redis n\'a pas démarré correctement');
        return false;
      }
    } catch (restartError: any) {
      console.error('❌ Erreur lors du redémarrage de Redis:', restartError.message);
      return false;
    }
  } catch (error: any) {
    console.error('❌ Erreur lors de la vérification de Redis:', error.message);
    return false;
  }
}

module.exports = { ensureRedisRunning };
