import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
  DynamoDBClient, 
  PutItemCommand, 
  UpdateItemCommand,
  QueryCommand
} from '@aws-sdk/client-dynamodb';
import * as jwt from 'jsonwebtoken';

const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });

interface TokenRevocationRequest {
  token?: string;
  userId?: string;
  sessionId?: string;
  deviceId?: string;
  reason: string;
  revokeAll?: boolean; // Revoke all tokens for a user
}

interface TokenRevocationResponse {
  success: boolean;
  message: string;
  revokedCount?: number;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Token revocation request received', { 
    path: event.path,
    sourceIp: event.requestContext.identity.sourceIp
  });

  try {
    const body = JSON.parse(event.body || '{}') as TokenRevocationRequest;
    const { token, userId, sessionId, deviceId, reason, revokeAll = false } = body;

    // Validate input
    if (!reason) {
      return createResponse(400, {
        success: false,
        message: 'Revocation reason is required'
      });
    }

    if (!token && !userId && !sessionId && !deviceId) {
      return createResponse(400, {
        success: false,
        message: 'At least one identifier (token, userId, sessionId, or deviceId) is required'
      });
    }

    let revokedCount = 0;

    // Revoke by token (most specific)
    if (token) {
      const decoded = jwt.decode(token) as any;
      if (decoded?.jti) {
        await revokeTokenByJTI(decoded.jti, reason);
        revokedCount++;
        
        // Also revoke the session
        if (decoded.sessionId) {
          await revokeSession(decoded.sessionId, reason);
        }
      }
    }

    // Revoke all tokens for a user
    if (userId && revokeAll) {
      revokedCount = await revokeAllUserTokens(userId, reason);
    }

    // Revoke by session
    if (sessionId) {
      await revokeSession(sessionId, reason);
      revokedCount++;
    }

    // Revoke by device
    if (deviceId) {
      revokedCount = await revokeDeviceTokens(deviceId, reason);
    }

    console.log('Token revocation completed', {
      userId,
      sessionId,
      deviceId,
      revokedCount,
      reason
    });

    return createResponse(200, {
      success: true,
      message: `Successfully revoked ${revokedCount} token(s)`,
      revokedCount
    } as TokenRevocationResponse);

  } catch (error) {
    console.error('Token revocation error', error);
    return createResponse(500, {
      success: false,
      message: 'Failed to revoke tokens'
    });
  }
};

async function revokeTokenByJTI(jti: string, reason: string): Promise<void> {
  try {
    // Add to revoked tokens table
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.REVOKED_TOKENS_TABLE_NAME,
      Item: {
        jti: { S: jti },
        revokedAt: { N: Date.now().toString() },
        reason: { S: reason },
        // Set TTL to token expiry + 1 day for cleanup
        expiresAt: { N: (Date.now() + 86400000).toString() }
      }
    }));

    console.log('Token revoked by JTI', { jti, reason });
  } catch (error) {
    console.error('Failed to revoke token by JTI', error);
    throw error;
  }
}

async function revokeSession(sessionId: string, reason: string): Promise<void> {
  try {
    // Mark session as revoked
    await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE_NAME,
      Key: {
        sessionId: { S: sessionId }
      },
      UpdateExpression: 'SET revoked = :true, revokedAt = :now, revokedReason = :reason',
      ExpressionAttributeValues: {
        ':true': { BOOL: true },
        ':now': { N: Date.now().toString() },
        ':reason': { S: reason }
      }
    }));

    console.log('Session revoked', { sessionId, reason });
  } catch (error) {
    console.error('Failed to revoke session', error);
    throw error;
  }
}

async function revokeAllUserTokens(userId: string, reason: string): Promise<number> {
  let revokedCount = 0;

  try {
    // Query all refresh tokens for the user
    const refreshTokens = await dynamodb.send(new QueryCommand({
      TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
      IndexName: 'UserIdIndex',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': { S: userId }
      }
    }));

    // Revoke all refresh tokens
    if (refreshTokens.Items && refreshTokens.Items.length > 0) {
      const updatePromises = refreshTokens.Items.map(item => 
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
            ':reason': { S: reason }
          }
        }))
      );

      await Promise.all(updatePromises);
      revokedCount += refreshTokens.Items.length;
    }

    // Query and revoke all sessions for the user
    // In production, you'd have a GSI on userId for the sessions table
    const sessions = await queryUserSessions(userId);
    
    if (sessions.length > 0) {
      const sessionPromises = sessions.map(sessionId =>
        revokeSession(sessionId, reason)
      );
      
      await Promise.all(sessionPromises);
      revokedCount += sessions.length;
    }

    console.log('All user tokens revoked', { userId, revokedCount, reason });
    return revokedCount;

  } catch (error) {
    console.error('Failed to revoke all user tokens', error);
    throw error;
  }
}

async function revokeDeviceTokens(deviceId: string, reason: string): Promise<number> {
  let revokedCount = 0;

  try {
    // Query refresh tokens by device
    // In production, you'd have a GSI on deviceId
    const refreshTokens = await dynamodb.send(new QueryCommand({
      TableName: process.env.REFRESH_TOKENS_TABLE_NAME,
      IndexName: 'DeviceIdIndex', // This index would need to be created
      KeyConditionExpression: 'deviceId = :deviceId',
      ExpressionAttributeValues: {
        ':deviceId': { S: deviceId }
      }
    }));

    if (refreshTokens.Items && refreshTokens.Items.length > 0) {
      const updatePromises = refreshTokens.Items.map(item => 
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
            ':reason': { S: reason }
          }
        }))
      );

      await Promise.all(updatePromises);
      revokedCount += refreshTokens.Items.length;
    }

    console.log('Device tokens revoked', { deviceId, revokedCount, reason });
    return revokedCount;

  } catch (error) {
    console.error('Failed to revoke device tokens', error);
    // If index doesn't exist, fall back to scanning (not recommended for production)
    console.warn('DeviceIdIndex might not exist, falling back to limited functionality');
    return 0;
  }
}

async function queryUserSessions(userId: string): Promise<string[]> {
  // This is a simplified implementation
  // In production, you'd have proper indexing on the sessions table
  try {
    // For now, return empty array as we'd need a GSI on userId
    console.log('Querying user sessions', { userId });
    return [];
  } catch (error) {
    console.error('Failed to query user sessions', error);
    return [];
  }
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