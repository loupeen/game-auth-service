import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const dynamoDb = new DynamoDBClient({ region: process.env.AWS_REGION });

interface RegistrationRequest {
  email: string;
  username: string;
  password: string;
  playerName: string;
  deviceFingerprint?: string;
}

interface RegistrationResponse {
  success: boolean;
  userId?: string;
  playerId?: string;
  message: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('User registration request received');

  try {
    const body = JSON.parse(event.body || '{}') as RegistrationRequest;
    const { email, username, password, playerName, deviceFingerprint } = body;

    // Basic validation
    if (!email || !username || !password || !playerName) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          message: 'Email, username, password, and player name are required'
        } as RegistrationResponse)
      };
    }

    // Generate unique player ID
    const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create user in Cognito
    const createUserResult = await cognito.send(new AdminCreateUserCommand({
      UserPoolId: process.env.PLAYER_USER_POOL_ID,
      Username: username,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:playerId', Value: playerId },
        { Name: 'custom:deviceFingerprint', Value: deviceFingerprint || '' }
      ],
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS'
    }));

    const userId = createUserResult.User?.Username;

    // Store additional player data in sessions table (temporary storage)
    await dynamoDb.send(new PutItemCommand({
      TableName: process.env.SESSIONS_TABLE_NAME,
      Item: {
        sessionId: { S: `player_data_${playerId}` },
        userId: { S: userId || '' },
        playerId: { S: playerId },
        playerName: { S: playerName },
        email: { S: email },
        createdAt: { N: Date.now().toString() },
        expiresAt: { N: (Date.now() + (365 * 24 * 60 * 60 * 1000)).toString() }
      }
    }));

    console.log('User registration successful', { 
      userId, 
      playerId, 
      email: email.replace(/(.{2}).*(@.*)/, '$1***$2')
    });

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        userId,
        playerId,
        message: 'User registered successfully'
      } as RegistrationResponse)
    };

  } catch (error) {
    console.error('User registration failed', error);
    
    const statusCode = 500;
    
    return {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: error instanceof Error ? error.message : 'Registration failed'
      } as RegistrationResponse)
    };
  }
};