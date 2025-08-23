/**
 * Environment Configuration for Game Auth Service
 * 
 * This module provides environment-specific configurations for the JWT Management System.
 * TODO: Replace with @loupeen/shared-config-library when available (Issue #6).
 */

export type Environment = 'test' | 'qa' | 'production';

interface EnvironmentConfig {
  environment: Environment;
  region: string;
  accountId: string;
  naming: {
    userPoolPlayer: string;
    userPoolAdmin: string;
    sessionsTable: string;
    refreshTokensTable: string;
    rateLimitTable: string;
    revokedTokensTable: string;
    apiGateway: string;
  };
  features: {
    socialLogin: boolean;
    mfaRequired: boolean;
    detailedMetrics: boolean;
    xrayTracing: boolean;
  };
  security: {
    deletionProtection: boolean;
    encryptionAtRest: boolean;
    pointInTimeRecovery: boolean;
    auditLogging: boolean;
  };
  monitoring: {
    cloudWatch: boolean;
    synthetics: boolean;
  };
  performance: {
    lambdaMemory: number;
    dbBilling: 'PAY_PER_REQUEST' | 'PROVISIONED';
  };
  budget: {
    monthly: number;
    alertThreshold: number;
  };
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
    readCapacity?: number;
    writeCapacity?: number;
    pointInTimeRecovery: boolean;
  };
  lambda: {
    memorySize: number;
    timeout: number;
    reservedConcurrency?: number;
    architecture: 'x86_64' | 'arm64';
  };
  jwt: {
    accessTokenExpiry: number;
    refreshTokenExpiry: number;
    signingAlgorithm: string;
    issuer: string;
    audience: string;
  };
  apiGateway: {
    throttle: {
      rateLimit: number;
      burstLimit: number;
    };
    quota: {
      limit: number;
    };
  };
  cognito: {
    passwordPolicy: {
      minimumLength: number;
      requireLowercase: boolean;
      requireNumbers: boolean;
      requireSymbols: boolean;
      requireUppercase: boolean;
    };
    mfaConfiguration: 'OFF' | 'ON' | 'OPTIONAL';
    usernameAttributes: ('email' | 'phone_number')[];
    allowUnauthenticatedIdentities: boolean;
    playerPool: {
      selfSignUpEnabled: boolean;
      mfaRequired: boolean;
      passwordPolicy: {
        minLength: number;
        requireLowercase: boolean;
        requireNumbers: boolean;
        requireSymbols: boolean;
        requireUppercase: boolean;
      };
    };
    adminPool: {
      selfSignUpEnabled: boolean;
      mfaRequired: boolean;
      passwordPolicy: {
        minLength: number;
        requireLowercase: boolean;
        requireNumbers: boolean;
        requireSymbols: boolean;
        requireUppercase: boolean;
      };
    };
  };
}

/**
 * Get comprehensive configuration for the Game Auth Service
 */
export function getGameAuthConfig(environment: string, region?: string): EnvironmentConfig {
  // Parse environment to ensure type safety
  const env = environment.toLowerCase() as Environment;
  
  // Simple configuration (will be replaced with shared-config-library)
  const configs: Record<Environment, Omit<EnvironmentConfig, 'region'>> = {
    test: {
      environment: 'test',
      accountId: '728427470046',
      naming: {
        userPoolPlayer: 'loupeen-players-test',
        userPoolAdmin: 'loupeen-admins-test',
        sessionsTable: 'game-auth-sessions-test',
        refreshTokensTable: 'game-auth-refresh-tokens-test',
        rateLimitTable: 'game-auth-rate-limits-test',
        revokedTokensTable: 'game-auth-revoked-tokens-test',
        apiGateway: 'loupeen-auth-api-test'
      },
      features: {
        socialLogin: false,
        mfaRequired: false,
        detailedMetrics: true,
        xrayTracing: false
      },
      security: {
        deletionProtection: false,
        encryptionAtRest: true,
        pointInTimeRecovery: true,
        auditLogging: true
      },
      monitoring: {
        cloudWatch: true,
        synthetics: false
      },
      performance: {
        lambdaMemory: 512,
        dbBilling: 'PAY_PER_REQUEST'
      },
      budget: {
        monthly: 200,
        alertThreshold: 150
      },
      dynamodb: {
        billingMode: 'PAY_PER_REQUEST',
        readCapacity: 5,
        writeCapacity: 5,
        pointInTimeRecovery: true
      },
      lambda: {
        memorySize: 512,
        timeout: 30,
        reservedConcurrency: 10,
        architecture: 'arm64'
      },
      jwt: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 2592000,
        signingAlgorithm: 'HS256',
        issuer: 'loupeen-auth-test',
        audience: 'loupeen-players-test'
      },
      apiGateway: {
        throttle: {
          rateLimit: 100,
          burstLimit: 200
        },
        quota: {
          limit: 10000
        }
      },
      cognito: {
        passwordPolicy: {
          minimumLength: 8,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: false,
          requireUppercase: true
        },
        mfaConfiguration: 'OFF',
        usernameAttributes: ['email'],
        allowUnauthenticatedIdentities: false,
        playerPool: {
          selfSignUpEnabled: true,
          mfaRequired: false,
          passwordPolicy: {
            minLength: 8,
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: false,
            requireUppercase: true
          }
        },
        adminPool: {
          selfSignUpEnabled: false,
          mfaRequired: false,
          passwordPolicy: {
            minLength: 10,
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: true,
            requireUppercase: true
          }
        }
      }
    },
    qa: {
      environment: 'qa',
      accountId: '077029784291',
      naming: {
        userPoolPlayer: 'loupeen-players-qa',
        userPoolAdmin: 'loupeen-admins-qa',
        sessionsTable: 'game-auth-sessions-qa',
        refreshTokensTable: 'game-auth-refresh-tokens-qa',
        rateLimitTable: 'game-auth-rate-limits-qa',
        revokedTokensTable: 'game-auth-revoked-tokens-qa',
        apiGateway: 'loupeen-auth-api-qa'
      },
      features: {
        socialLogin: true,
        mfaRequired: true,
        detailedMetrics: true,
        xrayTracing: true
      },
      security: {
        deletionProtection: true,
        encryptionAtRest: true,
        pointInTimeRecovery: true,
        auditLogging: true
      },
      monitoring: {
        cloudWatch: true,
        synthetics: true
      },
      performance: {
        lambdaMemory: 1024,
        dbBilling: 'PAY_PER_REQUEST'
      },
      budget: {
        monthly: 150,
        alertThreshold: 100
      },
      dynamodb: {
        billingMode: 'PAY_PER_REQUEST',
        readCapacity: 10,
        writeCapacity: 10,
        pointInTimeRecovery: true
      },
      lambda: {
        memorySize: 1024,
        timeout: 30,
        reservedConcurrency: 25,
        architecture: 'arm64'
      },
      jwt: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 2592000,
        signingAlgorithm: 'HS256',
        issuer: 'loupeen-auth-qa',
        audience: 'loupeen-players-qa'
      },
      apiGateway: {
        throttle: {
          rateLimit: 500,
          burstLimit: 1000
        },
        quota: {
          limit: 50000
        }
      },
      cognito: {
        passwordPolicy: {
          minimumLength: 10,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: true,
          requireUppercase: true
        },
        mfaConfiguration: 'OPTIONAL',
        usernameAttributes: ['email'],
        allowUnauthenticatedIdentities: false,
        playerPool: {
          selfSignUpEnabled: true,
          mfaRequired: false,
          passwordPolicy: {
            minLength: 10,
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: true,
            requireUppercase: true
          }
        },
        adminPool: {
          selfSignUpEnabled: false,
          mfaRequired: true,
          passwordPolicy: {
            minLength: 12,
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: true,
            requireUppercase: true
          }
        }
      }
    },
    production: {
      environment: 'production',
      accountId: 'TBD',
      naming: {
        userPoolPlayer: 'loupeen-players-prod',
        userPoolAdmin: 'loupeen-admins-prod',
        sessionsTable: 'game-auth-sessions-prod',
        refreshTokensTable: 'game-auth-refresh-tokens-prod',
        rateLimitTable: 'game-auth-rate-limits-prod',
        revokedTokensTable: 'game-auth-revoked-tokens-prod',
        apiGateway: 'loupeen-auth-api-prod'
      },
      features: {
        socialLogin: true,
        mfaRequired: true,
        detailedMetrics: true,
        xrayTracing: true
      },
      security: {
        deletionProtection: true,
        encryptionAtRest: true,
        pointInTimeRecovery: true,
        auditLogging: true
      },
      monitoring: {
        cloudWatch: true,
        synthetics: true
      },
      performance: {
        lambdaMemory: 1024,
        dbBilling: 'PROVISIONED'
      },
      budget: {
        monthly: 1000,
        alertThreshold: 800
      },
      dynamodb: {
        billingMode: 'PROVISIONED',
        readCapacity: 50,
        writeCapacity: 50,
        pointInTimeRecovery: true
      },
      lambda: {
        memorySize: 1024,
        timeout: 30,
        reservedConcurrency: 100,
        architecture: 'arm64'
      },
      jwt: {
        accessTokenExpiry: 900,
        refreshTokenExpiry: 2592000,
        signingAlgorithm: 'RS256',
        issuer: 'loupeen-auth-prod',
        audience: 'loupeen-players-prod'
      },
      apiGateway: {
        throttle: {
          rateLimit: 2000,
          burstLimit: 5000
        },
        quota: {
          limit: 1000000
        }
      },
      cognito: {
        passwordPolicy: {
          minimumLength: 12,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: true,
          requireUppercase: true
        },
        mfaConfiguration: 'ON',
        usernameAttributes: ['email'],
        allowUnauthenticatedIdentities: false,
        playerPool: {
          selfSignUpEnabled: true,
          mfaRequired: true,
          passwordPolicy: {
            minLength: 12,
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: true,
            requireUppercase: true
          }
        },
        adminPool: {
          selfSignUpEnabled: false,
          mfaRequired: true,
          passwordPolicy: {
            minLength: 14,
            requireLowercase: true,
            requireNumbers: true,
            requireSymbols: true,
            requireUppercase: true
          }
        }
      }
    }
  };

  const baseConfig = configs[env] || configs.test;
  const defaultRegion = env === 'qa' ? 'us-east-1' : 'eu-north-1';
  
  return {
    ...baseConfig,
    region: region || defaultRegion
  };
}

/**
 * Validate environment configuration
 */
export function validateEnvironmentConfig(config: EnvironmentConfig): void {
  if (!config.accountId || config.accountId === 'TBD') {
    throw new Error(`Account ID not configured for environment: ${config.environment}`);
  }
  
  if (!config.region) {
    throw new Error(`Region not specified for environment: ${config.environment}`);
  }
}

/**
 * Validate deployment context (compatibility function)
 */
export function validateDeploymentContext(environment: string, accountId?: string, region?: string): void {
  const config = getGameAuthConfig(environment, region);
  validateEnvironmentConfig(config);
  
  // Additional validation for account ID if provided
  if (accountId && accountId !== config.accountId) {
    throw new Error(`Account ID mismatch: provided ${accountId}, expected ${config.accountId} for environment ${environment}`);
  }
}