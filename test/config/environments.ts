/**
 * Environment Configuration for Integration Tests
 * 
 * This centralizes all environment-specific settings for our integration test suite,
 * replacing the hard-coded URLs in bash scripts with maintainable configuration.
 */

export interface EnvironmentConfig {
  name: string;
  apiUrl: string;
  region: string;
  cognito: {
    userPoolId: string;
    clientId?: string;
    domain?: string;
  };
  awsProfile: string;
  performance: {
    maxResponseTime: number;
    maxConcurrentUsers: number;
    targetThroughput: number;
  };
  features: {
    cedarAuthorization: boolean;
    tokenEnrichment: boolean;
    sessionTracking: boolean;
  };
}

export const environments: Record<string, EnvironmentConfig> = {
  test: {
    name: 'test',
    apiUrl: 'https://rofefpdvc2.execute-api.eu-north-1.amazonaws.com/prod',
    region: 'eu-north-1',
    cognito: {
      userPoolId: 'eu-north-1_mn0zGxlAZ', // Test environment User Pool (correct ID)
      clientId: '26bt260p5jeu7o89po4acqdlvk', // Player client ID
      domain: 'loupeen-test-auth'
    },
    awsProfile: 'AWSAdministratorAccess-728427470046',
    performance: {
      maxResponseTime: 1000, // 1s max for test environment
      maxConcurrentUsers: 50,
      targetThroughput: 100 // requests per minute
    },
    features: {
      cedarAuthorization: true,
      tokenEnrichment: true,
      sessionTracking: true
    }
  },
  
  qa: {
    name: 'qa',
    apiUrl: 'https://k1lyuds5y5.execute-api.us-east-1.amazonaws.com/prod',
    region: 'us-east-1',
    cognito: {
      userPoolId: 'us-east-1_kgI32QiAb', // QA environment User Pool
      domain: 'loupeen-qa-auth'
    },
    awsProfile: 'AWSAdministratorAccess-077029784291',
    performance: {
      maxResponseTime: 500, // Stricter for QA
      maxConcurrentUsers: 100,
      targetThroughput: 200
    },
    features: {
      cedarAuthorization: true,
      tokenEnrichment: true,
      sessionTracking: true
    }
  },
  
  production: {
    name: 'production',
    apiUrl: '', // Will be configured when production is ready
    region: 'eu-north-1',
    cognito: {
      userPoolId: '', // Production User Pool TBD
      domain: 'loupeen-auth'
    },
    awsProfile: 'AWSAdministratorAccess-PRODUCTION', // TBD
    performance: {
      maxResponseTime: 300, // Strict production requirements
      maxConcurrentUsers: 1000,
      targetThroughput: 1000
    },
    features: {
      cedarAuthorization: true,
      tokenEnrichment: true,
      sessionTracking: true
    }
  }
};

/**
 * Get environment configuration with validation
 */
export function getEnvironment(name: string = 'test'): EnvironmentConfig {
  const env = environments[name];
  if (!env) {
    throw new Error(`Unknown environment: ${name}. Available: ${Object.keys(environments).join(', ')}`);
  }
  
  // Validate required fields
  if (!env.apiUrl) {
    throw new Error(`Missing apiUrl for environment: ${name}`);
  }
  
  if (!env.cognito.userPoolId) {
    throw new Error(`Missing Cognito User Pool ID for environment: ${name}`);
  }
  
  return env;
}

/**
 * Get current environment from NODE_ENV or TEST_ENV
 */
export function getCurrentEnvironment(): EnvironmentConfig {
  const envName = process.env.TEST_ENV || process.env.NODE_ENV || 'test';
  return getEnvironment(envName);
}