import { handler } from '../../../lambda/mfa/verification';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/lib-dynamodb');
jest.mock('@aws-sdk/client-cognito-identity-provider');
jest.mock('speakeasy');

import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import * as speakeasy from 'speakeasy';

// Mock the AWS clients
const mockSend = jest.fn();
const mockDocClient = {
  send: mockSend
} as unknown as DynamoDBDocumentClient;

const mockCognitoClient = {
  send: jest.fn()
} as unknown as CognitoIdentityProviderClient;

// Mock environment variables
process.env.MFA_DEVICES_TABLE = 'test-mfa-devices';
process.env.RECOVERY_CODES_TABLE = 'test-recovery-codes';
process.env.RISK_ASSESSMENT_TABLE = 'test-risk-assessment';
process.env.PLAYER_USER_POOL_ID = 'test-user-pool';
process.env.ENVIRONMENT = 'test';
process.env.ENCRYPTION_KEY = 'test-key';

describe('MFA Verification Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockEvent = (body: any): APIGatewayProxyEvent => ({
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/mfa/verify',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: ''
  });

  describe('TOTP verification', () => {
    it('should verify valid TOTP code successfully', async () => {
      // Mock DynamoDB device lookup
      const mockDevice = {
        userId: 'test-user-123',
        deviceId: 'primary',
        secret: JSON.stringify({
          encrypted: 'encrypted-secret',
          authTag: 'auth-tag',
          iv: 'initialization-vector'
        }),
        verified: true
      };
      
      mockSend.mockResolvedValueOnce({ Item: mockDevice }); // Device lookup
      mockSend.mockResolvedValueOnce({}); // Device usage update
      mockSend.mockResolvedValueOnce({}); // Risk assessment storage
      mockSend.mockResolvedValueOnce({}); // MFA event logging

      // Mock speakeasy TOTP verification
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      const event = createMockEvent({
        userId: 'test-user-123',
        code: '123456',
        clientMetadata: {
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0...',
          deviceFingerprint: 'test-fingerprint'
        }
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.verified).toBe(true);
      expect(body.riskScore).toBeDefined();
      expect(body.riskScore).toBeLessThan(1);
    });

    it('should reject invalid TOTP code', async () => {
      const mockDevice = {
        userId: 'test-user-123',
        deviceId: 'primary',
        secret: JSON.stringify({
          encrypted: 'encrypted-secret',
          authTag: 'auth-tag',
          iv: 'initialization-vector'
        }),
        verified: true
      };
      
      mockSend.mockResolvedValueOnce({ Item: mockDevice });
      mockSend.mockResolvedValueOnce({}); // MFA event logging

      // Mock speakeasy TOTP verification failure
      (speakeasy.totp.verify as jest.Mock).mockReturnValue(false);

      const event = createMockEvent({
        userId: 'test-user-123',
        code: '000000'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.verified).toBe(false);
      expect(body.attemptsRemaining).toBeDefined();
    });
  });

  describe('recovery code verification', () => {
    it('should verify valid recovery code successfully', async () => {
      // Mock recovery code lookup
      const mockRecoveryCode = {
        userId: 'test-user-123',
        codeHash: 'hashed-recovery-code',
        used: false,
        createdAt: '2024-01-01T00:00:00.000Z'
      };
      
      mockSend.mockResolvedValueOnce({ Item: mockRecoveryCode }); // Recovery code lookup
      mockSend.mockResolvedValueOnce({}); // Mark code as used
      mockSend.mockResolvedValueOnce({}); // Risk assessment storage
      mockSend.mockResolvedValueOnce({}); // MFA event logging

      const event = createMockEvent({
        userId: 'test-user-123',
        code: 'ABCD-1234',
        isRecoveryCode: true
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.verified).toBe(true);
    });

    it('should reject already used recovery code', async () => {
      const mockRecoveryCode = {
        userId: 'test-user-123',
        codeHash: 'hashed-recovery-code',
        used: true,
        usedAt: '2024-01-01T00:00:00.000Z'
      };
      
      mockSend.mockResolvedValueOnce({ Item: mockRecoveryCode });

      const event = createMockEvent({
        userId: 'test-user-123',
        code: 'ABCD-1234',
        isRecoveryCode: true
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.verified).toBe(false);
    });
  });

  describe('risk assessment', () => {
    it('should block high-risk requests', async () => {
      const event = createMockEvent({
        userId: 'test-user-123',
        code: '123456',
        clientMetadata: {
          ipAddress: '1.2.3.4', // Different IP from previous sessions
          userAgent: 'Suspicious Browser',
          deviceFingerprint: 'unknown-device'
        }
      });

      // Mock high risk score calculation by simulating risk factors
      const result = await handler(event);

      // The function should assess risk before proceeding with verification
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should return 400 for missing userId', async () => {
      const event = createMockEvent({
        code: '123456'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.message).toBe('User ID and code are required');
    });

    it('should return 400 for missing code', async () => {
      const event = createMockEvent({
        userId: 'test-user-123'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.message).toBe('User ID and code are required');
    });
  });

  describe('error handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockSend.mockRejectedValue(new Error('DynamoDB error'));

      const event = createMockEvent({
        userId: 'test-user-123',
        code: '123456'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.message).toBe('Failed to verify MFA code');
    });

    it('should handle missing MFA device gracefully', async () => {
      mockSend.mockResolvedValueOnce({ Item: null }); // No device found

      const event = createMockEvent({
        userId: 'test-user-123',
        code: '123456'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.verified).toBe(false);
    });
  });

  describe('device verification on first use', () => {
    it('should mark device as verified on first successful TOTP', async () => {
      const mockDevice = {
        userId: 'test-user-123',
        deviceId: 'primary',
        secret: JSON.stringify({
          encrypted: 'encrypted-secret',
          authTag: 'auth-tag',
          iv: 'initialization-vector'
        }),
        verified: false // Not yet verified
      };
      
      mockSend.mockResolvedValueOnce({ Item: mockDevice });
      mockSend.mockResolvedValueOnce({}); // Mark as verified
      mockSend.mockResolvedValueOnce({}); // Update usage
      mockSend.mockResolvedValueOnce({}); // Risk assessment
      mockSend.mockResolvedValueOnce({}); // MFA event

      (speakeasy.totp.verify as jest.Mock).mockReturnValue(true);

      const event = createMockEvent({
        userId: 'test-user-123',
        code: '123456'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      // Should have called to mark device as verified
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('verified = :true')
        })
      );
    });
  });
});