/**
 * Enhanced JWT-Cedar Authentication Flow Integration Test
 * 
 * This comprehensive test replaces the bash scripts and tests the complete
 * authentication and authorization flow with Cedar policies.
 */

import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import { GameAuthApiClient } from '../../helpers/api-client';
import { CognitoTestClient } from '../../helpers/cognito-client';
import { TestDataFactory } from '../../helpers/test-data-factory';
import { JWTDecoder } from '../../helpers/jwt-decoder';
import { getEnvironment } from '../../config/environments';
import type { TestUser, EnhancedValidationResult, TestSuiteResult } from '../../types/test-types';

// This test suite is for future enhanced JWT-Cedar functionality
// Currently has circular JSON errors and tests endpoints that don't exist
// For current JWT functionality, see jwt-integration.test.ts
describe.skip('Enhanced JWT-Cedar Authentication Flow', () => {
  let apiClient: GameAuthApiClient;
  let cognitoClient: CognitoTestClient;
  let testDataFactory: TestDataFactory;
  let jwtDecoder: JWTDecoder;
  let testUsers: {
    player: TestUser;
    premiumPlayer: TestUser;
    allianceMember: TestUser;
    admin: TestUser;
    moderator: TestUser;
  };

  const environment = getEnvironment();
  const testResults: TestSuiteResult = {
    suiteName: 'Enhanced JWT-Cedar Authentication Flow',
    environment: environment.name,
    startTime: new Date(),
    endTime: new Date(),
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    results: [],
    performance: {
      averageResponseTime: 0,
      maxResponseTime: 0,
      minResponseTime: Number.MAX_VALUE,
      throughput: 0
    }
  };

  beforeAll(async () => {
    // Initialize clients
    apiClient = new GameAuthApiClient(environment.apiUrl);
    cognitoClient = CognitoTestClient.fromEnvironment(environment);
    testDataFactory = TestDataFactory.fromEnvironment(environment, {
      reuseUsers: true,
      cleanupOnExit: false // Keep users for debugging
    });
    jwtDecoder = new JWTDecoder();

    // Test API connectivity first
    const connectivity = await apiClient.testConnection();
    if (!connectivity.healthy) {
      throw new Error(`API not healthy: ${JSON.stringify(connectivity.endpoints)}`);
    }

    // Create comprehensive test user set
    testUsers = await testDataFactory.createTestUserSet();
    
    console.log(`Test suite initialized with ${Object.keys(testUsers).length} users`);
  });

  afterAll(async () => {
    testResults.endTime = new Date();
    
    // Calculate final performance metrics
    const durations = testResults.results.map(r => r.duration);
    if (durations.length > 0) {
      testResults.performance.averageResponseTime = durations.reduce((a, b) => a + b, 0) / durations.length;
      testResults.performance.maxResponseTime = Math.max(...durations);
      testResults.performance.minResponseTime = Math.min(...durations);
      testResults.performance.throughput = testResults.results.length / 
        ((testResults.endTime.getTime() - testResults.startTime.getTime()) / 1000);
    }

    // Log comprehensive test summary
    console.log('\n🎯 Test Suite Summary:');
    console.log(`Environment: ${testResults.environment}`);
    console.log(`Total Tests: ${testResults.totalTests}`);
    console.log(`Passed: ${testResults.passedTests}`);
    console.log(`Failed: ${testResults.failedTests}`);
    console.log(`Success Rate: ${((testResults.passedTests / testResults.totalTests) * 100).toFixed(1)}%`);
    console.log(`Average Response Time: ${testResults.performance.averageResponseTime.toFixed(0)}ms`);
    console.log(`Max Response Time: ${testResults.performance.maxResponseTime.toFixed(0)}ms`);
    console.log(`Throughput: ${testResults.performance.throughput.toFixed(2)} requests/second`);
  });

  describe('🔐 Authentication & Token Generation', () => {
    it('should authenticate player and generate Cedar-enriched tokens', async () => {
      const startTime = Date.now();
      
      const authResult = await apiClient.authenticate({
        username: testUsers.player.username,
        password: testUsers.player.password
      });

      const duration = Date.now() - startTime;
      testResults.totalTests++;

      expect(authResult.accessToken).toBeDefined();
      expect(authResult.idToken).toBeDefined();
      expect(authResult.refreshToken).toBeDefined();

      // Validate JWT format (3 parts separated by dots)
      expect(authResult.accessToken.split('.')).toHaveLength(3);
      expect(authResult.idToken.split('.')).toHaveLength(3);

      // Decode and validate ID token contains Cedar enrichment
      const idClaims = jwtDecoder.decode(authResult.idToken);
      expect(idClaims['custom:cedarEntityId']).toBeDefined();
      expect(idClaims['custom:groups']).toBeDefined();
      expect(idClaims['custom:permissions']).toBeDefined();
      
      // Validate specific Cedar claims
      expect(idClaims['custom:cedarEntityId']).toBe(testUsers.player.id);
      expect(idClaims['custom:environment']).toBe(environment.name);
      
      // Parse and validate arrays
      const groups = JSON.parse(idClaims['custom:groups'] || '[]');
      const permissions = JSON.parse(idClaims['custom:permissions'] || '[]');
      
      expect(groups).toContain('Players');
      expect(permissions).toContain('login');
      expect(permissions).toContain('viewProfile');

      // Store tokens for later tests
      testUsers.player.tokens = authResult;
      
      testResults.passedTests++;
      testResults.results.push({
        name: 'Player Authentication with Cedar Enrichment',
        passed: true,
        duration
      });
    }, 10000);

    it('should authenticate premium player with enhanced permissions', async () => {
      const startTime = Date.now();
      
      const authResult = await apiClient.authenticate({
        username: testUsers.premiumPlayer.username,
        password: testUsers.premiumPlayer.password
      });

      const duration = Date.now() - startTime;
      testResults.totalTests++;

      const idClaims = jwtDecoder.decode(authResult.idToken);
      expect(idClaims['custom:isPremium']).toBe('true');
      
      const permissions = JSON.parse(idClaims['custom:permissions'] || '[]');
      expect(permissions).toContain('premiumFeatures');
      expect(permissions).toContain('prioritySupport');

      testUsers.premiumPlayer.tokens = authResult;
      
      testResults.passedTests++;
      testResults.results.push({
        name: 'Premium Player Authentication',
        passed: true,
        duration
      });
    });

    it('should authenticate admin with administrative permissions', async () => {
      const startTime = Date.now();
      
      const authResult = await apiClient.authenticate({
        username: testUsers.admin.username,
        password: testUsers.admin.password
      });

      const duration = Date.now() - startTime;
      testResults.totalTests++;

      const idClaims = jwtDecoder.decode(authResult.idToken);
      const roles = JSON.parse(idClaims['custom:roles'] || '[]');
      const permissions = JSON.parse(idClaims['custom:permissions'] || '[]');
      
      expect(roles).toContain('Admin');
      expect(permissions).toContain('banUser');
      expect(permissions).toContain('modifyGame');
      expect(permissions).toContain('viewAnalytics');

      testUsers.admin.tokens = authResult;
      
      testResults.passedTests++;
      testResults.results.push({
        name: 'Admin Authentication',
        passed: true,
        duration
      });
    });
  });

  describe('🛡️ Enhanced JWT-Cedar Authorization', () => {
    it('should validate player token without specific action', async () => {
      const result = await apiClient.validateEnhanced({
        token: testUsers.player.tokens!.accessToken
      });

      testResults.totalTests++;
      
      expect(result.valid).toBe(true);
      expect(result.user).toBeDefined();
      expect(result.user.userType).toBe('player');
      expect(result.user.level).toBe(1);
      expect(result.sessionInfo.tokenValid).toBe(true);
      expect(result.latency).toBeLessThan(environment.performance.maxResponseTime);

      testResults.passedTests++;
      testResults.results.push({
        name: 'Basic Token Validation',
        passed: true,
        duration: result.latency
      });
    });

    it('should authorize collectResources action for player', async () => {
      const result = await apiClient.validateEnhanced({
        token: testUsers.player.tokens!.accessToken,
        action: {
          actionType: 'Action',
          actionId: 'collectResources'
        },
        resource: {
          entityType: 'Base',
          entityId: `player-base-${testUsers.player.id}`
        }
      });

      testResults.totalTests++;

      expect(result.valid).toBe(true);
      expect(result.authorizationResult).toBeDefined();
      expect(result.authorizationResult!.decision).toBe('ALLOW');
      expect(result.permissions).toContain('collectResources');

      testResults.passedTests++;
      testResults.results.push({
        name: 'Player Resource Collection Authorization',
        passed: true,
        duration: result.latency
      });
    });

    it('should authorize premium features for premium player', async () => {
      const result = await apiClient.validateEnhanced({
        token: testUsers.premiumPlayer.tokens!.accessToken,
        action: {
          actionType: 'Action',
          actionId: 'usePremiumFeature'
        },
        resource: {
          entityType: 'Feature',
          entityId: 'premium-boost'
        }
      });

      testResults.totalTests++;

      expect(result.valid).toBe(true);
      expect(result.user.isPremium).toBe(true);
      expect(result.permissions).toContain('premiumFeatures');
      
      // Premium players should have ALLOW decision for premium features
      if (result.authorizationResult) {
        expect(result.authorizationResult.decision).toBe('ALLOW');
      }

      testResults.passedTests++;
      testResults.results.push({
        name: 'Premium Feature Authorization',
        passed: true,
        duration: result.latency
      });
    });

    it('should deny admin actions for regular player', async () => {
      const result = await apiClient.validateEnhanced({
        token: testUsers.player.tokens!.accessToken,
        action: {
          actionType: 'Action',
          actionId: 'banUser'
        },
        resource: {
          entityType: 'User',
          entityId: 'target-user-123'
        }
      });

      testResults.totalTests++;

      expect(result.valid).toBe(true); // Token is valid
      expect(result.user.userType).toBe('player');
      expect(result.permissions).not.toContain('banUser');
      
      // Should be denied for non-admin user
      if (result.authorizationResult) {
        expect(result.authorizationResult.decision).toBe('DENY');
      }

      testResults.passedTests++;
      testResults.results.push({
        name: 'Admin Action Denial for Player',
        passed: true,
        duration: result.latency
      });
    });

    it('should authorize admin actions for admin user', async () => {
      const result = await apiClient.validateEnhanced({
        token: testUsers.admin.tokens!.accessToken,
        action: {
          actionType: 'Action',
          actionId: 'banUser'
        },
        resource: {
          entityType: 'User',
          entityId: 'target-user-123'
        }
      });

      testResults.totalTests++;

      expect(result.valid).toBe(true);
      expect(result.user.userType).toBe('admin');
      expect(result.permissions).toContain('banUser');
      
      if (result.authorizationResult) {
        expect(result.authorizationResult.decision).toBe('ALLOW');
      }

      testResults.passedTests++;
      testResults.results.push({
        name: 'Admin Action Authorization',
        passed: true,
        duration: result.latency
      });
    });
  });

  describe('⚡ Performance & Reliability', () => {
    it('should maintain performance under concurrent load', async () => {
      const concurrentRequests = Math.min(environment.performance.maxConcurrentUsers, 10);
      const latencies: number[] = [];
      
      const promises = Array(concurrentRequests).fill(0).map(async (_, index) => {
        const result = await apiClient.validateEnhanced({
          token: testUsers.player.tokens!.accessToken,
          action: {
            actionType: 'Action',
            actionId: 'collectResources'
          },
          resource: {
            entityType: 'Base',
            entityId: `concurrent-test-${index}`
          }
        });
        
        latencies.push(result.latency);
        return result;
      });

      const results = await Promise.all(promises);
      testResults.totalTests++;

      // All requests should succeed
      results.forEach(result => {
        expect(result.valid).toBe(true);
      });

      // Performance validation
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      
      expect(avgLatency).toBeLessThan(environment.performance.maxResponseTime);
      expect(maxLatency).toBeLessThan(environment.performance.maxResponseTime * 2);

      testResults.passedTests++;
      testResults.results.push({
        name: `Concurrent Load Test (${concurrentRequests} requests)`,
        passed: true,
        duration: avgLatency,
        metadata: {
          concurrentRequests,
          avgLatency,
          maxLatency,
          minLatency: Math.min(...latencies)
        }
      });
    });

    it('should handle token refresh correctly', async () => {
      const startTime = Date.now();
      
      const refreshResult = await apiClient.refreshToken(
        testUsers.player.tokens!.refreshToken,
        testUsers.player.deviceId
      );

      const duration = Date.now() - startTime;
      testResults.totalTests++;

      expect(refreshResult.data.accessToken).toBeDefined();
      expect(refreshResult.data.accessToken.split('.')).toHaveLength(3);
      expect(refreshResult.data.accessToken).not.toBe(testUsers.player.tokens!.accessToken);

      // Update stored tokens
      testUsers.player.tokens!.accessToken = refreshResult.data.accessToken;

      testResults.passedTests++;
      testResults.results.push({
        name: 'Token Refresh',
        passed: true,
        duration
      });
    });
  });

  describe('🚨 Error Handling & Security', () => {
    it('should reject invalid tokens', async () => {
      const startTime = Date.now();
      
      const result = await apiClient.validateEnhanced({
        token: 'invalid.token.here'
      });

      const duration = Date.now() - startTime;
      testResults.totalTests++;

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();

      testResults.passedTests++;
      testResults.results.push({
        name: 'Invalid Token Rejection',
        passed: true,
        duration
      });
    });

    it('should handle malformed requests gracefully', async () => {
      try {
        await apiClient.generateToken({
          username: '',
          password: '',
          deviceId: '',
          userType: ''
        });
        
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: any) {
        testResults.totalTests++;
        
        // Expect 400 Bad Request for malformed input
        expect(error.response?.status).toBe(400);
        
        testResults.passedTests++;
        testResults.results.push({
          name: 'Malformed Request Handling',
          passed: true,
          duration: 0
        });
      }
    });

    it('should properly revoke tokens', async () => {
      const startTime = Date.now();
      
      // Use a separate token for revocation test
      const testToken = testUsers.moderator.tokens?.accessToken || 'test-token';
      
      const revokeResult = await apiClient.revokeToken(testToken, 'Integration test cleanup');
      const duration = Date.now() - startTime;
      testResults.totalTests++;

      expect(revokeResult.status).toBe(200);

      testResults.passedTests++;
      testResults.results.push({
        name: 'Token Revocation',
        passed: true,
        duration
      });
    });
  });

  describe('📊 System Health & Monitoring', () => {
    it('should report comprehensive system health', async () => {
      const healthResult = await apiClient.testConnection();
      testResults.totalTests++;

      expect(healthResult.healthy).toBe(true);
      expect(healthResult.latency).toBeLessThan(environment.performance.maxResponseTime);
      expect(healthResult.endpoints.health).toBe(true);

      testResults.passedTests++;
      testResults.results.push({
        name: 'System Health Check',
        passed: true,
        duration: healthResult.latency
      });
    });

    it('should meet performance benchmarks', async () => {
      const performanceTest = await apiClient.measurePerformance(
        async () => {
          return apiClient.validateEnhanced({
            token: testUsers.player.tokens!.accessToken
          });
        },
        5 // 5 requests
      );

      testResults.totalTests++;

      expect(performanceTest.average).toBeLessThan(environment.performance.maxResponseTime);
      expect(performanceTest.max).toBeLessThan(environment.performance.maxResponseTime * 1.5);
      
      // Log performance metrics
      console.log(`Performance Benchmark - Avg: ${performanceTest.average.toFixed(0)}ms, Max: ${performanceTest.max.toFixed(0)}ms, Min: ${performanceTest.min.toFixed(0)}ms`);

      testResults.passedTests++;
      testResults.results.push({
        name: 'Performance Benchmark',
        passed: true,
        duration: performanceTest.average,
        metadata: {
          average: performanceTest.average,
          min: performanceTest.min,
          max: performanceTest.max,
          requests: performanceTest.requests
        }
      });
    });
  });
});