import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import * as jwt from 'jsonwebtoken';

const dynamoDb = new DynamoDBClient({ region: process.env.AWS_REGION });

interface TokenValidationRequest {
  token: string;
  requiredRoles?: string[];
}

interface TokenValidationResponse {
  valid: boolean;
  userId?: string;
  playerId?: string;
  allianceId?: string;
  roles?: string[];
  error?: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Token validation request received', { 
    headers: event.headers,
    path: event.path 
  });

  try {
    const body = JSON.parse(event.body || '{}') as TokenValidationRequest;
    const { token, requiredRoles = [] } = body;

    if (!token) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid: false,
          error: 'Token is required'
        } as TokenValidationResponse)
      };
    }

    // Decode JWT (basic implementation - will be enhanced with proper verification)
    const decoded = jwt.decode(token) as any;
    
    if (!decoded) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid: false,
          error: 'Invalid token format'
        } as TokenValidationResponse)
      };
    }

    // Check session in DynamoDB
    const sessionResult = await dynamoDb.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE_NAME,
      Key: {
        sessionId: { S: decoded.sessionId || '' }
      }
    }));

    const sessionExists = sessionResult.Item !== undefined;
    const sessionExpired = sessionResult.Item ? 
      Number(sessionResult.Item.expiresAt?.N) < Date.now() : true;

    if (!sessionExists || sessionExpired) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid: false,
          error: 'Session expired or invalid'
        } as TokenValidationResponse)
      };
    }

    // Role validation
    const userRoles = decoded.roles || [];
    const hasRequiredRoles = requiredRoles.length === 0 || 
      requiredRoles.some((role: string) => userRoles.includes(role));

    if (!hasRequiredRoles) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valid: false,
          error: 'Insufficient permissions'
        } as TokenValidationResponse)
      };
    }

    console.log('Token validation successful', { 
      userId: decoded.userId,
      playerId: decoded.playerId 
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valid: true,
        userId: decoded.userId,
        playerId: decoded.playerId,
        allianceId: decoded.allianceId,
        roles: userRoles
      } as TokenValidationResponse)
    };

  } catch (error) {
    console.error('Token validation failed', error);
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valid: false,
        error: 'Internal server error'
      } as TokenValidationResponse)
    };
  }
};