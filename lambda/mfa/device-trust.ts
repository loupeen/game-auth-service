import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TRUSTED_DEVICES_TABLE = process.env.TRUSTED_DEVICES_TABLE!;
const RISK_ASSESSMENT_TABLE = process.env.RISK_ASSESSMENT_TABLE!;
const ENVIRONMENT = process.env.ENVIRONMENT!;

interface DeviceTrustRequest {
  userId: string;
  action: 'register' | 'verify' | 'revoke' | 'list';
  deviceData?: {
    deviceFingerprint: string;
    deviceName?: string;
    userAgent?: string;
    ipAddress?: string;
    location?: string;
  };
  deviceId?: string;
  trustLevel?: 'low' | 'medium' | 'high';
}

interface TrustedDevice {
  userId: string;
  deviceId: string;
  deviceFingerprint: string;
  deviceName: string;
  trustLevel: string;
  trusted: boolean;
  createdAt: string;
  lastSeenAt: string;
  verificationCount: number;
  location?: string;
  userAgent?: string;
  riskScore: number;
}

/**
 * Handler for device trust management
 * Manages trusted devices to reduce MFA prompts for known devices
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Device Trust Request:', JSON.stringify(event, null, 2));

  try {
    const request: DeviceTrustRequest = JSON.parse(event.body || '{}');
    const { userId, action, deviceData, deviceId, trustLevel } = request;

    if (!userId || !action) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          message: 'User ID and action are required'
        })
      };
    }

    switch (action) {
      case 'register':
        if (!deviceData?.deviceFingerprint) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'Device fingerprint is required for registration'
            })
          };
        }
        
        const registerResult = await registerDevice(userId, deviceData);
        return {
          statusCode: 201,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            device: registerResult,
            message: 'Device registered successfully'
          })
        };

      case 'verify':
        if (!deviceId) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'Device ID is required for verification'
            })
          };
        }
        
        const verifyResult = await verifyDevice(userId, deviceId, trustLevel || 'medium');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            verified: verifyResult,
            message: verifyResult ? 'Device verified successfully' : 'Device verification failed'
          })
        };

      case 'revoke':
        if (!deviceId) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'Device ID is required for revocation'
            })
          };
        }
        
        await revokeDevice(userId, deviceId);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            message: 'Device revoked successfully'
          })
        };

      case 'list':
        const devices = await listTrustedDevices(userId);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            devices,
            count: devices.length
          })
        };

      default:
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            message: 'Invalid action. Supported actions: register, verify, revoke, list'
          })
        };
    }
  } catch (error) {
    console.error('Device trust management error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: 'Failed to process device trust request'
      })
    };
  }
};

/**
 * Register a new device for the user
 */
async function registerDevice(userId: string, deviceData: any): Promise<TrustedDevice> {
  const deviceId = generateDeviceId();
  const now = new Date().toISOString();
  
  // Calculate initial risk score based on device characteristics
  const riskScore = await calculateDeviceRiskScore(deviceData);
  
  // Determine initial trust level based on risk score
  let trustLevel = 'low';
  if (riskScore < 0.3) {
    trustLevel = 'medium';
  } else if (riskScore < 0.1) {
    trustLevel = 'high';
  }

  const device: TrustedDevice = {
    userId,
    deviceId,
    deviceFingerprint: deviceData.deviceFingerprint,
    deviceName: deviceData.deviceName || 'Unknown Device',
    trustLevel,
    trusted: false, // Requires verification before being trusted
    createdAt: now,
    lastSeenAt: now,
    verificationCount: 0,
    location: deviceData.location,
    userAgent: deviceData.userAgent,
    riskScore
  };

  const command = new PutCommand({
    TableName: TRUSTED_DEVICES_TABLE,
    Item: device,
    ConditionExpression: 'attribute_not_exists(deviceId)' // Prevent duplicates
  });

  await docClient.send(command);
  
  // Log device registration
  console.log(`Device registered for user ${userId}:`, {
    deviceId,
    trustLevel,
    riskScore
  });

  return device;
}

/**
 * Verify a device and mark it as trusted
 */
async function verifyDevice(userId: string, deviceId: string, requestedTrustLevel: string): Promise<boolean> {
  try {
    // Get current device
    const getCommand = new GetCommand({
      TableName: TRUSTED_DEVICES_TABLE,
      Key: {
        userId,
        deviceId
      }
    });

    const response = await docClient.send(getCommand);
    
    if (!response.Item) {
      console.error('Device not found for verification:', deviceId);
      return false;
    }

    const device = response.Item as TrustedDevice;
    
    // Validate trust level based on device risk score
    const maxTrustLevel = getMaxTrustLevelForRisk(device.riskScore);
    const finalTrustLevel = getTrustLevelPriority(requestedTrustLevel) <= getTrustLevelPriority(maxTrustLevel)
      ? requestedTrustLevel
      : maxTrustLevel;

    // Update device as verified and trusted
    const updateCommand = new UpdateCommand({
      TableName: TRUSTED_DEVICES_TABLE,
      Key: {
        userId,
        deviceId
      },
      UpdateExpression: 'SET trusted = :trusted, trustLevel = :trust, verifiedAt = :now, verificationCount = verificationCount + :inc',
      ExpressionAttributeValues: {
        ':trusted': true,
        ':trust': finalTrustLevel,
        ':now': new Date().toISOString(),
        ':inc': 1
      }
    });

    await docClient.send(updateCommand);
    
    // Award gaming incentive for device verification
    await awardDeviceTrustBonus(userId, finalTrustLevel);
    
    console.log(`Device verified for user ${userId}:`, {
      deviceId,
      trustLevel: finalTrustLevel,
      verificationCount: device.verificationCount + 1
    });

    return true;
  } catch (error) {
    console.error('Error verifying device:', error);
    return false;
  }
}

/**
 * Revoke trust for a specific device
 */
async function revokeDevice(userId: string, deviceId: string): Promise<void> {
  const command = new DeleteCommand({
    TableName: TRUSTED_DEVICES_TABLE,
    Key: {
      userId,
      deviceId
    }
  });

  await docClient.send(command);
  
  console.log(`Device revoked for user ${userId}: ${deviceId}`);
}

/**
 * List all trusted devices for a user
 */
async function listTrustedDevices(userId: string): Promise<TrustedDevice[]> {
  const command = new QueryCommand({
    TableName: TRUSTED_DEVICES_TABLE,
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: {
      ':userId': userId
    }
  });

  const response = await docClient.send(command);
  return (response.Items as TrustedDevice[]) || [];
}

/**
 * Calculate device risk score based on various factors
 */
async function calculateDeviceRiskScore(deviceData: any): Promise<number> {
  let riskScore = 0;

  // Check for suspicious user agent patterns
  if (deviceData.userAgent) {
    if (deviceData.userAgent.includes('Bot') || deviceData.userAgent.includes('Crawler')) {
      riskScore += 0.8; // High risk for bots
    }
    
    // Check for outdated browsers (security risk)
    if (isOutdatedBrowser(deviceData.userAgent)) {
      riskScore += 0.3;
    }
  }

  // Check for VPN/Proxy/Tor usage
  if (deviceData.ipAddress) {
    const ipRisk = await checkIpReputation(deviceData.ipAddress);
    riskScore += ipRisk;
  }

  // Check for unusual location patterns
  if (deviceData.location) {
    const locationRisk = await checkLocationRisk(deviceData.location);
    riskScore += locationRisk;
  }

  // Device fingerprint complexity (simple fingerprints are riskier)
  if (deviceData.deviceFingerprint && deviceData.deviceFingerprint.length < 32) {
    riskScore += 0.2;
  }

  return Math.min(riskScore, 1.0);
}

/**
 * Check if browser is outdated
 */
function isOutdatedBrowser(userAgent: string): boolean {
  // Simple check for very old browsers
  const oldBrowserPatterns = [
    /Chrome\/[1-7][0-9]\./,  // Chrome versions 10-79
    /Firefox\/[1-6][0-9]\./,  // Firefox versions 10-69
    /Safari\/[1-9]\./         // Very old Safari
  ];
  
  return oldBrowserPatterns.some(pattern => pattern.test(userAgent));
}

/**
 * Check IP reputation for VPN/Proxy/Tor
 */
async function checkIpReputation(ipAddress: string): Promise<number> {
  // In production, integrate with IP reputation services
  // For now, return low risk for private/local IPs, medium for others
  if (isPrivateIP(ipAddress) || isLocalHost(ipAddress)) {
    return 0.1;
  }
  
  // Check if IP is from known data centers (potential VPN)
  if (await isDataCenterIP(ipAddress)) {
    return 0.4;
  }
  
  return 0.2; // Default medium-low risk for public IPs
}

/**
 * Check location-based risk factors
 */
async function checkLocationRisk(location: string): Promise<number> {
  // Check against high-risk countries or regions
  const highRiskRegions = ['Unknown', 'Anonymous Proxy', 'Satellite Provider'];
  
  if (highRiskRegions.some(region => location.includes(region))) {
    return 0.5;
  }
  
  return 0.1; // Low risk for identified locations
}

/**
 * Check if IP is private/internal
 */
function isPrivateIP(ip: string): boolean {
  const privateRanges = [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./
  ];
  
  return privateRanges.some(range => range.test(ip));
}

/**
 * Check if IP is localhost
 */
function isLocalHost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

/**
 * Check if IP belongs to a data center (potential VPN)
 */
async function isDataCenterIP(ipAddress: string): Promise<boolean> {
  // In production, use services like MaxMind or IPinfo
  // For now, return false
  return false;
}

/**
 * Get maximum trust level allowed based on risk score
 */
function getMaxTrustLevelForRisk(riskScore: number): string {
  if (riskScore > 0.7) return 'low';
  if (riskScore > 0.3) return 'medium';
  return 'high';
}

/**
 * Get numeric priority for trust level comparison
 */
function getTrustLevelPriority(trustLevel: string): number {
  const priorities = { low: 1, medium: 2, high: 3 };
  return priorities[trustLevel as keyof typeof priorities] || 1;
}

/**
 * Award gaming bonus for device verification
 */
async function awardDeviceTrustBonus(userId: string, trustLevel: string): Promise<void> {
  const bonuses = {
    low: { amount: 100, description: 'Device Trust Bonus: 100 Gold' },
    medium: { amount: 250, description: 'Secure Device Bonus: 250 Gold' },
    high: { amount: 500, description: 'High Trust Device Bonus: 500 Gold' }
  };
  
  const bonus = bonuses[trustLevel as keyof typeof bonuses];
  
  console.log(`Awarding device trust bonus to ${userId}:`, bonus);
  
  // In production, integrate with game reward system
}

/**
 * Generate unique device ID
 */
function generateDeviceId(): string {
  return crypto.randomBytes(16).toString('hex');
}