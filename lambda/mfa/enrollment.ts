import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cognitoClient = new CognitoIdentityProviderClient({});

const MFA_DEVICES_TABLE = process.env.MFA_DEVICES_TABLE!;
const RECOVERY_CODES_TABLE = process.env.RECOVERY_CODES_TABLE!;
const PLAYER_USER_POOL_ID = process.env.PLAYER_USER_POOL_ID!;
const ENVIRONMENT = process.env.ENVIRONMENT!;

interface MfaEnrollmentRequest {
  userId: string;
  deviceName?: string;
  userPoolType: 'player' | 'admin';
}

interface MfaEnrollmentResponse {
  success: boolean;
  qrCodeUrl?: string;
  secret?: string;
  recoveryCodes?: string[];
  backupCodes?: string[];
  enrollmentReward?: {
    type: string;
    amount: number;
    description: string;
  };
  message?: string;
}

/**
 * Handler for MFA enrollment
 * Generates TOTP secret, QR code, and recovery codes
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('MFA Enrollment Request:', JSON.stringify(event, null, 2));

  try {
    // Parse request body
    const request: MfaEnrollmentRequest = JSON.parse(event.body || '{}');
    const { userId, deviceName = 'Default Device', userPoolType = 'player' } = request;

    if (!userId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          message: 'User ID is required'
        })
      };
    }

    // Check if user already has MFA device enrolled
    const existingDevice = await checkExistingDevice(userId);
    if (existingDevice && !event.queryStringParameters?.force) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          message: 'MFA device already enrolled. Use force=true to re-enroll.'
        })
      };
    }

    // Generate TOTP secret
    const secret = speakeasy.generateSecret({
      name: `Loupeen RTS (${ENVIRONMENT})`,
      issuer: 'Loupeen Gaming',
      length: 32
    });

    // Generate QR code for easy scanning
    const otpauthUrl = speakeasy.otpauthURL({
      secret: secret.ascii,
      label: `${userId}@loupeen`,
      issuer: 'Loupeen Gaming',
      encoding: 'ascii'
    });

    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Generate recovery codes
    const recoveryCodes = generateRecoveryCodes(8);
    
    // Store MFA device in DynamoDB
    await storeMfaDevice(userId, deviceName, secret.base32);
    
    // Store recovery codes
    await storeRecoveryCodes(userId, recoveryCodes);

    // Update user attributes in Cognito to indicate MFA enrollment
    await updateUserMfaStatus(userId, userPoolType);

    // Calculate gaming reward for MFA enrollment
    const enrollmentReward = calculateEnrollmentReward(userId);

    // Log successful enrollment for audit
    console.log(`MFA enrollment successful for user: ${userId}`);

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      },
      body: JSON.stringify({
        success: true,
        qrCodeUrl: qrCodeDataUrl,
        secret: secret.base32, // In production, this should be encrypted
        recoveryCodes: recoveryCodes,
        enrollmentReward,
        message: 'MFA enrollment successful. Please scan the QR code with your authenticator app.'
      } as MfaEnrollmentResponse)
    };

  } catch (error) {
    console.error('MFA enrollment error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: 'Failed to enroll MFA device'
      })
    };
  }
};

/**
 * Check if user already has an MFA device enrolled
 */
async function checkExistingDevice(userId: string): Promise<boolean> {
  try {
    const command = new GetCommand({
      TableName: MFA_DEVICES_TABLE,
      Key: {
        userId,
        deviceId: 'primary' // Primary device
      }
    });

    const response = await docClient.send(command);
    return !!response.Item;
  } catch (error) {
    console.error('Error checking existing device:', error);
    return false;
  }
}

/**
 * Store MFA device information in DynamoDB
 */
async function storeMfaDevice(userId: string, deviceName: string, secret: string): Promise<void> {
  const now = new Date().toISOString();
  
  const command = new PutCommand({
    TableName: MFA_DEVICES_TABLE,
    Item: {
      userId,
      deviceId: 'primary',
      deviceName,
      secret: encryptSecret(secret), // Encrypt the secret before storing
      algorithm: 'sha1',
      digits: 6,
      period: 30,
      verified: false,
      createdAt: now,
      lastUsedAt: now,
      usageCount: 0
    }
  });

  await docClient.send(command);
}

/**
 * Generate recovery codes for account recovery
 */
function generateRecoveryCodes(count: number = 8): string[] {
  const codes: string[] = [];
  
  for (let i = 0; i < count; i++) {
    // Generate 8-character alphanumeric codes
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  
  return codes;
}

/**
 * Store recovery codes in DynamoDB
 */
async function storeRecoveryCodes(userId: string, codes: string[]): Promise<void> {
  const now = new Date().toISOString();
  
  // Hash codes before storing for security
  const items = codes.map(code => ({
    PutRequest: {
      Item: {
        userId,
        codeHash: hashRecoveryCode(code),
        used: false,
        createdAt: now
      }
    }
  }));

  // Batch write recovery codes
  const chunks = [];
  for (let i = 0; i < items.length; i += 25) {
    chunks.push(items.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    const command = new BatchWriteCommand({
      RequestItems: {
        [RECOVERY_CODES_TABLE]: chunk
      }
    });
    await docClient.send(command);
  }
}

/**
 * Update user's MFA status in Cognito
 */
async function updateUserMfaStatus(userId: string, userPoolType: string): Promise<void> {
  const userPoolId = userPoolType === 'admin' ? process.env.ADMIN_USER_POOL_ID : PLAYER_USER_POOL_ID;
  
  try {
    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: userId,
      UserAttributes: [
        {
          Name: 'custom:mfaEnabled',
          Value: 'true'
        },
        {
          Name: 'custom:mfaEnrollmentDate',
          Value: new Date().toISOString()
        }
      ]
    });

    await cognitoClient.send(command);
  } catch (error) {
    console.error('Error updating user MFA status:', error);
    // Non-critical error, continue
  }
}

/**
 * Calculate gaming rewards for MFA enrollment
 */
function calculateEnrollmentReward(userId: string): { type: string; amount: number; description: string } {
  // In a real implementation, this would integrate with the game's reward system
  return {
    type: 'in-game-currency',
    amount: 500,
    description: 'Security Champion Bonus: 500 Gold for enabling MFA'
  };
}

/**
 * Encrypt secret for storage
 */
function encryptSecret(secret: string): string {
  // In production, use AWS KMS for encryption
  // This is a simplified example
  const algorithm = 'aes-256-gcm';
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  
  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return JSON.stringify({
    encrypted,
    authTag: authTag.toString('hex'),
    iv: iv.toString('hex')
  });
}

/**
 * Hash recovery code for secure storage
 */
function hashRecoveryCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');
}