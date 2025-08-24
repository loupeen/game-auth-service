import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import * as crypto from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const snsClient = new SNSClient({});
const cognitoClient = new CognitoIdentityProviderClient({});

const SMS_CODES_TABLE = process.env.SMS_CODES_TABLE!;
const PLAYER_USER_POOL_ID = process.env.PLAYER_USER_POOL_ID!;
const ADMIN_USER_POOL_ID = process.env.ADMIN_USER_POOL_ID!;
const ENVIRONMENT = process.env.ENVIRONMENT!;

interface SmsRequest {
  userId: string;
  action: 'send' | 'verify';
  phoneNumber?: string;
  code?: string;
  userPoolType?: 'player' | 'admin';
}

interface SmsCodeRecord {
  userId: string;
  codeHash: string;
  phoneNumber: string;
  expiresAt: number;
  attempts: number;
  used: boolean;
  createdAt: string;
}

/**
 * Handler for SMS-based MFA fallback
 * Sends SMS codes when TOTP is unavailable or as backup option
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('SMS Fallback Request:', JSON.stringify(event, null, 2));

  try {
    const request: SmsRequest = JSON.parse(event.body || '{}');
    const { userId, action, phoneNumber, code, userPoolType = 'player' } = request;

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
      case 'send':
        // Get phone number from Cognito if not provided
        let targetPhoneNumber = phoneNumber;
        if (!targetPhoneNumber) {
          const phoneResult = await getUserPhoneNumber(userId, userPoolType);
          if (!phoneResult) {
            return {
              statusCode: 400,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                success: false,
                message: 'No phone number available for SMS. Please update your profile.'
              })
            };
          }
          targetPhoneNumber = phoneResult;
        }

        // Check rate limiting
        const canSendSms = await checkSmsRateLimit(userId);
        if (!canSendSms) {
          return {
            statusCode: 429,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'SMS rate limit exceeded. Please try again later.'
            })
          };
        }

        const smsResult = await sendSmsCode(userId, targetPhoneNumber);
        
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            codeSent: smsResult.success,
            maskedPhoneNumber: maskPhoneNumber(targetPhoneNumber),
            expiresIn: 300, // 5 minutes
            message: smsResult.success 
              ? 'SMS code sent successfully' 
              : 'Failed to send SMS code'
          })
        };

      case 'verify':
        if (!code) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'SMS code is required for verification'
            })
          };
        }

        const verificationResult = await verifySmsCode(userId, code);
        
        if (verificationResult.success) {
          // Award gaming incentive for SMS fallback usage
          const smsReward = calculateSmsReward(userId);
          
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: true,
              verified: true,
              smsReward,
              message: 'SMS code verified successfully'
            })
          };
        } else {
          return {
            statusCode: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: false,
              verified: false,
              attemptsRemaining: verificationResult.attemptsRemaining,
              message: verificationResult.message
            })
          };
        }

      default:
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            message: 'Invalid action. Supported actions: send, verify'
          })
        };
    }
  } catch (error) {
    console.error('SMS fallback error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: 'Failed to process SMS request'
      })
    };
  }
};

/**
 * Get user's phone number from Cognito
 */
async function getUserPhoneNumber(userId: string, userPoolType: string): Promise<string | null> {
  try {
    const userPoolId = userPoolType === 'admin' ? ADMIN_USER_POOL_ID : PLAYER_USER_POOL_ID;
    
    const command = new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: userId
    });

    const response = await cognitoClient.send(command);
    
    const phoneAttribute = response.UserAttributes?.find(
      attr => attr.Name === 'phone_number'
    );
    
    return phoneAttribute?.Value || null;
  } catch (error) {
    console.error('Error getting user phone number:', error);
    return null;
  }
}

/**
 * Check SMS rate limiting to prevent abuse
 */
async function checkSmsRateLimit(userId: string): Promise<boolean> {
  try {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    const oneHourAgo = now - (60 * 60 * 1000);

    // Check recent SMS codes for this user
    // In production, this would query a GSI by userId and timestamp
    // For now, we'll use a simplified check

    // Allow max 3 SMS per 5 minutes, 10 SMS per hour
    const recentCodesCount = await getRecentSmsCount(userId, fiveMinutesAgo);
    const hourlyCodesCount = await getRecentSmsCount(userId, oneHourAgo);

    return recentCodesCount < 3 && hourlyCodesCount < 10;
  } catch (error) {
    console.error('Error checking SMS rate limit:', error);
    return false; // Deny on error for security
  }
}

/**
 * Send SMS code to user
 */
async function sendSmsCode(userId: string, phoneNumber: string): Promise<{ success: boolean; message?: string }> {
  try {
    // Generate 6-digit numeric code
    const code = generateSmsCode();
    const codeHash = hashSmsCode(code);
    const now = Date.now();
    const expiresAt = now + (5 * 60 * 1000); // 5 minutes

    // Store SMS code in DynamoDB
    const smsRecord: SmsCodeRecord = {
      userId,
      codeHash,
      phoneNumber,
      expiresAt,
      attempts: 0,
      used: false,
      createdAt: new Date().toISOString()
    };

    const putCommand = new PutCommand({
      TableName: SMS_CODES_TABLE,
      Item: smsRecord
    });

    await docClient.send(putCommand);

    // Send SMS via AWS SNS
    const message = `Your Loupeen RTS security code is: ${code}. This code expires in 5 minutes. Do not share this code with anyone.`;
    
    const smsCommand = new PublishCommand({
      PhoneNumber: phoneNumber,
      Message: message,
      MessageAttributes: {
        'AWS.SNS.SMS.SenderID': {
          DataType: 'String',
          StringValue: 'Loupeen'
        },
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional'
        }
      }
    });

    await snsClient.send(smsCommand);

    console.log(`SMS code sent to user ${userId} at ${maskPhoneNumber(phoneNumber)}`);
    
    return { success: true };
  } catch (error) {
    console.error('Error sending SMS code:', error);
    return { success: false, message: 'Failed to send SMS' };
  }
}

/**
 * Verify SMS code
 */
async function verifySmsCode(userId: string, code: string): Promise<{ 
  success: boolean; 
  attemptsRemaining?: number; 
  message?: string 
}> {
  try {
    const codeHash = hashSmsCode(code);
    const now = Date.now();

    // Get the SMS code record
    const getCommand = new GetCommand({
      TableName: SMS_CODES_TABLE,
      Key: {
        userId,
        codeHash
      }
    });

    const response = await docClient.send(getCommand);
    
    if (!response.Item) {
      return {
        success: false,
        message: 'Invalid SMS code'
      };
    }

    const smsRecord = response.Item as SmsCodeRecord;

    // Check if code is expired
    if (now > smsRecord.expiresAt) {
      return {
        success: false,
        message: 'SMS code has expired. Please request a new code.'
      };
    }

    // Check if code was already used
    if (smsRecord.used) {
      return {
        success: false,
        message: 'SMS code has already been used'
      };
    }

    // Check attempt limit (max 3 attempts per code)
    if (smsRecord.attempts >= 3) {
      return {
        success: false,
        attemptsRemaining: 0,
        message: 'Maximum attempts exceeded. Please request a new code.'
      };
    }

    // Code is valid - mark as used
    const updateCommand = new UpdateCommand({
      TableName: SMS_CODES_TABLE,
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

    console.log(`SMS code verified successfully for user ${userId}`);

    return { success: true };
  } catch (error) {
    console.error('Error verifying SMS code:', error);
    
    // Increment attempt counter on error
    try {
      const codeHash = hashSmsCode(code);
      const updateCommand = new UpdateCommand({
        TableName: SMS_CODES_TABLE,
        Key: {
          userId,
          codeHash
        },
        UpdateExpression: 'SET attempts = attempts + :inc',
        ExpressionAttributeValues: {
          ':inc': 1
        }
      });
      
      await docClient.send(updateCommand);
    } catch (updateError) {
      console.error('Error updating attempt counter:', updateError);
    }

    return {
      success: false,
      message: 'Failed to verify SMS code'
    };
  }
}

/**
 * Get count of recent SMS codes for rate limiting
 */
async function getRecentSmsCount(userId: string, since: number): Promise<number> {
  try {
    // In production, this would use a GSI to query by userId and timestamp
    // For now, return a simplified count
    return 0;
  } catch (error) {
    console.error('Error getting recent SMS count:', error);
    return 999; // Return high number to block on error
  }
}

/**
 * Generate 6-digit SMS code
 */
function generateSmsCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Hash SMS code for secure storage
 */
function hashSmsCode(code: string): string {
  return crypto
    .createHash('sha256')
    .update(code + process.env.SMS_SALT || 'default-salt')
    .digest('hex');
}

/**
 * Mask phone number for privacy
 */
function maskPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length < 4) return '***';
  
  const last4 = phoneNumber.slice(-4);
  const masked = phoneNumber.slice(0, -4).replace(/\d/g, '*');
  return masked + last4;
}

/**
 * Calculate gaming reward for SMS usage
 */
function calculateSmsReward(userId: string): any {
  return {
    type: 'security-backup-bonus',
    amount: 25,
    description: 'SMS Backup Bonus: 25 Gold for using SMS fallback'
  };
}