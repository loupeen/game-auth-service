import axios, { AxiosResponse } from 'axios';
import * as speakeasy from 'speakeasy';

describe('MFA Integration Tests', () => {
  const apiUrl = process.env.API_URL || 'https://api-test.loupeen.com';
  const testUserId = 'integration-test-user-' + Date.now();
  
  let enrollmentData: any;
  let totpSecret: string;

  beforeAll(async () => {
    // Skip if no API URL is configured
    if (!process.env.API_URL) {
      console.log('Skipping integration tests - API_URL not configured');
      return;
    }
  });

  afterAll(async () => {
    // Clean up test data if needed
    if (process.env.API_URL && enrollmentData) {
      try {
        // Revoke any test devices created
        await axios.delete(`${apiUrl}/mfa/devices`, {
          data: {
            userId: testUserId,
            deviceId: 'primary'
          }
        });
      } catch (error) {
        // Ignore cleanup errors
        console.log('Cleanup warning:', error.message);
      }
    }
  });

  describe('MFA Enrollment Flow', () => {
    it('should enroll a new MFA device', async () => {
      if (!process.env.API_URL) return;

      const response: AxiosResponse = await axios.post(`${apiUrl}/mfa/enroll`, {
        userId: testUserId,
        deviceName: 'Integration Test Device',
        userPoolType: 'player'
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.qrCodeUrl).toMatch(/^data:image\/png;base64,/);
      expect(response.data.secret).toBeDefined();
      expect(response.data.recoveryCodes).toHaveLength(8);
      expect(response.data.enrollmentReward).toEqual({
        type: 'in-game-currency',
        amount: 500,
        description: 'Security Champion Bonus: 500 Gold for enabling MFA'
      });

      // Store enrollment data for subsequent tests
      enrollmentData = response.data;
      totpSecret = response.data.secret;
    });

    it('should prevent duplicate enrollment without force flag', async () => {
      if (!process.env.API_URL || !enrollmentData) return;

      try {
        await axios.post(`${apiUrl}/mfa/enroll`, {
          userId: testUserId,
          deviceName: 'Duplicate Device'
        });
        
        throw new Error('Should have thrown error for duplicate enrollment');
      } catch (error) {
        expect(error.response?.status).toBe(409);
        expect(error.response?.data.success).toBe(false);
        expect(error.response?.data.message).toContain('already enrolled');
      }
    });
  });

  describe('MFA Verification Flow', () => {
    it('should verify valid TOTP code', async () => {
      if (!process.env.API_URL || !totpSecret) return;

      // Generate valid TOTP token
      const token = speakeasy.totp({
        secret: totpSecret,
        encoding: 'base32'
      });

      const response: AxiosResponse = await axios.post(`${apiUrl}/mfa/verify`, {
        userId: testUserId,
        code: token,
        clientMetadata: {
          ipAddress: '192.168.1.100',
          userAgent: 'Jest Integration Test',
          deviceFingerprint: 'test-device-fingerprint'
        }
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.verified).toBe(true);
      expect(response.data.riskScore).toBeLessThan(0.5); // Should be low risk
    });

    it('should reject invalid TOTP code', async () => {
      if (!process.env.API_URL) return;

      try {
        await axios.post(`${apiUrl}/mfa/verify`, {
          userId: testUserId,
          code: '000000' // Invalid code
        });
        
        throw new Error('Should have rejected invalid TOTP code');
      } catch (error) {
        expect(error.response?.status).toBe(401);
        expect(error.response?.data.success).toBe(false);
        expect(error.response?.data.verified).toBe(false);
      }
    });

    it('should verify recovery code', async () => {
      if (!process.env.API_URL || !enrollmentData) return;

      const recoveryCode = enrollmentData.recoveryCodes[0];

      const response: AxiosResponse = await axios.post(`${apiUrl}/mfa/verify`, {
        userId: testUserId,
        code: recoveryCode,
        isRecoveryCode: true
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.verified).toBe(true);
    });

    it('should reject used recovery code', async () => {
      if (!process.env.API_URL || !enrollmentData) return;

      const usedRecoveryCode = enrollmentData.recoveryCodes[0];

      try {
        await axios.post(`${apiUrl}/mfa/verify`, {
          userId: testUserId,
          code: usedRecoveryCode,
          isRecoveryCode: true
        });
        
        throw new Error('Should have rejected used recovery code');
      } catch (error) {
        expect(error.response?.status).toBe(401);
        expect(error.response?.data.success).toBe(false);
        expect(error.response?.data.message).toContain('already been used');
      }
    });
  });

  describe('Device Trust Management', () => {
    it('should register a new trusted device', async () => {
      if (!process.env.API_URL) return;

      const response: AxiosResponse = await axios.post(`${apiUrl}/mfa/devices`, {
        userId: testUserId,
        action: 'register',
        deviceData: {
          deviceFingerprint: 'test-device-' + Date.now(),
          deviceName: 'Integration Test Device',
          userAgent: 'Jest Integration Test',
          ipAddress: '192.168.1.100',
          location: 'Test Location'
        }
      });

      expect(response.status).toBe(201);
      expect(response.data.success).toBe(true);
      expect(response.data.device).toBeDefined();
      expect(response.data.device.trusted).toBe(false); // Not trusted until verified
      expect(response.data.device.trustLevel).toBeDefined();
    });

    it('should list trusted devices', async () => {
      if (!process.env.API_URL) return;

      const response: AxiosResponse = await axios.post(`${apiUrl}/mfa/devices`, {
        userId: testUserId,
        action: 'list'
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.devices).toBeInstanceOf(Array);
      expect(response.data.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('SMS Fallback', () => {
    it('should handle SMS send request gracefully', async () => {
      if (!process.env.API_URL) return;

      try {
        await axios.post(`${apiUrl}/mfa/sms`, {
          userId: testUserId,
          action: 'send',
          phoneNumber: '+1234567890' // Test phone number
        });
        
        // SMS might fail due to missing phone number in test environment
        // This test mainly ensures the endpoint is reachable
      } catch (error) {
        // Accept 400 errors for missing phone configuration in test env
        expect([400, 429].includes(error.response?.status)).toBe(true);
      }
    });
  });

  describe('Risk Assessment', () => {
    it('should assess login risk factors', async () => {
      if (!process.env.API_URL) return;

      const response: AxiosResponse = await axios.post(`${apiUrl}/mfa/risk`, {
        userId: testUserId,
        action: 'assess',
        sessionData: {
          ipAddress: '192.168.1.100',
          userAgent: 'Jest Integration Test',
          deviceFingerprint: 'test-device-fingerprint',
          location: 'Test Location',
          timestamp: new Date().toISOString()
        }
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.assessment).toBeDefined();
      expect(response.data.assessment.overallRiskScore).toBeGreaterThanOrEqual(0);
      expect(response.data.assessment.overallRiskScore).toBeLessThanOrEqual(1);
      expect(response.data.assessment.recommendedAction).toMatch(/^(allow|challenge|block)$/);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed requests gracefully', async () => {
      if (!process.env.API_URL) return;

      try {
        await axios.post(`${apiUrl}/mfa/enroll`, {
          invalidField: 'invalid-data'
        });
        
        throw new Error('Should have returned validation error');
      } catch (error) {
        expect(error.response?.status).toBe(400);
        expect(error.response?.data.success).toBe(false);
      }
    });

    it('should handle non-existent endpoints', async () => {
      if (!process.env.API_URL) return;

      try {
        await axios.get(`${apiUrl}/mfa/nonexistent`);
        
        throw new Error('Should have returned 404');
      } catch (error) {
        expect(error.response?.status).toBe(404);
      }
    });
  });
});