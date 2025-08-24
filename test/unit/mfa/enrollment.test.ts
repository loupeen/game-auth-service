import { handler } from '../../../lambda/mfa/enrollment';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/lib-dynamodb');
jest.mock('@aws-sdk/client-cognito-identity-provider');
jest.mock('speakeasy');
jest.mock('qrcode');

import { DynamoDBDocumentClient, GetCommand, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';

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
process.env.PLAYER_USER_POOL_ID = 'test-user-pool';
process.env.ENVIRONMENT = 'test';
process.env.ENCRYPTION_KEY = 'test-key';

describe('MFA Enrollment Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockEvent = (body: any): APIGatewayProxyEvent => ({
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/mfa/enroll',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: ''
  });

  describe('successful enrollment', () => {
    it('should enroll a new MFA device successfully', async () => {
      // Mock speakeasy secret generation
      const mockSecret = {
        ascii: 'test-ascii-secret',
        base32: 'TEST-BASE32-SECRET'
      };
      (speakeasy.generateSecret as jest.Mock).mockReturnValue(mockSecret);

      // Mock QR code generation
      const mockQRCodeUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...';
      (QRCode.toDataURL as jest.Mock).mockResolvedValue(mockQRCodeUrl);

      // Mock DynamoDB responses
      mockSend
        .mockResolvedValueOnce({ Item: null }) // No existing device
        .mockResolvedValueOnce({}) // Successful device storage
        .mockResolvedValueOnce({}); // Successful recovery codes storage

      const event = createMockEvent({
        userId: 'test-user-123',
        deviceName: 'iPhone 14',
        userPoolType: 'player'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.qrCodeUrl).toBe(mockQRCodeUrl);
      expect(body.secret).toBe('TEST-BASE32-SECRET');
      expect(body.recoveryCodes).toHaveLength(8);
      expect(body.enrollmentReward).toEqual({
        type: 'in-game-currency',
        amount: 500,
        description: 'Security Champion Bonus: 500 Gold for enabling MFA'
      });
    });

    it('should require force=true for re-enrollment of existing device', async () => {
      // Mock existing device
      mockSend.mockResolvedValueOnce({
        Item: {
          userId: 'test-user-123',
          deviceId: 'primary',
          verified: true
        }
      });

      const event = createMockEvent({
        userId: 'test-user-123',
        deviceName: 'iPhone 14'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.message).toContain('already enrolled');
    });
  });

  describe('validation', () => {
    it('should return 400 for missing userId', async () => {
      const event = createMockEvent({
        deviceName: 'iPhone 14'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.message).toBe('User ID is required');
    });

    it('should handle empty request body', async () => {
      const event = createMockEvent({});

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
    });
  });

  describe('error handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockSend.mockRejectedValue(new Error('DynamoDB error'));

      const event = createMockEvent({
        userId: 'test-user-123'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      
      const body = JSON.parse(result.body);
      expect(body.success).toBe(false);
      expect(body.message).toBe('Failed to enroll MFA device');
    });

    it('should handle speakeasy errors gracefully', async () => {
      (speakeasy.generateSecret as jest.Mock).mockImplementation(() => {
        throw new Error('Speakeasy error');
      });

      const event = createMockEvent({
        userId: 'test-user-123'
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
    });
  });

  describe('recovery codes generation', () => {
    it('should generate 8 recovery codes by default', async () => {
      const mockSecret = {
        ascii: 'test-ascii-secret',
        base32: 'TEST-BASE32-SECRET'
      };
      (speakeasy.generateSecret as jest.Mock).mockReturnValue(mockSecret);
      (QRCode.toDataURL as jest.Mock).mockResolvedValue('mock-qr-url');

      mockSend
        .mockResolvedValueOnce({ Item: null })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const event = createMockEvent({
        userId: 'test-user-123'
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(body.recoveryCodes).toHaveLength(8);
      expect(body.recoveryCodes[0]).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    });
  });
});