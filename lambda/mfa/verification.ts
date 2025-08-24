import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import * as speakeasy from 'speakeasy';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cognitoClient = new CognitoIdentityProviderClient({});

const MFA_DEVICES_TABLE = process.env.MFA_DEVICES_TABLE!;
const RECOVERY_CODES_TABLE = process.env.RECOVERY_CODES_TABLE!;
const RISK_ASSESSMENT_TABLE = process.env.RISK_ASSESSMENT_TABLE!;
const PLAYER_USER_POOL_ID = process.env.PLAYER_USER_POOL_ID!;
const ENVIRONMENT = process.env.ENVIRONMENT!;

interface MfaVerificationRequest {
  userId: string;
  code: string;
  deviceId?: string;
  isRecoveryCode?: boolean;
  clientMetadata?: {
    ipAddress?: string;
    userAgent?: string;
    deviceFingerprint?: string;
  };
}

interface MfaVerificationResponse {
  success: boolean;
  verified: boolean;
  attemptsRemaining?: number;
  requiresAdditionalVerification?: boolean;
  riskScore?: number;
  message?: string;
}

/**
 * Handler for MFA code verification
 * Verifies TOTP codes or recovery codes
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('MFA Verification Request:', JSON.stringify(event, null, 2));

  try {
    const request: MfaVerificationRequest = JSON.parse(event.body || '{}');
    const { userId, code, isRecoveryCode = false, clientMetadata = {} } = request;

    if (!userId || !code) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          verified: false,
          message: 'User ID and code are required'
        })
      };
    }

    // Perform risk assessment first
    const riskScore = await assessRisk(userId, clientMetadata);
    
    if (riskScore > 0.8) {
      // High risk - require additional verification
      await logSuspiciousActivity(userId, 'High risk MFA attempt', clientMetadata);
      
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          verified: false,
          requiresAdditionalVerification: true,
          riskScore,
          message: 'Additional verification required due to suspicious activity'
        })
      };
    }

    let verificationResult: boolean;
    
    if (isRecoveryCode) {
      // Verify recovery code
      verificationResult = await verifyRecoveryCode(userId, code);
    } else {
      // Verify TOTP code
      verificationResult = await verifyTotpCode(userId, code);
    }

    if (verificationResult) {
      // Update last used timestamp
      await updateMfaDeviceUsage(userId);
      
      // Log successful verification
      await logMfaEvent(userId, 'verification_success', clientMetadata);
      
      // Update user's MFA verification status in Cognito
      await updateUserMfaVerificationStatus(userId, true);
      
      // Calculate rewards for successful MFA verification
      const verificationReward = calculateVerificationReward(userId);
      
      return {
        statusCode: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        },
        body: JSON.stringify({
          success: true,
          verified: true,
          riskScore,
          message: 'MFA verification successful'
        } as MfaVerificationResponse)
      };
    } else {
      // Log failed attempt
      await logMfaEvent(userId, 'verification_failed', clientMetadata);
      
      // Get remaining attempts
      const attemptsRemaining = await getRemainingAttempts(userId);
      
      if (attemptsRemaining <= 0) {
        // Lock account after too many failed attempts
        await lockUserAccount(userId);
        
        return {
          statusCode: 429,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            verified: false,
            attemptsRemaining: 0,
            message: 'Account locked due to multiple failed attempts'
          })
        };
      }
      
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          verified: false,
          attemptsRemaining,
          message: `Invalid code. ${attemptsRemaining} attempts remaining`
        })
      };
    }
  } catch (error) {
    console.error('MFA verification error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        verified: false,
        message: 'Failed to verify MFA code'
      })
    };
  }
};

/**
 * Verify TOTP code against stored secret
 */
async function verifyTotpCode(userId: string, code: string): Promise<boolean> {
  try {
    // Get MFA device from DynamoDB
    const command = new GetCommand({
      TableName: MFA_DEVICES_TABLE,
      Key: {
        userId,
        deviceId: 'primary'
      }
    });
    
    const response = await docClient.send(command);
    
    if (!response.Item) {
      console.error('No MFA device found for user:', userId);
      return false;
    }
    
    // Decrypt the secret
    const secret = decryptSecret(response.Item.secret);
    
    // Verify the TOTP code
    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 2 // Allow 2 time steps for clock skew
    });
    
    // Mark device as verified on first successful verification
    if (verified && !response.Item.verified) {
      await markDeviceAsVerified(userId);
    }
    
    return verified;
  } catch (error) {
    console.error('Error verifying TOTP code:', error);
    return false;
  }
}

/**
 * Verify recovery code
 */
async function verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
  try {
    const codeHash = hashRecoveryCode(code);
    
    // Check if recovery code exists and hasn't been used
    const command = new GetCommand({
      TableName: RECOVERY_CODES_TABLE,
      Key: {
        userId,
        codeHash
      }
    });
    
    const response = await docClient.send(command);
    
    if (!response.Item || response.Item.used) {
      return false;
    }
    
    // Mark recovery code as used
    const updateCommand = new UpdateCommand({
      TableName: RECOVERY_CODES_TABLE,
      Key: {
        userId,
        codeHash
      },
      UpdateExpression: 'SET used = :true, usedAt = :now',
      ExpressionAttributeValues: {
        ':true': true,
        ':now': new Date().toISOString()
      }
    });
    
    await docClient.send(updateCommand);
    
    return true;
  } catch (error) {
    console.error('Error verifying recovery code:', error);
    return false;
  }
}

/**
 * Assess risk based on various factors
 */
async function assessRisk(userId: string, metadata: any): Promise<number> {
  let riskScore = 0;
  
  try {
    // Check for impossible traveler (location change too quickly)
    const lastLocation = await getLastKnownLocation(userId);
    if (lastLocation && metadata.ipAddress) {
      const distance = calculateDistanceFromIPs(lastLocation.ipAddress, metadata.ipAddress);
      const timeDiff = Date.now() - new Date(lastLocation.timestamp).getTime();
      
      // If traveled >1000km in <1 hour, high risk
      if (distance > 1000 && timeDiff < 3600000) {
        riskScore += 0.5;
      }
    }
    
    // Check for new device
    if (metadata.deviceFingerprint) {
      const isKnownDevice = await checkDeviceFingerprint(userId, metadata.deviceFingerprint);
      if (!isKnownDevice) {
        riskScore += 0.3;
      }
    }
    
    // Check for unusual login time
    const hour = new Date().getHours();
    if (hour >= 2 && hour <= 5) {
      riskScore += 0.2;
    }
    
    // Store risk assessment
    await storeRiskAssessment(userId, riskScore, metadata);
    
    return Math.min(riskScore, 1.0);
  } catch (error) {
    console.error('Error assessing risk:', error);
    return 0.5; // Default medium risk on error
  }
}

/**
 * Update MFA device usage statistics
 */
async function updateMfaDeviceUsage(userId: string): Promise<void> {
  const command = new UpdateCommand({
    TableName: MFA_DEVICES_TABLE,
    Key: {
      userId,
      deviceId: 'primary'
    },
    UpdateExpression: 'SET lastUsedAt = :now, usageCount = usageCount + :inc',
    ExpressionAttributeValues: {
      ':now': new Date().toISOString(),
      ':inc': 1
    }
  });
  
  await docClient.send(command);
}

/**
 * Mark MFA device as verified
 */
async function markDeviceAsVerified(userId: string): Promise<void> {
  const command = new UpdateCommand({
    TableName: MFA_DEVICES_TABLE,
    Key: {
      userId,
      deviceId: 'primary'
    },
    UpdateExpression: 'SET verified = :true, verifiedAt = :now',
    ExpressionAttributeValues: {
      ':true': true,
      ':now': new Date().toISOString()
    }
  });
  
  await docClient.send(command);
}

/**
 * Update user's MFA verification status in Cognito
 */
async function updateUserMfaVerificationStatus(userId: string, verified: boolean): Promise<void> {
  try {
    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: PLAYER_USER_POOL_ID,
      Username: userId,
      UserAttributes: [
        {
          Name: 'custom:mfaVerified',
          Value: verified.toString()
        },
        {
          Name: 'custom:lastMfaVerification',
          Value: new Date().toISOString()
        }
      ]
    });
    
    await cognitoClient.send(command);
  } catch (error) {
    console.error('Error updating user MFA verification status:', error);
  }
}

/**
 * Get remaining MFA attempts for user
 */
async function getRemainingAttempts(userId: string): Promise<number> {
  // Implementation would check failed attempts in last hour
  // For now, return a default value
  return 3;
}

/**
 * Lock user account after too many failed attempts
 */
async function lockUserAccount(userId: string): Promise<void> {
  console.log(`Locking account for user: ${userId}`);
  // Implementation would disable user in Cognito
}

/**
 * Log MFA event for audit trail
 */
async function logMfaEvent(userId: string, eventType: string, metadata: any): Promise<void> {
  console.log('MFA Event:', { userId, eventType, metadata });
  // Implementation would write to audit log
}

/**
 * Log suspicious activity
 */
async function logSuspiciousActivity(userId: string, reason: string, metadata: any): Promise<void> {
  console.error('Suspicious Activity:', { userId, reason, metadata });
  // Implementation would trigger security alerts
}

/**
 * Store risk assessment result
 */
async function storeRiskAssessment(userId: string, riskScore: number, metadata: any): Promise<void> {
  const command = new UpdateCommand({
    TableName: RISK_ASSESSMENT_TABLE,
    Key: {
      userId,
      timestamp: new Date().toISOString()
    },
    UpdateExpression: 'SET riskScore = :score, metadata = :meta',
    ExpressionAttributeValues: {
      ':score': riskScore,
      ':meta': metadata
    }
  });
  
  await docClient.send(command);
}

/**
 * Get last known location for user
 */
async function getLastKnownLocation(userId: string): Promise<any> {
  // Implementation would query location history
  return null;
}

/**
 * Check if device fingerprint is known
 */
async function checkDeviceFingerprint(userId: string, fingerprint: string): Promise<boolean> {
  // Implementation would check trusted devices table
  return false;
}

/**
 * Calculate distance between two IP addresses
 */
function calculateDistanceFromIPs(ip1: string, ip2: string): number {
  // Implementation would use GeoIP lookup
  return 0;
}

/**
 * Calculate gaming rewards for MFA verification
 */
function calculateVerificationReward(userId: string): any {
  // Daily login bonus for MFA users
  return {
    type: 'daily-login-bonus',
    amount: 50,
    description: 'Daily MFA Security Bonus: 50 Gold'
  };
}

/**
 * Decrypt secret from storage
 */
function decryptSecret(encryptedData: string): string {
  try {
    const data = JSON.parse(encryptedData);
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'default-key', 'salt', 32);
    const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(data.iv, 'hex'));
    
    decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));
    
    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Error decrypting secret:', error);
    throw new Error('Failed to decrypt secret');
  }
}

/**
 * Hash recovery code for comparison
 */
function hashRecoveryCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');
}