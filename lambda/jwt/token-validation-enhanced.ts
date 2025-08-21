import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { createHash } from 'crypto';

const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });

// JWKS client with caching for performance
const jwksClients: { [key: string]: jwksClient.JwksClient } = {};

interface TokenValidationRequest {
  token: string;
  requiredRoles?: string[];
  validateDevice?: boolean;
}

interface TokenValidationResponse {
  valid: boolean;
  userId?: string;
  playerId?: string;
  allianceId?: string;
  roles?: string[];
  sessionId?: string;
  deviceId?: string;
  error?: string;
  latency?: number;
}

interface JWTPayload {
  sub: string;
  jti: string;
  sessionId: string;
  deviceId: string;
  userType: string;
  playerId?: string;
  allianceId?: string;
  roles?: string[];
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

// Cache for JWKS keys
const keyCache = new Map<string, string>();
const CACHE_TTL = parseInt(process.env.JWKS_CACHE_TTL || '3600') * 1000;
const lastCacheUpdate = new Map<string, number>();

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  console.log('Enhanced token validation request', { 
    path: event.path,
    headers: event.headers 
  });

  try {
    const body = JSON.parse(event.body || '{}') as TokenValidationRequest;
    const { token, requiredRoles = [], validateDevice = false } = body;

    if (!token) {
      return createResponse(400, {
        valid: false,
        error: 'Token is required',
        latency: Date.now() - startTime
      });
    }

    // Decode token header to determine which user pool to use
    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader) {
      return createResponse(401, {
        valid: false,
        error: 'Invalid token format',
        latency: Date.now() - startTime
      });
    }

    // Verify token signature
    let decoded: JWTPayload;
    try {
      // For development, use symmetric key. For production, use JWKS
      if (process.env.ENVIRONMENT === 'production') {
        decoded = await verifyWithJWKS(token, decodedHeader);
      } else {
        decoded = jwt.verify(token, getSigningKey()) as JWTPayload;
      }
    } catch (error: any) {
      console.error('Token verification failed', { error: error.message });
      return createResponse(401, {
        valid: false,
        error: error.message === 'jwt expired' ? 'Token expired' : 'Invalid token signature',
        latency: Date.now() - startTime
      });
    }

    // Check if token is revoked
    const isRevoked = await checkTokenRevocation(decoded.jti);
    if (isRevoked) {
      console.warn('Revoked token used', { jti: decoded.jti, userId: decoded.sub });
      return createResponse(401, {
        valid: false,
        error: 'Token has been revoked',
        latency: Date.now() - startTime
      });
    }

    // Validate session
    const sessionValid = await validateSession(decoded.sessionId, decoded.deviceId, validateDevice);
    if (!sessionValid) {
      return createResponse(401, {
        valid: false,
        error: 'Session invalid or expired',
        latency: Date.now() - startTime
      });
    }

    // Check required roles
    const userRoles = decoded.roles || [];
    const hasRequiredRoles = requiredRoles.length === 0 || 
      requiredRoles.every(role => userRoles.includes(role));

    if (!hasRequiredRoles) {
      return createResponse(403, {
        valid: false,
        error: 'Insufficient permissions',
        latency: Date.now() - startTime
      });
    }

    // Token is valid
    const latency = Date.now() - startTime;
    console.log('Token validation successful', {
      userId: decoded.sub,
      playerId: decoded.playerId,
      sessionId: decoded.sessionId,
      latency
    });

    // Check if we're meeting performance requirements
    if (latency > 50) {
      console.warn('Token validation latency exceeded 50ms', { latency });
    }

    return createResponse(200, {
      valid: true,
      userId: decoded.sub,
      playerId: decoded.playerId,
      allianceId: decoded.allianceId,
      roles: userRoles,
      sessionId: decoded.sessionId,
      deviceId: decoded.deviceId,
      latency
    } as TokenValidationResponse);

  } catch (error) {
    console.error('Token validation error', error);
    return createResponse(500, {
      valid: false,
      error: 'Internal server error',
      latency: Date.now() - startTime
    });
  }
};

async function verifyWithJWKS(token: string, decodedHeader: any): Promise<JWTPayload> {
  const userPoolId = decodedHeader.payload.userType === 'admin' 
    ? process.env.ADMIN_USER_POOL_ID 
    : process.env.PLAYER_USER_POOL_ID;

  const region = process.env.REGION || 'us-east-1';
  const jwksUri = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;

  // Get or create JWKS client
  if (!jwksClients[userPoolId!]) {
    jwksClients[userPoolId!] = jwksClient({
      jwksUri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: CACHE_TTL
    });
  }

  const client = jwksClients[userPoolId!];
  const kid = decodedHeader.header.kid;

  // Check cache
  const cacheKey = `${userPoolId}:${kid}`;
  const cachedKey = keyCache.get(cacheKey);
  const cacheAge = Date.now() - (lastCacheUpdate.get(cacheKey) || 0);

  let signingKey: string;
  if (cachedKey && cacheAge < CACHE_TTL) {
    signingKey = cachedKey;
  } else {
    // Fetch key from JWKS
    const key = await new Promise<jwksClient.SigningKey>((resolve, reject) => {
      client.getSigningKey(kid, (err: Error | null, key?: jwksClient.SigningKey) => {
        if (err) reject(err);
        else if (key) resolve(key);
        else reject(new Error('No key found'));
      });
    });

    signingKey = key.getPublicKey();
    
    // Update cache
    keyCache.set(cacheKey, signingKey);
    lastCacheUpdate.set(cacheKey, Date.now());
  }

  return jwt.verify(token, signingKey, {
    algorithms: ['RS256']
  }) as JWTPayload;
}

async function checkTokenRevocation(jti: string): Promise<boolean> {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: process.env.REVOKED_TOKENS_TABLE_NAME,
      Key: {
        jti: { S: jti }
      }
    }));

    return result.Item !== undefined;
  } catch (error) {
    console.error('Failed to check token revocation', error);
    return false; // Fail open for availability
  }
}

async function validateSession(
  sessionId: string, 
  deviceId: string, 
  validateDevice: boolean
): Promise<boolean> {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE_NAME,
      Key: {
        sessionId: { S: sessionId }
      }
    }));

    if (!result.Item) {
      return false;
    }

    // Check session expiration
    const expiresAt = parseInt(result.Item.expiresAt?.N || '0');
    if (expiresAt < Date.now()) {
      return false;
    }

    // Validate device if required
    if (validateDevice && result.Item.deviceId?.S !== deviceId) {
      console.warn('Device mismatch detected', {
        sessionId,
        expectedDevice: result.Item.deviceId?.S,
        actualDevice: deviceId
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error('Session validation failed', error);
    return false;
  }
}

function getSigningKey(): string {
  // In production, this should be fetched from AWS Secrets Manager or KMS
  return process.env.JWT_SIGNING_KEY || createHash('sha256')
    .update(`${process.env.ENVIRONMENT}-secret-key`)
    .digest('hex');
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    },
    body: JSON.stringify(body)
  };
}