#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EnhancedGameAuthServiceStack } from '../lib/enhanced-game-auth-service-stack';

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
  // Simple environment configuration (will be replaced with shared-config-library later)
  const envConfigs: Record<string, any> = {
    test: {
      name: 'test',
      awsAccountId: '728427470046',
      primaryRegion: 'eu-north-1',
      secondaryRegions: [],
      domainName: 'loupeen-test.com',
      costBudget: { monthly: 200 }
    },
    qa: {
      name: 'qa',
      awsAccountId: '077029784291',
      primaryRegion: 'us-east-1',
      secondaryRegions: ['eu-central-1'],
      domainName: 'loupeen-qa.com',
      costBudget: { monthly: 150 }
    },
    production: {
      name: 'production',
      awsAccountId: 'TBD',
      primaryRegion: 'us-east-1',
      secondaryRegions: ['eu-central-1', 'eu-north-1'],
      domainName: 'loupeen.com',
      costBudget: { monthly: 1000 }
    }
  };

  const envConfig = envConfigs[environment] || envConfigs.test;
  
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