# Ryvie Security Implementation

## Overview
This document outlines the comprehensive security measures implemented in the Ryvie application to protect against common attack vectors and ensure secure authentication.

## Security Features Implemented

### 1. Authentication Security

#### Backend (Node.js/Express)
- **Rate Limiting**: Express-rate-limit with custom configurations
  - Authentication endpoints: 5 attempts per 15 minutes per IP+UID
  - General API: 100 requests per 15 minutes per IP
- **Brute Force Protection**: Redis-based tracking
  - Blocks users after 5 failed attempts for 15 minutes
  - Tracks attempts by UID + IP combination
  - Automatic cleanup on successful authentication
- **LDAP Security**: 
  - Input sanitization and LDAP filter escaping
  - Exact UID matching with fallback to CN search
  - Secure DN binding to prevent unauthorized access

#### Frontend (React/Electron)
- **Client-side Rate Limiting**: 
  - 5 failed attempts trigger 15-minute block
  - Persistent storage using localStorage
  - Real-time countdown display
- **User Switching Protection**:
  - Separate attempt tracking per user session
  - 5-minute temporary blocks for user switching
  - Modal closure on excessive attempts

### 2. Data Protection

#### Encryption Utilities (`utils/security.js`)
- **AES-256-GCM Encryption**: For sensitive data at rest
- **PBKDF2 Key Derivation**: 100,000 iterations for password-based keys
- **Secure Random Generation**: Cryptographically secure keys and salts
- **JWT Format Validation**: Basic token structure verification

#### Security Headers
- **Helmet.js**: Comprehensive security headers
- **CORS Configuration**: Controlled cross-origin requests
- **Content Security Policy**: Disabled for API flexibility
- **Input Sanitization**: XSS and injection prevention

### 3. Session Management

#### JWT Token Security
- **Redis Token Allowlist**: Valid tokens stored in Redis
- **Token Expiration**: Configurable session timeouts
- **Secure Token Generation**: Cryptographically secure secrets
- **Authorization Header Management**: Proper token handling in requests

#### Window Management (Electron)
- **Secure Window Creation**: Token validation before window creation
- **Proper Window Lifecycle**: Safe window closing with existence checks
- **IPC Security**: Validated inter-process communication

## Configuration

### Environment Variables
Add these variables to your `.env` file:

```bash
# Security Configuration
ENCRYPTION_KEY=your-32-byte-base64-encoded-encryption-key-here
JWT_ENCRYPTION_KEY=your-jwt-encryption-key-here

# Rate Limiting
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX_ATTEMPTS=5
API_RATE_LIMIT_WINDOW_MS=900000
API_RATE_LIMIT_MAX_REQUESTS=100

# Brute Force Protection
BRUTE_FORCE_MAX_ATTEMPTS=5
BRUTE_FORCE_BLOCK_DURATION_MS=900000

# Session Security
SESSION_TIMEOUT_MS=3600000
MAX_CONCURRENT_SESSIONS=3
```

### Required Dependencies
Install these security packages:

```bash
# Backend
npm install express-rate-limit helmet bcrypt

# Frontend (already included)
# - crypto-js (if needed for additional client-side encryption)
```

## Security Best Practices Implemented

### 1. Input Validation
- ✅ LDAP filter escaping to prevent injection
- ✅ Input trimming and length limits
- ✅ Character sanitization for dangerous inputs
- ✅ JWT format validation

### 2. Rate Limiting & Brute Force Protection
- ✅ Multiple layers: Express middleware + Redis tracking
- ✅ IP + User combination tracking
- ✅ Progressive penalties (warnings → blocking)
- ✅ Automatic cleanup on success

### 3. Secure Communication
- ✅ Proper Authorization header management
- ✅ Token validation before sensitive operations
- ✅ Secure axios interceptor configuration
- ✅ Error handling without information leakage

### 4. Frontend Security
- ✅ Client-side attempt tracking
- ✅ Persistent security state
- ✅ User feedback on security actions
- ✅ Secure window management in Electron

## Attack Vectors Mitigated

### 1. Brute Force Attacks
- **Server-side**: Express-rate-limit + Redis tracking
- **Client-side**: localStorage-based blocking
- **Protection**: Progressive delays and account locking

### 2. LDAP Injection
- **Input Escaping**: All LDAP filter values escaped
- **DN Validation**: Exact UID matching prevents unauthorized binds
- **Error Handling**: Generic error messages prevent information disclosure

### 3. Session Hijacking
- **JWT Security**: Tokens stored in Redis allowlist
- **Secure Headers**: Helmet.js security headers
- **Token Validation**: Proper token lifecycle management

### 4. DoS/DDoS
- **Rate Limiting**: Multiple layers of request limiting
- **Resource Protection**: Timeout configurations
- **Graceful Degradation**: Redis fallback handling

## Monitoring & Logging

### Security Events Logged
- Failed authentication attempts with IP tracking
- Brute force protection triggers
- Rate limit violations
- LDAP authentication errors
- Token validation failures

### Recommended Monitoring
- Monitor Redis for brute force patterns
- Track rate limit violations
- Alert on excessive failed attempts
- Monitor LDAP connection health

## Production Recommendations

### 1. Environment Security
- Use strong, unique encryption keys
- Enable HTTPS in production
- Configure proper CORS origins
- Set secure session timeouts

### 2. Infrastructure
- Use Redis persistence for brute force data
- Implement log rotation and monitoring
- Configure firewall rules
- Regular security updates

### 3. Operational Security
- Regular key rotation
- Monitor security logs
- Implement alerting for security events
- Regular security assessments

## Testing Security Features

### 1. Authentication Testing
```bash
# Test rate limiting
curl -X POST http://localhost:3001/api/authenticate \
  -H "Content-Type: application/json" \
  -d '{"uid":"testuser","password":"wrongpassword"}'
# Repeat 6 times to trigger rate limit
```

### 2. Brute Force Testing
- Attempt login with wrong credentials 5+ times
- Verify blocking message and countdown
- Test automatic unblocking after timeout

### 3. Frontend Testing
- Test login attempt counting
- Verify localStorage persistence
- Test user switching limits

## Security Maintenance

### Regular Tasks
- [ ] Review and rotate encryption keys
- [ ] Update security dependencies
- [ ] Monitor security logs
- [ ] Test security features
- [ ] Review rate limit configurations

### Security Updates
- Keep dependencies updated
- Monitor security advisories
- Regular penetration testing
- Code security reviews

## Contact & Support
For security issues or questions, please contact the development team.

---
*Last updated: 2025-08-04*
*Security implementation version: 1.0*
