#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EnhancedGameAuthServiceStack } from '../lib/enhanced-game-auth-service-stack';
import { LoupeenConfigFactory } from '@loupeen/shared-config-library';

const app = new cdk.App();

/**
 * Enhanced Game Auth Service Deployment
 * 
 * Uses @loupeen/shared-config-library for consistent multi-environment deployment
 * with automatic account/region validation and environment-specific configurations.
 */

// Get environment from CDK context or environment variable
const environment = app.node.tryGetContext('environment') || process.env.CDK_ENVIRONMENT || 'test';
const region = app.node.tryGetContext('region') || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION;
const account = process.env.CDK_DEFAULT_ACCOUNT;

console.log(`🚀 Deploying Game Auth Service to environment: ${environment}`);

try {
  // Get configuration from shared library
  const envConfig = LoupeenConfigFactory.Environment.getConfig(environment as any);
  const accountInfo = LoupeenConfigFactory.Account.getAccountInfo(environment as any);
  const deploymentStrategy = LoupeenConfigFactory.Region.getDeploymentStrategy(environment as any);
  
  console.log(`📋 Configuration Summary:`);
  console.log(`   Environment: ${envConfig.name}`);
  console.log(`   Account: ${envConfig.awsAccountId}`);
  console.log(`   Primary Region: ${envConfig.primaryRegion}`);
  console.log(`   Secondary Regions: ${envConfig.secondaryRegions.join(', ') || 'None'}`);
  console.log(`   Domain: ${envConfig.domainName}`);
  console.log(`   Cost Budget: $${envConfig.costBudget.monthly}/month`);

  // Validate account if provided
  if (account && account !== envConfig.awsAccountId) {
    throw new Error(
      `❌ Account mismatch! Current account: ${account}, Expected for ${environment}: ${envConfig.awsAccountId}`
    );
  }

  // Determine deployment region
  const deploymentRegion = region || envConfig.primaryRegion;
  
  // Validate region
  const validRegions = [deploymentStrategy.primaryRegion, ...deploymentStrategy.secondaryRegions];
  if (!validRegions.includes(deploymentRegion as any)) {
    throw new Error(
      `❌ Invalid region ${deploymentRegion} for environment ${environment}. ` +
      `Valid regions: ${validRegions.join(', ')}`
    );
  }

  console.log(`🌍 Deploying to region: ${deploymentRegion}`);

  // Create the enhanced stack
  const stackName = `GameAuthService-${environment}${region && region !== envConfig.primaryRegion ? `-${region}` : ''}`;
  
  new EnhancedGameAuthServiceStack(app, stackName, {
    environment,
    region: deploymentRegion,
    accountId: envConfig.awsAccountId,
    env: {
      account: envConfig.awsAccountId,
      region: deploymentRegion
    },
    description: `Game Authentication Service for Loupeen RTS Platform (${environment})`,
    tags: {
      Environment: environment,
      Service: 'game-auth-service',
      Platform: 'loupeen-rts',
      CostCenter: envConfig.name,
      Repository: 'https://github.com/loupeen/game-auth-service',
      ManagedBy: 'CDK'
    }
  });

  console.log(`✅ Stack configured: ${stackName}`);
  
  // Multi-region deployment for QA and Production
  if (envConfig.secondaryRegions.length > 0 && process.env.ENABLE_MULTI_REGION === 'true') {
    console.log(`🌐 Multi-region deployment enabled for ${environment}`);
    
    for (const secondaryRegion of envConfig.secondaryRegions) {
      const multiRegionStackName = `GameAuthService-${environment}-${secondaryRegion}`;
      
      new EnhancedGameAuthServiceStack(app, multiRegionStackName, {
        environment,
        region: secondaryRegion,
        accountId: envConfig.awsAccountId,
        env: {
          account: envConfig.awsAccountId,
          region: secondaryRegion
        },
        description: `Game Authentication Service (${environment} - ${secondaryRegion})`,
        tags: {
          Environment: environment,
          Service: 'game-auth-service',
          Platform: 'loupeen-rts',
          CostCenter: envConfig.name,
          Repository: 'https://github.com/loupeen/game-auth-service',
          ManagedBy: 'CDK',
          Region: 'secondary'
        }
      });
      
      console.log(`✅ Secondary stack configured: ${multiRegionStackName}`);
    }
  }

} catch (error: any) {
  console.error('❌ Configuration Error:', error.message);
  console.log('\n🔧 Available environments: test, qa, production');
  console.log('💡 Usage examples:');
  console.log('   cdk deploy --context environment=test');
  console.log('   cdk deploy --context environment=qa --context region=us-east-1');
  console.log('   CDK_ENVIRONMENT=qa cdk deploy');
  process.exit(1);
}

// Add synth metadata
app.synth();