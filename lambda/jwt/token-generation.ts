import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
  CognitoIdentityProviderClient, 
  AdminGetUserCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import * as jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });

interface TokenGenerationRequest {
  username: string;
  password: string;
  deviceId: string;
  userType: 'player' | 'admin';
}

interface TokenGenerationResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  playerId?: string;
  allianceId?: string;
  roles?: string[];
}

interface RateLimitCheck {
  allowed: boolean;
  retryAfter?: number;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  console.log('Token generation request received', { 
    path: event.path,
    sourceIp: event.requestContext.identity.sourceIp
  });

  try {
    const body = JSON.parse(event.body || '{}') as TokenGenerationRequest;
    const { username, password, deviceId, userType } = body;

    // Input validation
    if (!username || !password || !deviceId || !userType) {
      return createResponse(400, {
        error: 'Missing required fields',
        message: 'Username, password, deviceId, and userType are required'
      });
    }

    // Rate limiting check
    const rateLimitKey = `${username}:${event.requestContext.identity.sourceIp}`;
    const rateLimitCheck = await checkRateLimit(rateLimitKey);
    
    if (!rateLimitCheck.allowed) {
      return createResponse(429, {
        error: 'Too many requests',
        retryAfter: rateLimitCheck.retryAfter
      });
    }

    // Authenticate with Cognito
    const userPoolId = userType === 'admin' 
      ? process.env.ADMIN_USER_POOL_ID 
      : process.env.PLAYER_USER_POOL_ID;

    let cognitoUser;
    try {
      // For this example, we'll use AdminGetUser to get user attributes
      // In production, you'd use InitiateAuth with SRP or CUSTOM_AUTH
      cognitoUser = await cognito.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: username
      }));
    } catch (error: any) {
      console.error('Cognito authentication failed', { error: error.message });
      return createResponse(401, {
        error: 'Authentication failed',
        message: 'Invalid credentials'
      });
    }

    // Extract user attributes
    const userAttributes = cognitoUser.UserAttributes?.reduce((acc: any, attr: any) => {
      acc[attr.Name] = attr.Value;
      return acc;
    }, {}) || {};

    // Generate unique identifiers
    const jti = randomBytes(16).toString('hex'); // JWT ID for revocation
    const sessionId = randomBytes(16).toString('hex');
    const tokenFamily = randomBytes(16).toString('hex'); // For refresh token rotation

    // Create JWT claims
    const claims = {
      sub: cognitoUser.Username,
      jti,
      sessionId,
      deviceId,
      userType,
      playerId: userAttributes['custom:playerId'],
      allianceId: userAttributes['custom:allianceId'],
      roles: userAttributes['custom:roleId']?.split(',') || [],
      iss: `loupeen-auth-${process.env.ENVIRONMENT}`,
      aud: userType === 'admin' ? 'loupeen-admin' : 'loupeen-game',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + parseInt(process.env.JWT_ACCESS_TOKEN_EXPIRY || '900')
    };

    // Generate tokens
    const accessToken = jwt.sign(claims, getSigningKey(), {
      algorithm: 'HS256' // In production, use RS256 with KMS
    });

    const refreshTokenData = {
      tokenId: randomBytes(32).toString('hex'),
      userId: cognitoUser.Username!,
      tokenFamily,
      deviceId,
      userType,
      createdAt: Date.now(),
      expiresAt: Date.now() + (parseInt(process.env.JWT_REFRESH_TOKEN_EXPIRY || '2592000') * 1000)
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

    // Store session in DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.SESSIONS_TABLE_NAME,
      Item: {
        sessionId: { S: sessionId },
        userId: { S: cognitoUser.Username! },
        deviceId: { S: deviceId },
        userType: { S: userType },
        playerId: { S: userAttributes['custom:playerId'] || '' },
        allianceId: { S: userAttributes['custom:allianceId'] || '' },
        createdAt: { N: Date.now().toString() },
        lastActivity: { N: Date.now().toString() },
        expiresAt: { N: (Date.now() + 86400000).toString() } // 24 hours
      }
    }));

    // Store refresh token in DynamoDB
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
        used: { BOOL: false }
      }
    }));

    // Update rate limit counter
    await updateRateLimit(rateLimitKey);

    // Log metrics
    console.log('Token generation successful', {
      userId: cognitoUser.Username,
      playerId: userAttributes['custom:playerId'],
      deviceId,
      latency: Date.now() - startTime
    });

    return createResponse(200, {
      accessToken,
      refreshToken,
      expiresIn: parseInt(process.env.JWT_ACCESS_TOKEN_EXPIRY || '900'),
      tokenType: 'Bearer',
      playerId: userAttributes['custom:playerId'],
      allianceId: userAttributes['custom:allianceId'],
      roles: claims.roles
    } as TokenGenerationResponse);

  } catch (error) {
    console.error('Token generation failed', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: 'Failed to generate tokens'
    });
  }
};

async function checkRateLimit(identifier: string): Promise<RateLimitCheck> {
  const windowStart = Math.floor(Date.now() / 60000) * 60000; // 1-minute window
  
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

    if (count >= 10) { // 10 requests per minute
      return {
        allowed: false,
        retryAfter: 60 - Math.floor((Date.now() - windowStart) / 1000)
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('Rate limit check failed', error);
    return { allowed: true }; // Fail open for availability
  }
}

async function updateRateLimit(identifier: string): Promise<void> {
  const windowStart = Math.floor(Date.now() / 60000) * 60000;
  const expiresAt = windowStart + 120000; // 2-minute TTL

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
      'Access-Control-Allow-Credentials': 'true'
    },
    body: JSON.stringify(body)
  };
}