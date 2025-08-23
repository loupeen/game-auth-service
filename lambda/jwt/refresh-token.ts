import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
  DynamoDBClient, 
  GetItemCommand, 
  PutItemCommand, 
  UpdateItemCommand,
  QueryCommand,
  BatchWriteItemCommand
} from '@aws-sdk/client-dynamodb';
import * as jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';

const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });

interface RefreshTokenRequest {
  refreshToken: string;
  deviceId: string;
}

interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

interface RefreshTokenPayload {
  tokenId: string;
  tokenFamily: string;
  type: string;
  iat: number;
  exp: number;
}

interface StoredRefreshToken {
  tokenId: string;
  userId: string;
  tokenFamily: string;
  deviceId: string;
  userType: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  replacedBy?: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  console.log('Refresh token request received', { 
    path: event.path,
    sourceIp: event.requestContext.identity.sourceIp
  });

  try {
    const body = JSON.parse(event.body || '{}') as RefreshTokenRequest;
    const { refreshToken, deviceId } = body;

    if (!refreshToken || !deviceId) {
      return createResponse(400, {
        error: 'Missing required fields',
        message: 'refreshToken and deviceId are required'
      });
    }

    // Decode and verify refresh token
    let decodedToken: RefreshTokenPayload;
    try {
      decodedToken = jwt.verify(refreshToken, getSigningKey()) as RefreshTokenPayload;
    } catch (error: any) {
      console.error('Refresh token verification failed', { error: error.message });
      return createResponse(401, {
        error: 'Invalid refresh token',
        message: error.message === 'jwt expired' ? 'Refresh token expired' : 'Invalid token'
      });
    }

    // Validate token type
    if (decodedToken.type !== 'refresh') {
      return createResponse(401, {
        error: 'Invalid token type',
        message: 'Not a refresh token'
      });
    }

    // Get stored refresh token from DynamoDB
    const storedToken = await getStoredRefreshToken(decodedToken.tokenId);
    
    if (!storedToken) {
      console.warn('Refresh token not found in database', { tokenId: decodedToken.tokenId });
      return createResponse(401, {
        error: 'Invalid refresh token',
        message: 'Token not found'
      });
    }

    // Check if token has already been used
    if (storedToken.used) {
      console.error('Refresh token reuse detected!', {
        tokenId: decodedToken.tokenId,
        tokenFamily: decodedToken.tokenFamily,
        userId: storedToken.userId
      });
      
      // Security breach: Revoke entire token family
      await revokeTokenFamily(decodedToken.tokenFamily);
      
      return createResponse(401, {
        error: 'Security violation',
        message: 'Refresh token has already been used. All tokens have been revoked.'
      });
    }

    // Validate device ID
    if (storedToken.deviceId !== deviceId) {
      console.warn('Device ID mismatch on refresh', {
        expected: storedToken.deviceId,
        actual: deviceId
      });
      return createResponse(401, {
        error: 'Device mismatch',
        message: 'Token not valid for this device'
      });
    }

    // Check expiration
    if (storedToken.expiresAt < Date.now()) {
      return createResponse(401, {
        error: 'Token expired',
        message: 'Refresh token has expired'
      });
    }

    // Rate limiting check
    const rateLimitKey = `refresh:${storedToken.userId}:${event.requestContext.identity.sourceIp}`;
    const rateLimitCheck = await checkRateLimit(rateLimitKey);
    
    if (!rateLimitCheck.allowed) {
      return createResponse(429, {
        error: 'Too many requests',
        retryAfter: rateLimitCheck.retryAfter
      });
    }

    // Mark old token as used
    await markTokenAsUsed(decodedToken.tokenId, storedToken.userId);

    // Generate new token pair
    const newTokens = await generateNewTokenPair(storedToken);

    // Update rate limit
    await updateRateLimit(rateLimitKey);

    console.log('Refresh token rotation successful', {
      userId: storedToken.userId,
      oldTokenId: decodedToken.tokenId,
      newTokenId: newTokens.tokenId,
      latency: Date.now() - startTime
    });

    return createResponse(200, {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      expiresIn: parseInt(process.env.JWT_ACCESS_TOKEN_EXPIRY || '900'),
      tokenType: 'Bearer'
    } as RefreshTokenResponse);

  } catch (error) {
    console.error('Refresh token error', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: 'Failed to refresh token'
    });
  }
};

async function getStoredRefreshToken(tokenId: string): Promise<StoredRefreshToken | null> {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
      KeyConditionExpression: 'tokenId = :tokenId',
      ExpressionAttributeValues: {
        ':tokenId': { S: tokenId }
      },
      Limit: 1
    }));

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    const item = result.Items[0];
    return {
      tokenId: item.tokenId.S!,
      userId: item.userId.S!,
      tokenFamily: item.tokenFamily.S!,
      deviceId: item.deviceId.S!,
      userType: item.userType.S!,
      createdAt: parseInt(item.createdAt.N!),
      expiresAt: parseInt(item.expiresAt.N!),
      used: item.used.BOOL!,
      replacedBy: item.replacedBy?.S
    };
  } catch (error) {
    console.error('Failed to get stored refresh token', error);
    throw error;
  }
}

async function markTokenAsUsed(tokenId: string, userId: string): Promise<void> {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
      Key: {
        tokenId: { S: tokenId },
        userId: { S: userId }
      },
      UpdateExpression: 'SET used = :true, usedAt = :now',
      ExpressionAttributeValues: {
        ':true': { BOOL: true },
        ':now': { N: Date.now().toString() }
      }
    }));
  } catch (error) {
    console.error('Failed to mark token as used', error);
    throw error;
  }
}

async function revokeTokenFamily(tokenFamily: string): Promise<void> {
  console.warn('Revoking entire token family due to security breach', { tokenFamily });
  
  try {
    // Query all tokens in the family
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
      IndexName: 'TokenFamilyIndex',
      KeyConditionExpression: 'tokenFamily = :family',
      ExpressionAttributeValues: {
        ':family': { S: tokenFamily }
      }
    }));

    if (!result.Items || result.Items.length === 0) {
      return;
    }

    // Batch update all tokens to mark them as revoked
    const updatePromises = result.Items.map(item => 
      dynamodb.send(new UpdateItemCommand({
        TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
        Key: {
          tokenId: { S: item.tokenId.S! },
          userId: { S: item.userId.S! }
        },
        UpdateExpression: 'SET revoked = :true, revokedAt = :now, revokedReason = :reason',
        ExpressionAttributeValues: {
          ':true': { BOOL: true },
          ':now': { N: Date.now().toString() },
          ':reason': { S: 'Token family compromised - possible replay attack' }
        }
      }))
    );

    await Promise.all(updatePromises);
    
    // Also invalidate all sessions for this user
    const userId = result.Items[0].userId.S!;
    await invalidateUserSessions(userId);
    
  } catch (error) {
    console.error('Failed to revoke token family', error);
    throw error;
  }
}

async function invalidateUserSessions(userId: string): Promise<void> {
  try {
    // In production, this would query and invalidate all sessions for the user
    console.log('Invalidating all sessions for user', { userId });
    
    // This is simplified - in production you'd query sessions by userId index
    await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE_NAME,
      Key: {
        sessionId: { S: userId } // This would need proper session lookup
      },
      UpdateExpression: 'SET invalidated = :true, invalidatedAt = :now',
      ExpressionAttributeValues: {
        ':true': { BOOL: true },
        ':now': { N: Date.now().toString() }
      }
    }));
  } catch (error) {
    console.error('Failed to invalidate user sessions', error);
  }
}

async function generateNewTokenPair(oldToken: StoredRefreshToken): Promise<any> {
  const jti = randomBytes(16).toString('hex');
  const sessionId = randomBytes(16).toString('hex');
  const newTokenId = randomBytes(32).toString('hex');

  // Create new access token claims
  const accessTokenClaims = {
    sub: oldToken.userId,
    jti,
    sessionId,
    deviceId: oldToken.deviceId,
    userType: oldToken.userType,
    // Additional claims would be fetched from user profile
    iss: `loupeen-auth-${process.env.ENVIRONMENT}`,
    aud: oldToken.userType === 'admin' ? 'loupeen-admin' : 'loupeen-game',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + parseInt(process.env.JWT_ACCESS_TOKEN_EXPIRY || '900')
  };

  const accessToken = jwt.sign(accessTokenClaims, getSigningKey(), {
    algorithm: 'HS256'
  });

  // Create new refresh token
  const refreshTokenData = {
    tokenId: newTokenId,
    userId: oldToken.userId,
    tokenFamily: oldToken.tokenFamily, // Keep same family for rotation tracking
    deviceId: oldToken.deviceId,
    userType: oldToken.userType,
    createdAt: Date.now(),
    expiresAt: Date.now() + (parseInt(process.env.JWT_REFRESH_TOKEN_EXPIRY || '2592000') * 1000),
    previousTokenId: oldToken.tokenId
  };

  const refreshToken = jwt.sign(
    {
      tokenId: refreshTokenData.tokenId,
      tokenFamily: refreshTokenData.tokenFamily,
      type: 'refresh'
    },
    getSigningKey(),
    {
      algorithm: 'HS256',
      expiresIn: parseInt(process.env.JWT_REFRESH_TOKEN_EXPIRY || '2592000')
    }
  );

  // Store new refresh token
  await dynamodb.send(new PutItemCommand({
    TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
    Item: {
      tokenId: { S: refreshTokenData.tokenId },
      userId: { S: refreshTokenData.userId },
      tokenFamily: { S: refreshTokenData.tokenFamily },
      deviceId: { S: refreshTokenData.deviceId },
      userType: { S: refreshTokenData.userType },
      createdAt: { N: refreshTokenData.createdAt.toString() },
      expiresAt: { N: refreshTokenData.expiresAt.toString() },
      used: { BOOL: false },
      previousTokenId: { S: refreshTokenData.previousTokenId }
    }
  }));

  // Update old token with reference to new token
  await dynamodb.send(new UpdateItemCommand({
    TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
    Key: {
      tokenId: { S: oldToken.tokenId },
      userId: { S: oldToken.userId }
    },
    UpdateExpression: 'SET replacedBy = :newTokenId',
    ExpressionAttributeValues: {
      ':newTokenId': { S: newTokenId }
    }
  }));

  return {
    accessToken,
    refreshToken,
    tokenId: newTokenId
  };
}

async function checkRateLimit(identifier: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const windowStart = Math.floor(Date.now() / 300000) * 300000; // 5-minute window for refresh
  
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.RATE_LIMIT_TABLE_NAME,
      KeyConditionExpression: 'identifier = :id AND windowStart = :window',
      ExpressionAttributeValues: {
        ':id': { S: identifier },
        ':window': { N: windowStart.toString() }
      }
    }));

    const count = result.Items?.[0]?.requestCount?.N 
      ? parseInt(result.Items[0].requestCount.N) 
      : 0;

    if (count >= 5) { // 5 refresh requests per 5 minutes
      return {
        allowed: false,
        retryAfter: 300 - Math.floor((Date.now() - windowStart) / 1000)
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Rate limit check failed', error);
    return { allowed: true };
  }
}

async function updateRateLimit(identifier: string): Promise<void> {
  const windowStart = Math.floor(Date.now() / 300000) * 300000;
  const expiresAt = windowStart + 600000; // 10-minute TTL

  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.RATE_LIMIT_TABLE_NAME,
      Key: {
        identifier: { S: identifier },
        windowStart: { N: windowStart.toString() }
      },
      UpdateExpression: 'SET requestCount = if_not_exists(requestCount, :zero) + :one, expiresAt = :ttl',
      ExpressionAttributeValues: {
        ':zero': { N: '0' },
        ':one': { N: '1' },
        ':ttl': { N: expiresAt.toString() }
      }
    }));
  } catch (error) {
    console.error('Failed to update rate limit', error);
  }
}

function getSigningKey(): string {
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
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}