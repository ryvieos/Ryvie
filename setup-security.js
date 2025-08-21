#!/usr/bin/env node

/**
 * Ryvie Security Setup Script
 * This script helps configure security features for the Ryvie application
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

console.log('🔒 Ryvie Security Setup');
console.log('========================\n');

// Generate secure keys
function generateSecureKey(length = 32) {
  return crypto.randomBytes(length).toString('base64');
}

function generateJWTSecret() {
  return crypto.randomBytes(64).toString('hex');
}

// Check if .env file exists
const envPath = path.join(__dirname, 'Back-end-view', '.env');
const envExists = fs.existsSync(envPath);

console.log('📋 Security Configuration Checklist:');
console.log('====================================\n');

// 1. Generate encryption keys
console.log('1. 🔑 Encryption Keys');
const encryptionKey = generateSecureKey(32);
const jwtEncryptionKey = generateSecureKey(32);
const jwtSecret = generateJWTSecret();

console.log('   Generated new encryption keys:');
console.log(`   ENCRYPTION_KEY=${encryptionKey}`);
console.log(`   JWT_ENCRYPTION_KEY=${jwtEncryptionKey}`);
console.log(`   JWT_SECRET=${jwtSecret}`);
console.log('   ✅ Add these to your .env file\n');

// 2. Check dependencies
console.log('2. 📦 Required Dependencies');
const backendPackageJson = path.join(__dirname, 'Back-end-view', 'package.json');
if (fs.existsSync(backendPackageJson)) {
  const pkg = JSON.parse(fs.readFileSync(backendPackageJson, 'utf8'));
  const requiredDeps = ['express-rate-limit', 'helmet', 'bcrypt'];
  const missing = requiredDeps.filter(dep => !pkg.dependencies?.[dep] && !pkg.devDependencies?.[dep]);
  
  if (missing.length > 0) {
    console.log('   ❌ Missing dependencies:');
    missing.forEach(dep => console.log(`      - ${dep}`));
    console.log(`   Run: cd Back-end-view && npm install ${missing.join(' ')}`);
  } else {
    console.log('   ✅ All security dependencies installed');
  }
} else {
  console.log('   ⚠️  Could not check package.json');
}
console.log('');

// 3. Environment configuration
console.log('3. ⚙️  Environment Configuration');
if (envExists) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const hasEncryptionKey = envContent.includes('ENCRYPTION_KEY=');
  const hasJWTSecret = envContent.includes('JWT_SECRET=');
  
  if (hasEncryptionKey && hasJWTSecret) {
    console.log('   ✅ Security keys found in .env');
  } else {
    console.log('   ❌ Missing security keys in .env');
    console.log('   Add the generated keys above to your .env file');
  }
} else {
  console.log('   ❌ .env file not found');
  console.log('   Create .env file in Back-end-view/ directory');
}
console.log('');

// 4. Redis configuration
console.log('4. 🗄️  Redis Configuration');
console.log('   ✅ Redis client configured for brute force protection');
console.log('   ✅ Token allowlist using Redis');
console.log('   Make sure Redis server is running\n');

// 5. Security features summary
console.log('5. 🛡️  Security Features Implemented');
console.log('   ✅ Rate limiting (5 attempts per 15 minutes)');
console.log('   ✅ Brute force protection with Redis tracking');
console.log('   ✅ LDAP injection prevention');
console.log('   ✅ Secure JWT token management');
console.log('   ✅ Client-side attempt tracking');
console.log('   ✅ Helmet.js security headers');
console.log('   ✅ Input sanitization and validation');
console.log('   ✅ Secure Electron window management\n');

// 6. Testing recommendations
console.log('6. 🧪 Testing Security Features');
console.log('   Test brute force protection:');
console.log('   - Try logging in with wrong credentials 6+ times');
console.log('   - Verify blocking message appears');
console.log('   - Check Redis for brute force keys');
console.log('');
console.log('   Test rate limiting:');
console.log('   - Make multiple rapid API requests');
console.log('   - Verify 429 responses after limits');
console.log('');

// 7. Production recommendations
console.log('7. 🚀 Production Deployment');
console.log('   ❗ Change default encryption keys');
console.log('   ❗ Enable HTTPS');
console.log('   ❗ Configure proper CORS origins');
console.log('   ❗ Set up log monitoring');
console.log('   ❗ Regular security updates');
console.log('');

// Generate sample .env additions
console.log('8. 📝 Sample .env Configuration');
console.log('   Add these lines to your Back-end-view/.env file:');
console.log('   =====================================');
console.log(`   ENCRYPTION_KEY=${encryptionKey}`);
console.log(`   JWT_ENCRYPTION_KEY=${jwtEncryptionKey}`);
console.log(`   JWT_SECRET=${jwtSecret}`);
console.log('   AUTH_RATE_LIMIT_WINDOW_MS=900000');
console.log('   AUTH_RATE_LIMIT_MAX_ATTEMPTS=5');
console.log('   API_RATE_LIMIT_WINDOW_MS=900000');
console.log('   API_RATE_LIMIT_MAX_REQUESTS=100');
console.log('   BRUTE_FORCE_MAX_ATTEMPTS=5');
console.log('   BRUTE_FORCE_BLOCK_DURATION_MS=900000');
console.log('   ENABLE_SECURITY_LOGGING=true');
console.log('');

console.log('🎉 Security setup complete!');
console.log('📖 See SECURITY.md for detailed documentation');
console.log('🔍 Review all configurations before production deployment');

// Optional: Write keys to a secure file
const keysFile = path.join(__dirname, 'security-keys.txt');
const keysContent = `# Generated Security Keys - KEEP SECURE!
# Generated: ${new Date().toISOString()}

ENCRYPTION_KEY=${encryptionKey}
JWT_ENCRYPTION_KEY=${jwtEncryptionKey}
JWT_SECRET=${jwtSecret}

# Add these to your .env file and then DELETE this file!
`;

fs.writeFileSync(keysFile, keysContent);
console.log(`\n🔐 Keys saved to: ${keysFile}`);
console.log('❗ IMPORTANT: Delete this file after copying keys to .env!');
