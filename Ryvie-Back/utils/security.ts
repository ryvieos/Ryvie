const crypto = require('crypto');

// Security configuration
const SECURITY_CONFIG = {
  ENCRYPTION_ALGORITHM: 'aes-256-gcm',
  KEY_LENGTH: 32,
  IV_LENGTH: 16,
  TAG_LENGTH: 16,
  HASH_ALGORITHM: 'sha256',
  PBKDF2_ITERATIONS: 100000
};

/**
 * Generate a secure random key
 * @returns {string} Base64 encoded key
 */
function generateSecureKey() {
  return crypto.randomBytes(SECURITY_CONFIG.KEY_LENGTH).toString('base64');
}

/**
 * Derive encryption key from password using PBKDF2
 * @param {string} password 
 * @param {string} salt 
 * @returns {Buffer} Derived key
 */
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(
    password, 
    salt, 
    SECURITY_CONFIG.PBKDF2_ITERATIONS, 
    SECURITY_CONFIG.KEY_LENGTH, 
    SECURITY_CONFIG.HASH_ALGORITHM
  );
}

/**
 * Encrypt sensitive data
 * @param {string} plaintext 
 * @param {string} key Base64 encoded key
 * @returns {object} Encrypted data with iv and tag
 */
function encryptData(plaintext, key) {
  try {
    const keyBuffer = Buffer.from(key, 'base64');
    const iv = crypto.randomBytes(SECURITY_CONFIG.IV_LENGTH);
    const cipher = crypto.createCipher(SECURITY_CONFIG.ENCRYPTION_ALGORITHM, keyBuffer, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    const tag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('base64'),
      tag: tag.toString('base64')
    };
  } catch (error: any) {
    console.error('[security] Encryption failed:', error);
    throw new Error('Encryption failed');
  }
}

/**
 * Decrypt sensitive data
 * @param {object} encryptedData Object with encrypted, iv, and tag
 * @param {string} key Base64 encoded key
 * @returns {string} Decrypted plaintext
 */
function decryptData(encryptedData, key) {
  try {
    const keyBuffer = Buffer.from(key, 'base64');
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const tag = Buffer.from(encryptedData.tag, 'base64');
    
    const decipher = crypto.createDecipher(SECURITY_CONFIG.ENCRYPTION_ALGORITHM, keyBuffer, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encryptedData.encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error: any) {
    console.error('[security] Decryption failed:', error);
    throw new Error('Decryption failed');
  }
}

/**
 * Hash sensitive data (one-way)
 * @param {string} data 
 * @param {string} salt Optional salt
 * @returns {string} Hashed data
 */
function hashData(data, salt = '') {
  return crypto
    .createHash(SECURITY_CONFIG.HASH_ALGORITHM)
    .update(data + salt)
    .digest('hex');
}

/**
 * Generate secure random salt
 * @returns {string} Base64 encoded salt
 */
function generateSalt() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Sanitize input to prevent injection attacks
 * @param {string} input 
 * @returns {string} Sanitized input
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  
  return input
    .trim()
    .replace(/[<>'"&]/g, '') // Remove potentially dangerous characters
    .substring(0, 255); // Limit length
}

/**
 * Validate JWT token format (basic check)
 * @param {string} token 
 * @returns {boolean} True if format is valid
 */
function isValidJWTFormat(token) {
  if (!token || typeof token !== 'string') return false;
  
  const parts = token.split('.');
  return parts.length === 3 && parts.every(part => part.length > 0);
}

/**
 * Generate secure session ID
 * @returns {string} Secure session ID
 */
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Rate limiting helper - check if action is allowed
 * @param {string} key Unique key for the action
 * @param {number} maxAttempts Maximum attempts allowed
 * @param {number} windowMs Time window in milliseconds
 * @param {Map} store In-memory store for tracking
 * @returns {object} { allowed: boolean, remaining: number, resetTime: number }
 */
function checkRateLimit(key, maxAttempts, windowMs, store) {
  const now = Date.now();
  const record = store.get(key) || { count: 0, resetTime: now + windowMs };
  
  // Reset if window has passed
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + windowMs;
  }
  
  const allowed = record.count < maxAttempts;
  if (!allowed) {
    store.set(key, record);
    return {
      allowed: false,
      remaining: 0,
      resetTime: record.resetTime
    };
  }
  
  record.count++;
  store.set(key, record);
  
  return {
    allowed: true,
    remaining: maxAttempts - record.count,
    resetTime: record.resetTime
  };
}

export = {
  generateSecureKey,
  deriveKey,
  encryptData,
  decryptData,
  hashData,
  generateSalt,
  sanitizeInput,
  isValidJWTFormat,
  generateSessionId,
  checkRateLimit,
  SECURITY_CONFIG
};
