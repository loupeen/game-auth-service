/**
 * Environment Configuration for Game Auth Service
 * 
 * This module integrates with @loupeen/shared-config-library to provide
 * environment-specific configurations for the JWT Management System.
 */

import { Config, LoupeenConfigFactory } from '@loupeen/shared-config-library';
import type { Environment } from '@loupeen/shared-config-library';

/**
 * Get comprehensive configuration for the Game Auth Service
 */
export function getGameAuthConfig(environment: string, region?: string) {
  // Parse environment to ensure type safety
  const env = environment.toLowerCase() as Environment;
  
  // Get base configuration from shared library
  const envConfig = Config.env(env);
  const resourceName = (service: string, feature?: string) => 
    Config.name(service, env, region, feature);
  
  return {
    // Environment settings
    environment: env,
    region: region || envConfig.primaryRegion,
    accountId: envConfig.awsAccountId,
    
    // Service naming using shared conventions
    naming: {
      userPoolPlayer: resourceName('cognito', 'players'),
      userPoolAdmin: resourceName('cognito', 'admins'),
      sessionsTable: resourceName('dynamodb', 'sessions'),
      refreshTokensTable: resourceName('dynamodb', 'refresh-tokens'),
      rateLimitTable: resourceName('dynamodb', 'rate-limits'),
      revokedTokensTable: resourceName('dynamodb', 'revoked-tokens'),
      apiGateway: resourceName('apigateway', 'auth')
    },
    
    // Feature flags for environment-specific behavior
    features: {
      socialLogin: env === 'production' ? true : false,
      mfaRequired: env === 'production' ? true : false,
      detailedMetrics: envConfig.monitoring.detailedMetrics,
      xrayTracing: envConfig.monitoring.xrayTracing
    },
    
    // Security settings from environment config
    security: {
      deletionProtection: envConfig.security.deletionProtection,
      encryptionAtRest: envConfig.security.encryptionAtRest,
      auditLogging: envConfig.security.auditLogging,
      pointInTimeRecovery: env === 'production' || env === 'qa'
    },
    
    // Performance and scaling settings
    lambda: {
      architecture: 'ARM_64' as const, // Cost optimization
      memorySize: env === 'production' ? 1024 : 512,
      timeout: env === 'production' ? 10 : 5,
      reservedConcurrency: env === 'production' ? 50 : undefined
    },
    
    // DynamoDB settings
    dynamodb: {
      billingMode: env === 'production' ? 'PAY_PER_REQUEST' : 'PROVISIONED',
      readCapacity: env === 'production' ? undefined : 5,
      writeCapacity: env === 'production' ? undefined : 5
    },
    
    // JWT settings
    jwt: {
      accessTokenExpiry: 900, // 15 minutes
      refreshTokenExpiry: 2592000, // 30 days
      issuer: `loupeen-auth-${env}`,
      audience: 'loupeen-game'
    },
    
    // API Gateway settings
    apiGateway: {
      throttle: {
        rateLimit: env === 'production' ? 100 : 10,
        burstLimit: env === 'production' ? 200 : 20
      },
      quota: {
        limit: env === 'production' ? 100000 : 10000,
        period: 'DAY' as const
      }
    },
    
    // Cognito settings
    cognito: {
      playerPool: {
        selfSignUpEnabled: true,
        mfaRequired: env === 'production',
        passwordPolicy: {
          minLength: env === 'production' ? 12 : 8,
          requireNumbers: true,
          requireSymbols: env === 'production',
          requireUppercase: true,
          requireLowercase: true
        }
      },
      adminPool: {
        selfSignUpEnabled: false,
        mfaRequired: true,
        passwordPolicy: {
          minLength: 14,
          requireNumbers: true,
          requireSymbols: true,
          requireUppercase: true,
          requireLowercase: true
        }
      }
    }
  };
}

/**
 * Validate deployment context against shared configuration
 */
export function validateDeploymentContext(environment: string, accountId?: string, region?: string) {
  const env = environment.toLowerCase() as Environment;
  
  // Use shared library validation
  if (accountId) {
    const isValid = LoupeenConfigFactory.Account.getAccountInfo(env).accountId === accountId;
    if (!isValid) {
      throw new Error(
        `Account ID ${accountId} does not match expected account for environment ${env}. ` +
        `Expected: ${LoupeenConfigFactory.Account.getAccountInfo(env).accountId}`
      );
    }
  }
  
  // Validate region
  if (region) {
    const validRegions = LoupeenConfigFactory.Region.getDeploymentStrategy(env);
    const isValidRegion = [validRegions.primaryRegion, ...validRegions.secondaryRegions].includes(region as any);
    if (!isValidRegion) {
      throw new Error(
        `Region ${region} is not valid for environment ${env}. ` +
        `Valid regions: ${[validRegions.primaryRegion, ...validRegions.secondaryRegions].join(', ')}`
      );
    }
  }
  
  return true;
}

/**
 * Get multi-environment deployment configuration
 */
export function getMultiEnvironmentConfig() {
  return {
    test: getGameAuthConfig('test'),
    qa: getGameAuthConfig('qa'),
    production: getGameAuthConfig('production')
  };
}