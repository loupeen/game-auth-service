import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
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
  public policyStoreTable!: dynamodb.Table;
  public entityStoreTable!: dynamodb.Table;
  public authApi!: apigateway.RestApi;
  public jwtManagement!: EnhancedJwtManagementConstruct;
  public registrationFunction!: NodejsFunction;
  public authorizationFunction!: NodejsFunction;
  public policyLoaderFunction!: NodejsFunction;
  public vpc!: ec2.Vpc;
  public redisSubnetGroup!: elasticache.CfnSubnetGroup;
  public redisCluster!: elasticache.CfnReplicationGroup;
  public readonly config: ReturnType<typeof getGameAuthConfig>;

  constructor(scope: Construct, id: string, props: EnhancedGameAuthServiceStackProps) {
    super(scope, id, props);

    const { environment, region, accountId } = props;
    
    // Validate deployment context using shared configuration
    validateDeploymentContext(environment, accountId, region);
    
    // Get comprehensive configuration
    this.config = getGameAuthConfig(environment, region);

    // Create VPC for Redis if caching is enabled
    if (this.config.features.enableCaching) {
      this.createVpcForCaching();
      this.createRedisCache();
    }

    // Create DynamoDB tables
    this.createSessionsTable();
    this.createCedarPolicyTables();

    // Create Cognito User Pools
    this.createUserPools();

    // Create user registration function
    this.createRegistrationFunction();

    // Create Cedar authorization functions
    this.createCedarFunctions();

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
      // Only set capacity for PROVISIONED billing mode
      ...(this.config.dynamodb.billingMode === 'PROVISIONED' ? {
        readCapacity: this.config.dynamodb.readCapacity,
        writeCapacity: this.config.dynamodb.writeCapacity
      } : {}),
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

  /**
   * Create VPC for Redis caching
   */
  private createVpcForCaching(): void {
    this.vpc = new ec2.Vpc(this, 'AuthCacheVpc', {
      maxAzs: 2,
      natGateways: this.config.environment === 'production' ? 2 : 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 26,
          name: 'CacheSubnet',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true
    });

    cdk.Tags.of(this.vpc).add('Purpose', 'GameAuthCaching');
    cdk.Tags.of(this.vpc).add('Environment', this.config.environment);
  }

  /**
   * Create Redis cache for authorization
   */
  private createRedisCache(): void {
    // Create subnet group for Redis
    this.redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis authorization cache',
      subnetIds: this.vpc.isolatedSubnets.map(subnet => subnet.subnetId),
      cacheSubnetGroupName: `${this.config.naming.prefix}-redis-subnet-group`
    });

    // Create security group for Redis
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Redis authorization cache',
      allowAllOutbound: false
    });

    // Allow Redis port access from private subnets
    redisSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Redis access from VPC'
    );

    // Create Redis replication group for high availability
    this.redisCluster = new elasticache.CfnReplicationGroup(this, 'RedisCluster', {
      description: 'Redis cluster for game authorization caching',
      replicationGroupId: `${this.config.naming.prefix}-auth-cache`,
      
      // Performance and sizing based on environment
      nodeType: this.config.environment === 'production' ? 'cache.t4g.micro' : 'cache.t4g.micro',
      numCacheClusters: this.config.environment === 'production' ? 2 : 1,
      
      // Configuration
      cacheSubnetGroupName: this.redisSubnetGroup.cacheSubnetGroupName,
      securityGroupIds: [redisSecurityGroup.securityGroupId],
      port: 6379,
      engine: 'redis',
      engineVersion: '7.0',
      
      // Security
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      
      // Cost optimization
      automaticFailoverEnabled: this.config.environment === 'production',
      multiAzEnabled: this.config.environment === 'production',
      
      // Backup and maintenance
      snapshotRetentionLimit: this.config.environment === 'production' ? 5 : 1,
      snapshotWindow: '03:00-05:00',
      preferredMaintenanceWindow: 'sun:05:00-sun:07:00'
    });

    this.redisCluster.addDependsOn(this.redisSubnetGroup);

    // Add tags
    cdk.Tags.of(this.redisCluster).add('Purpose', 'GameAuthorizationCache');
    cdk.Tags.of(this.redisCluster).add('Environment', this.config.environment);
  }

  /**
   * Create DynamoDB tables for Cedar policies and entities
   */
  private createCedarPolicyTables(): void {
    // Policy store table
    this.policyStoreTable = new dynamodb.Table(this, 'PolicyStoreTable', {
      tableName: `${this.config.naming.prefix}-policy-store`,
      partitionKey: {
        name: 'policyId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: this.config.dynamodb.billingMode === 'PAY_PER_REQUEST' 
        ? dynamodb.BillingMode.PAY_PER_REQUEST
        : dynamodb.BillingMode.PROVISIONED,
      ...(this.config.dynamodb.billingMode === 'PROVISIONED' ? {
        readCapacity: this.config.dynamodb.readCapacity,
        writeCapacity: this.config.dynamodb.writeCapacity
      } : {}),
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: this.config.security.pointInTimeRecovery,
      removalPolicy: this.config.security.deletionProtection 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // GSI for querying by category and type
    this.policyStoreTable.addGlobalSecondaryIndex({
      indexName: 'CategoryTypeIndex',
      partitionKey: {
        name: 'categoryTypeIndex',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'priority',
        type: dynamodb.AttributeType.NUMBER
      },
      ...(this.config.dynamodb.billingMode === 'PROVISIONED' ? {
        readCapacity: Math.floor(this.config.dynamodb.readCapacity! / 2),
        writeCapacity: Math.floor(this.config.dynamodb.writeCapacity! / 2)
      } : {})
    });

    // GSI for querying active policies
    this.policyStoreTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: {
        name: 'statusIndex',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'priority',
        type: dynamodb.AttributeType.NUMBER
      },
      ...(this.config.dynamodb.billingMode === 'PROVISIONED' ? {
        readCapacity: Math.floor(this.config.dynamodb.readCapacity! / 2),
        writeCapacity: Math.floor(this.config.dynamodb.writeCapacity! / 2)
      } : {})
    });

    // Entity store table
    this.entityStoreTable = new dynamodb.Table(this, 'EntityStoreTable', {
      tableName: `${this.config.naming.prefix}-entity-store`,
      partitionKey: {
        name: 'entityType',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'entityId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: this.config.dynamodb.billingMode === 'PAY_PER_REQUEST' 
        ? dynamodb.BillingMode.PAY_PER_REQUEST
        : dynamodb.BillingMode.PROVISIONED,
      ...(this.config.dynamodb.billingMode === 'PROVISIONED' ? {
        readCapacity: this.config.dynamodb.readCapacity,
        writeCapacity: this.config.dynamodb.writeCapacity
      } : {}),
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: this.config.security.pointInTimeRecovery,
      removalPolicy: this.config.security.deletionProtection 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // GSI for entity lookups by owner
    this.entityStoreTable.addGlobalSecondaryIndex({
      indexName: 'OwnerIndex',
      partitionKey: {
        name: 'ownerId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'entityType',
        type: dynamodb.AttributeType.STRING
      },
      ...(this.config.dynamodb.billingMode === 'PROVISIONED' ? {
        readCapacity: Math.floor(this.config.dynamodb.readCapacity! / 2),
        writeCapacity: Math.floor(this.config.dynamodb.writeCapacity! / 2)
      } : {})
    });
  }

  /**
   * Create Cedar authorization Lambda functions
   */
  private createCedarFunctions(): void {
    const commonEnvironment = {
      REGION: this.config.region,
      ENVIRONMENT: this.config.environment,
      POLICY_STORE_TABLE: this.policyStoreTable.tableName,
      ENTITY_STORE_TABLE: this.entityStoreTable.tableName,
      ENABLE_DETAILED_METRICS: this.config.features.enableDetailedMetrics ? 'true' : 'false',
      ...(this.config.features.enableCaching && this.redisCluster ? {
        REDIS_ENDPOINT: this.redisCluster.attrRedisEndpointAddress
      } : {})
    };

    // Enhanced authorization service function
    this.authorizationFunction = new NodejsFunction(this, 'EnhancedAuthorizationFunction', {
      functionName: `${this.config.naming.prefix}-enhanced-authorization`,
      entry: 'lambda/cedar/enhanced-authorization-service.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: this.config.lambda.memorySize,
      environment: commonEnvironment,
      vpc: this.config.features.enableCaching ? this.vpc : undefined,
      vpcSubnets: this.config.features.enableCaching ? {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      } : undefined,
      bundling: {
        externalModules: ['@cedar-policy/cedar-wasm']
      },
      layers: [
        // Cedar WASM layer would be added here
      ]
    });

    // Policy loader function
    this.policyLoaderFunction = new NodejsFunction(this, 'PolicyLoaderFunction', {
      functionName: `${this.config.naming.prefix}-policy-loader`,
      entry: 'lambda/cedar/basic-game-policy-loader.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: commonEnvironment,
      bundling: {
        externalModules: ['@cedar-policy/cedar-wasm']
      }
    });

    // Grant DynamoDB permissions
    this.policyStoreTable.grantReadWriteData(this.authorizationFunction);
    this.policyStoreTable.grantReadWriteData(this.policyLoaderFunction);
    this.entityStoreTable.grantReadWriteData(this.authorizationFunction);
    this.entityStoreTable.grantReadData(this.policyLoaderFunction);

    // Grant CloudWatch permissions for metrics
    const cloudWatchPolicy = new iam.PolicyStatement({
      actions: [
        'cloudwatch:PutMetricData'
      ],
      resources: ['*'],
      effect: iam.Effect.ALLOW
    });

    this.authorizationFunction.addToRolePolicy(cloudWatchPolicy);
  }
}