/**
 * Jest Setup for Integration Tests
 * 
 * This configures the test environment and provides global utilities
 * for all integration tests.
 */

import { jest } from '@jest/globals';

// Extend Jest timeout for integration tests
jest.setTimeout(60000);

// Global test setup
beforeAll(async () => {
  // Suppress console logs during tests (unless debugging)
  if (!process.env.DEBUG_TESTS) {
    global.console = {
      ...console,
      log: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: console.error // Keep errors visible
    };
  }

  // Set AWS configuration for tests
  process.env.AWS_REGION = process.env.TEST_REGION || 'eu-north-1';
  
  // Ensure we don't accidentally hit production
  if (process.env.TEST_ENV === 'production') {
    throw new Error('Cannot run integration tests against production environment');
  }
});

// Global test teardown
afterAll(async () => {
  // Add any global cleanup here
});

// Add custom matchers for JWT testing
expect.extend({
  toBeValidJWT(received: string) {
    const isValid = typeof received === 'string' && received.split('.').length === 3;
    
    if (isValid) {
      return {
        message: () => `Expected ${received} not to be a valid JWT`,
        pass: true
      };
    } else {
      return {
        message: () => `Expected ${received} to be a valid JWT (three parts separated by dots)`,
        pass: false
      };
    }
  },

  toHaveLatencyBelow(received: { latency: number }, expected: number) {
    const pass = received.latency < expected;
    
    if (pass) {
      return {
        message: () => `Expected latency ${received.latency}ms not to be below ${expected}ms`,
        pass: true
      };
    } else {
      return {
        message: () => `Expected latency ${received.latency}ms to be below ${expected}ms`,
        pass: false
      };
    }
  },

  toHaveCedarClaims(received: any) {
    const requiredClaims = [
      'custom:cedarEntityId',
      'custom:groups',
      'custom:permissions'
    ];
    
    const missingClaims = requiredClaims.filter(claim => !received[claim]);
    
    if (missingClaims.length === 0) {
      return {
        message: () => `Expected token not to have Cedar claims`,
        pass: true
      };
    } else {
      return {
        message: () => `Expected token to have Cedar claims: ${missingClaims.join(', ')}`,
        pass: false
      };
    }
  }
});

// Declare custom matchers for TypeScript
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidJWT(): R;
      toHaveLatencyBelow(ms: number): R;
      toHaveCedarClaims(): R;
    }
  }
}

// Add performance tracking utilities
(global as any).performanceTracker = {
  start: (label: string) => {
    const start = process.hrtime.bigint();
    return {
      end: () => {
        const end = process.hrtime.bigint();
        const duration = Number(end - start) / 1_000_000; // Convert to milliseconds
        return { label, duration };
      }
    };
  }
};

// Environment validation - only warn in non-CI environments
if (!process.env.CI) {
  const requiredEnvVars = [
    'TEST_ENV'
  ];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      console.warn(`Warning: ${envVar} environment variable is not set`);
    }
  }
}

// Configure AWS for testing
// Using AWS SDK v3, no global config needed - clients handle their own region/credentials

export {};