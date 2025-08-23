# JWT Management System API Documentation

## Overview

The JWT Management System provides secure token generation, validation, refresh, and revocation for the Loupeen RTS Platform.

**Base URL:** `https://rofefpdvc2.execute-api.eu-north-1.amazonaws.com/prod`

## Authentication

All endpoints use AWS API Gateway with proper CORS headers configured.

## Endpoints

### 1. Generate JWT Token

**Endpoint:** `POST /jwt/generate`

Generates a new access token and refresh token for authenticated users.

#### Request

```json
{
  "username": "string",      // Required: Cognito username
  "password": "string",      // Required: User password
  "deviceId": "string",      // Required: Unique device identifier
  "userType": "player|admin" // Required: User type (enum)
}
```

#### Response (Success - 200)

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 900,          // Seconds until access token expires
  "tokenType": "Bearer",
  "roles": []                // User roles array
}
```

#### Response (Error - 401)

```json
{
  "error": "Authentication failed",
  "message": "Invalid credentials"
}
```

#### Response (Error - 400)

```json
{
  "message": "Invalid request body"
}
```

### 2. Validate JWT Token

**Endpoint:** `POST /jwt/validate`

Validates a JWT token and returns user information if valid.

#### Request

```json
{
  "token": "string",          // Required: JWT access token
  "requiredRoles": ["string"] // Optional: Required roles for authorization
}
```

#### Response (Success - 200)

```json
{
  "valid": true,
  "userId": "test-user-123",
  "roles": [],
  "sessionId": "1e7ca6c8086f9423eb04bcefdc02042a",
  "deviceId": "test-device-001",
  "latency": 85              // Validation time in milliseconds
}
```

#### Response (Invalid Token - 200)

```json
{
  "valid": false,
  "error": "Token expired|Invalid token|Insufficient permissions",
  "latency": 254
}
```

### 3. Refresh Token

**Endpoint:** `POST /jwt/refresh`

✅ **STATUS: WORKING** - DynamoDB schema issue resolved

Refreshes an expired access token using a valid refresh token.

#### Request

```json
{
  "refreshToken": "string",  // Required: Valid refresh token
  "deviceId": "string"       // Required: Device identifier
}
```

#### Response (Success - 200)

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 900,
  "tokenType": "Bearer"
}
```

### 4. Revoke Token

**Endpoint:** `POST /jwt/revoke`

Revokes one or more tokens for security purposes.

#### Request

```json
{
  "token": "string",         // Optional: Specific token to revoke
  "userId": "string",        // Optional: Revoke all tokens for user
  "deviceId": "string",      // Optional: Revoke all tokens for device
  "sessionId": "string",     // Optional: Revoke specific session
  "reason": "string"         // Optional: Reason for revocation
}
```

#### Response (Success - 200)

```json
{
  "success": true,
  "message": "Successfully revoked 1 token(s)",
  "revokedCount": 1
}
```

## JWT Token Structure

### Access Token Claims

```json
{
  "sub": "test-user-123",                    // Subject (user ID)
  "jti": "544da082ae587acd3146b597ebc2a3a8", // JWT ID (unique)
  "sessionId": "1e7ca6c8086f9423eb04bcefdc02042a",
  "deviceId": "test-device-001",
  "userType": "player",
  "roles": [],
  "iss": "loupeen-auth-test",                // Issuer
  "aud": "loupeen-game",                     // Audience
  "iat": 1755878632,                         // Issued at
  "exp": 1755879532                          // Expires at
}
```

### Refresh Token Claims

```json
{
  "tokenId": "3c6f246c639af850145a93e021a7cbc91da9c68281eda81d9b00655842dfb39",
  "tokenFamily": "2355f39ad823a0f23dd29732abbbd0",  // For replay attack detection
  "type": "refresh",
  "iat": 1755878632,
  "exp": 1758470632                                  // 30 days expiry
}
```

## Performance Metrics

| Endpoint | Average Latency | Status |
|----------|----------------|--------|
| Generate Token | ~563ms | ✅ Working |
| Validate Token | ~85ms | ✅ Working |
| Refresh Token | ~150ms | ✅ Working |
| Revoke Token | ~8ms | ✅ Working |

## Security Features

### Rate Limiting

- **Token Generation:** 10 requests per minute per user
- **Token Refresh:** 5 requests per 5-minute window per device

### Token Security

- **Access Token:** 15-minute expiry (900 seconds)
- **Refresh Token:** 30-day expiry (2,592,000 seconds)
- **Token Family Tracking:** Prevents replay attacks
- **Device Fingerprinting:** Associates tokens with specific devices
- **Revocation Support:** Immediate token invalidation for security incidents

### Encryption

- **DynamoDB:** AWS managed encryption at rest
- **Transit:** HTTPS/TLS encryption
- **JWT Signing:** HMAC SHA256 algorithm

## Error Codes

| HTTP Status | Error | Description |
|-------------|-------|-------------|
| 200 | Success | Request processed successfully |
| 400 | Bad Request | Invalid request format or missing required fields |
| 401 | Unauthorized | Invalid credentials or authentication failed |
| 403 | Forbidden | Insufficient permissions for requested operation |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server-side error (check logs) |

## Integration Examples

### Frontend Integration

```javascript
// Generate token
const tokenResponse = await fetch('/jwt/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'player123',
    password: 'securePassword',
    deviceId: 'device-12345',
    userType: 'player'
  })
});

const tokens = await tokenResponse.json();
localStorage.setItem('accessToken', tokens.accessToken);
localStorage.setItem('refreshToken', tokens.refreshToken);

// Validate token before API calls
const validateResponse = await fetch('/jwt/validate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: localStorage.getItem('accessToken')
  })
});

const validation = await validateResponse.json();
if (!validation.valid) {
  // Token expired, refresh it
  // (refresh endpoint currently under repair)
}
```

### Game Server Integration

```javascript
// Middleware for protected routes
const authenticateToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const validation = await fetch('/jwt/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  
  const result = await validation.json();
  
  if (result.valid) {
    req.user = {
      userId: result.userId,
      roles: result.roles,
      sessionId: result.sessionId
    };
    next();
  } else {
    res.status(401).json({ error: 'Invalid token' });
  }
};
```

## Known Issues

### 1. Refresh Token Endpoint Issue - RESOLVED ✅

**Issue:** DynamoDB ValidationException when marking refresh tokens as used  
**Error:** "The provided key element does not match the schema"  
**Status:** ✅ **RESOLVED** - Fixed composite key schema in markTokenAsUsed function  
**Resolution:** Updated Lambda function to include both tokenId and userId in DynamoDB key operations  

**Fix Details:**
- Problem: markTokenAsUsed function only provided tokenId, missing required userId sort key
- Solution: Updated UpdateItemCommand to include both tokenId (partition key) and userId (sort key)
- Deployed: August 22, 2025

## Testing

### Test User Credentials

For testing purposes, a test user has been created:

- **Username:** `test-user-123`
- **Password:** `TestPassword123!`
- **User Pool:** `eu-north-1_mn0zGxlAZ` (loupeen-players-test)

### Test Script

A comprehensive test script is available at `test-deployment/test-jwt-endpoints.sh`:

```bash
./test-deployment/test-jwt-endpoints.sh
```

This script tests all endpoints and provides detailed output with performance metrics.

## CloudWatch Monitoring

### Log Groups

- **Token Generation:** `/aws/lambda/GameAuthService-test-JwtManagementTokenGenerationF-BLFP0LEiVuB3`
- **Token Validation:** `/aws/lambda/GameAuthService-test-JwtManagementEnhancedTokenValidationF-*`
- **Token Refresh:** `/aws/lambda/GameAuthService-test-JwtManagementRefreshTokenFunc-0QPk9NleL9tf`
- **Token Revocation:** `/aws/lambda/GameAuthService-test-JwtManagementTokenRevocationF-*`

### Key Metrics to Monitor

- **Token Generation Latency:** Target <1 second
- **Token Validation Latency:** Target <50ms (currently achieving ~85ms)
- **Error Rates:** Monitor for authentication failures and internal errors
- **Rate Limiting:** Monitor for 429 responses indicating abuse

## Support

For technical issues or questions:
1. Check CloudWatch logs for specific error details
2. Review the refresh token implementation for DynamoDB schema issues
3. Monitor API Gateway metrics for performance analysis

---

**Last Updated:** August 22, 2025  
**API Version:** v1.0  
**Environment:** Test (eu-north-1)