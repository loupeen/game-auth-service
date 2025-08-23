import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { EnhancedJwtManagementConstruct } from './constructs/enhanced-jwt-management-construct';
import { getGameAuthConfig, validateDeploymentContext } from './config/environment-config';

export interface EnhancedGameAuthServiceStackProps extends cdk.StackProps {
  environment: string;
  region?: string;
  accountId?: string;
}

/**
 * Enhanced Game Auth Service Stack using shared-config-library
 * 
 * This stack provides comprehensive authentication services with:
 * - Environment-specific configurations from @loupeen/shared-config-library
 * - Consistent naming conventions across all environments
 * - Feature flags for environment-specific behavior
 * - Cost-optimized settings per environment
 * - Multi-region deployment support
 */
export class EnhancedGameAuthServiceStack extends cdk.Stack {
  public playerUserPool!: cognito.UserPool;
  public adminUserPool!: cognito.UserPool;
  public sessionsTable!: dynamodb.Table;
  public authApi!: apigateway.RestApi;
  public jwtManagement!: EnhancedJwtManagementConstruct;
  public registrationFunction!: NodejsFunction;
  public readonly config: ReturnType<typeof getGameAuthConfig>;

  constructor(scope: Construct, id: string, props: EnhancedGameAuthServiceStackProps) {
    super(scope, id, props);

    const { environment, region, accountId } = props;
    
    // Validate deployment context using shared configuration
    validateDeploymentContext(environment, accountId, region);
    
    // Get comprehensive configuration
    this.config = getGameAuthConfig(environment, region);

    // Create DynamoDB table for session storage
    this.createSessionsTable();

    // Create Cognito User Pools
    this.createUserPools();

    // Create user registration function
    this.createRegistrationFunction();

    // Create API Gateway
    this.createApiGateway();

    // Create JWT Management system
    this.createJwtManagement();

    // Create outputs for easy integration
    this.createOutputs();
  }

  private createSessionsTable(): void {
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: this.config.naming.sessionsTable,
      partitionKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: this.config.dynamodb.billingMode === 'PAY_PER_REQUEST' 
        ? dynamodb.BillingMode.PAY_PER_REQUEST
        : dynamodb.BillingMode.PROVISIONED,
      readCapacity: this.config.dynamodb.readCapacity,
      writeCapacity: this.config.dynamodb.writeCapacity,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: this.config.security.pointInTimeRecovery,
      removalPolicy: this.config.security.deletionProtection 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // Add GSI for user lookup
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'UserIdIndex',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });
  }

  private createUserPools(): void {
    // Player User Pool with environment-specific settings
    this.playerUserPool = new cognito.UserPool(this, 'PlayerUserPool', {
      userPoolName: this.config.naming.userPoolPlayer,
      signInAliases: {
        email: true,
        username: true
      },
      selfSignUpEnabled: this.config.cognito.playerPool.selfSignUpEnabled,
      userVerification: {
        emailSubject: `Welcome to Loupeen RTS Platform (${this.config.environment})`,
        emailBody: 'Hello! Your verification code is {####}. Welcome to the ultimate RTS gaming experience!',
        emailStyle: cognito.VerificationEmailStyle.CODE
      },
      passwordPolicy: {
        minLength: this.config.cognito.playerPool.passwordPolicy.minLength,
        requireLowercase: this.config.cognito.playerPool.passwordPolicy.requireLowercase,
        requireUppercase: this.config.cognito.playerPool.passwordPolicy.requireUppercase,
        requireDigits: this.config.cognito.playerPool.passwordPolicy.requireNumbers,
        requireSymbols: this.config.cognito.playerPool.passwordPolicy.requireSymbols,
        tempPasswordValidity: cdk.Duration.days(7)
      },
      mfa: this.config.cognito.playerPool.mfaRequired 
        ? cognito.Mfa.REQUIRED 
        : cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: this.config.features.socialLogin
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        },
        preferredUsername: {
          required: false,
          mutable: true
        }
      },
      customAttributes: {
        playerId: new cognito.StringAttribute({ 
          minLen: 1, 
          maxLen: 50, 
          mutable: false 
        }),
        allianceId: new cognito.StringAttribute({ 
          minLen: 0, 
          maxLen: 50, 
          mutable: true 
        }),
        roleId: new cognito.StringAttribute({ 
          minLen: 1, 
          maxLen: 20, 
          mutable: true 
        }),
        deviceFingerprint: new cognito.StringAttribute({ 
          minLen: 0, 
          maxLen: 128, 
          mutable: true 
        })
      },
      deletionProtection: this.config.security.deletionProtection,
      removalPolicy: this.config.security.deletionProtection 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Admin User Pool with enhanced security
    this.adminUserPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: this.config.naming.userPoolAdmin,
      signInAliases: {
        email: true,
        username: true
      },
      selfSignUpEnabled: this.config.cognito.adminPool.selfSignUpEnabled,
      passwordPolicy: {
        minLength: this.config.cognito.adminPool.passwordPolicy.minLength,
        requireLowercase: this.config.cognito.adminPool.passwordPolicy.requireLowercase,
        requireUppercase: this.config.cognito.adminPool.passwordPolicy.requireUppercase,
        requireDigits: this.config.cognito.adminPool.passwordPolicy.requireNumbers,
        requireSymbols: this.config.cognito.adminPool.passwordPolicy.requireSymbols,
        tempPasswordValidity: cdk.Duration.days(1) // Shorter for admins
      },
      mfa: cognito.Mfa.REQUIRED, // Always required for admins
      mfaSecondFactor: {
        sms: true,
        otp: true
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: false // Immutable for admins
        }
      },
      customAttributes: {
        adminLevel: new cognito.NumberAttribute({ 
          min: 1, 
          max: 10, 
          mutable: false 
        }),
        department: new cognito.StringAttribute({ 
          minLen: 1, 
          maxLen: 50, 
          mutable: false 
        })
      },
      deletionProtection: true, // Always protected for admin pool
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Add domain for hosted UI if in production/QA
    if (this.config.environment !== 'test') {
      this.playerUserPool.addDomain('PlayerUserPoolDomain', {
        cognitoDomain: {
          domainPrefix: `loupeen-players-${this.config.environment}`
        }
      });

      this.adminUserPool.addDomain('AdminUserPoolDomain', {
        cognitoDomain: {
          domainPrefix: `loupeen-admins-${this.config.environment}`
        }
      });
    }
  }

  private createRegistrationFunction(): void {
    this.registrationFunction = new NodejsFunction(this, 'UserRegistrationFunction', {
      entry: 'lambda/auth/user-registration.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: this.config.lambda.memorySize,
      timeout: cdk.Duration.seconds(this.config.lambda.timeout),
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
      },
      environment: {
        ENVIRONMENT: this.config.environment,
        PLAYER_USER_POOL_ID: this.playerUserPool.userPoolId,
        ADMIN_USER_POOL_ID: this.adminUserPool.userPoolId,
        REGION: this.config.region,
        ENABLE_SOCIAL_LOGIN: this.config.features.socialLogin.toString(),
        ENABLE_DETAILED_METRICS: this.config.features.detailedMetrics.toString()
      },
      tracing: this.config.features.xrayTracing 
        ? lambda.Tracing.ACTIVE 
        : lambda.Tracing.DISABLED
    });

    // Grant Cognito permissions
    this.playerUserPool.grant(this.registrationFunction, 
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminSetUserPassword',
      'cognito-idp:AdminUpdateUserAttributes'
    );
  }

  private createApiGateway(): void {
    this.authApi = new apigateway.RestApi(this, 'AuthApi', {
      restApiName: this.config.naming.apiGateway,
      description: `Authentication API for Loupeen RTS Platform - ${this.config.environment}`,
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: this.config.features.xrayTracing,
        metricsEnabled: this.config.features.detailedMetrics,
        throttlingBurstLimit: this.config.apiGateway.throttle.burstLimit,
        throttlingRateLimit: this.config.apiGateway.throttle.rateLimit
      },
      defaultCorsPreflightOptions: {
        allowOrigins: this.config.environment === 'production' 
          ? ['https://loupeen.com', 'https://app.loupeen.com']
          : apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'],
        maxAge: cdk.Duration.days(1)
      }
    });

    // User registration endpoint
    const users = this.authApi.root.addResource('users');
    const register = users.addResource('register');
    register.addMethod('POST', new apigateway.LambdaIntegration(this.registrationFunction));
  }

  private createJwtManagement(): void {
    this.jwtManagement = new EnhancedJwtManagementConstruct(this, 'JwtManagement', {
      environment: this.config.environment,
      region: this.config.region,
      accountId: this.config.accountId,
      playerUserPoolId: this.playerUserPool.userPoolId,
      adminUserPoolId: this.adminUserPool.userPoolId,
      playerUserPoolArn: this.playerUserPool.userPoolArn,
      adminUserPoolArn: this.adminUserPool.userPoolArn,
      sessionsTable: this.sessionsTable,
      api: this.authApi
    });
  }

  private createOutputs(): void {
    new cdk.CfnOutput(this, 'PlayerUserPoolId', {
      value: this.playerUserPool.userPoolId,
      description: 'Player User Pool ID'
    });

    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: this.adminUserPool.userPoolId,
      description: 'Admin User Pool ID'
    });

    new cdk.CfnOutput(this, 'AuthApiUrl', {
      value: this.authApi.url,
      description: 'Authentication API URL'
    });

    new cdk.CfnOutput(this, 'AuthApiEndpoint', {
      value: this.authApi.url,
      exportName: `${this.stackName}-AuthApiEndpoint`
    });

    new cdk.CfnOutput(this, 'ConfigurationSummary', {
      value: JSON.stringify({
        environment: this.config.environment,
        region: this.config.region,
        accountId: this.config.accountId,
        features: this.config.features,
        security: this.config.security
      }, null, 2),
      description: 'Deployment Configuration Summary'
    });
  }
}