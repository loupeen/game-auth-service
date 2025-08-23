import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { getGameAuthConfig, validateDeploymentContext } from '../config/environment-config';

export interface EnhancedJwtManagementConstructProps {
  environment: string;
  region?: string;
  accountId?: string;
  playerUserPoolId: string;
  adminUserPoolId: string;
  playerUserPoolArn: string;
  adminUserPoolArn: string;
  sessionsTable: dynamodb.Table;
  api: apigateway.RestApi;
}

/**
 * Enhanced JWT Management Construct using shared-config-library
 * 
 * This construct provides JWT token management with:
 * - Environment-specific configurations from shared-config-library
 * - Consistent naming conventions across all resources
 * - Feature flags for environment-specific behavior
 * - Optimized performance and cost settings per environment
 */
export class EnhancedJwtManagementConstruct extends Construct {
  public tokenGenerationFunction!: NodejsFunction;
  public tokenValidationFunction!: NodejsFunction;
  public refreshTokenFunction!: NodejsFunction;
  public tokenRevocationFunction!: NodejsFunction;
  public refreshTokensTable!: dynamodb.Table;
  public rateLimitTable!: dynamodb.Table;
  public revokedTokensTable!: dynamodb.Table;
  
  private readonly config: ReturnType<typeof getGameAuthConfig>;

  constructor(scope: Construct, id: string, props: EnhancedJwtManagementConstructProps) {
    super(scope, id);

    const { environment, region, accountId, playerUserPoolId, adminUserPoolId, sessionsTable, api } = props;
    
    // Validate deployment context
    validateDeploymentContext(environment, accountId, region);
    
    // Get comprehensive configuration
    this.config = getGameAuthConfig(environment, region);

    // Create DynamoDB tables with shared naming conventions
    this.createDynamoDBTables();

    // Create Lambda functions with environment-specific settings
    this.createLambdaFunctions(playerUserPoolId, adminUserPoolId, sessionsTable);

    // Grant permissions
    this.grantPermissions(props, sessionsTable);

    // Setup API Gateway endpoints
    this.setupApiEndpoints(api);

    // Create CloudWatch alarms based on environment
    this.createCloudWatchAlarms();
    
    // Output configuration summary
    this.outputConfigurationSummary();
  }

  private createDynamoDBTables(): void {
    // Refresh tokens table
    this.refreshTokensTable = new dynamodb.Table(this, 'RefreshTokensTable', {
      tableName: this.config.naming.refreshTokensTable,
      partitionKey: {
        name: 'tokenId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'userId',
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

    // Add Global Secondary Indexes
    this.refreshTokensTable.addGlobalSecondaryIndex({
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

    this.refreshTokensTable.addGlobalSecondaryIndex({
      indexName: 'TokenFamilyIndex',
      partitionKey: {
        name: 'tokenFamily',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Rate limiting table
    this.rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName: this.config.naming.rateLimitTable,
      partitionKey: {
        name: 'identifier',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'windowStart',
        type: dynamodb.AttributeType.NUMBER
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // Revoked tokens table
    this.revokedTokensTable = new dynamodb.Table(this, 'RevokedTokensTable', {
      tableName: this.config.naming.revokedTokensTable,
      partitionKey: {
        name: 'jti',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: this.config.security.deletionProtection 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });
  }

  private createLambdaFunctions(playerUserPoolId: string, adminUserPoolId: string, sessionsTable: dynamodb.Table): void {
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: this.config.lambda.memorySize,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: this.config.features.xrayTracing 
        ? lambda.Tracing.ACTIVE 
        : lambda.Tracing.DISABLED,
      reservedConcurrency: this.config.lambda.reservedConcurrency
    };

    // Token generation Lambda
    this.tokenGenerationFunction = new NodejsFunction(this, 'TokenGenerationFunction', {
      ...commonLambdaProps,
      entry: 'lambda/jwt/token-generation.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(this.config.lambda.timeout),
      environment: {
        ENVIRONMENT: this.config.environment,
        PLAYER_USER_POOL_ID: playerUserPoolId,
        ADMIN_USER_POOL_ID: adminUserPoolId,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REFRESH_TOKENS_TABLE_NAME: this.refreshTokensTable.tableName,
        RATE_LIMIT_TABLE_NAME: this.rateLimitTable.tableName,
        JWT_ACCESS_TOKEN_EXPIRY: this.config.jwt.accessTokenExpiry.toString(),
        JWT_REFRESH_TOKEN_EXPIRY: this.config.jwt.refreshTokenExpiry.toString(),
        JWT_ISSUER: this.config.jwt.issuer,
        JWT_AUDIENCE: this.config.jwt.audience,
        REGION: this.config.region,
        // Feature flags
        ENABLE_DETAILED_METRICS: this.config.features.detailedMetrics.toString(),
        ENABLE_SOCIAL_LOGIN: this.config.features.socialLogin.toString()
      }
    });

    // Enhanced token validation Lambda
    this.tokenValidationFunction = new NodejsFunction(this, 'EnhancedTokenValidationFunction', {
      ...commonLambdaProps,
      entry: 'lambda/jwt/token-validation-enhanced.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(5), // Fast validation
      environment: {
        ENVIRONMENT: this.config.environment,
        PLAYER_USER_POOL_ID: playerUserPoolId,
        ADMIN_USER_POOL_ID: adminUserPoolId,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REVOKED_TOKENS_TABLE_NAME: this.revokedTokensTable.tableName,
        REGION: this.config.region,
        JWKS_CACHE_TTL: '3600',
        // Performance target
        LATENCY_TARGET_MS: '50'
      }
    });

    // Refresh token Lambda
    this.refreshTokenFunction = new NodejsFunction(this, 'RefreshTokenFunction', {
      ...commonLambdaProps,
      entry: 'lambda/jwt/refresh-token.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(this.config.lambda.timeout),
      environment: {
        ENVIRONMENT: this.config.environment,
        PLAYER_USER_POOL_ID: playerUserPoolId,
        ADMIN_USER_POOL_ID: adminUserPoolId,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REFRESH_TOKENS_TABLE_NAME: this.refreshTokensTable.tableName,
        RATE_LIMIT_TABLE_NAME: this.rateLimitTable.tableName,
        JWT_ACCESS_TOKEN_EXPIRY: this.config.jwt.accessTokenExpiry.toString(),
        JWT_REFRESH_TOKEN_EXPIRY: this.config.jwt.refreshTokenExpiry.toString(),
        REGION: this.config.region
      }
    });

    // Token revocation Lambda
    this.tokenRevocationFunction = new NodejsFunction(this, 'TokenRevocationFunction', {
      ...commonLambdaProps,
      entry: 'lambda/jwt/token-revocation.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 512, // Lower memory for revocation
      environment: {
        ENVIRONMENT: this.config.environment,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REFRESH_TOKENS_TABLE_NAME: this.refreshTokensTable.tableName,
        REVOKED_TOKENS_TABLE_NAME: this.revokedTokensTable.tableName,
        ENABLE_AUDIT_LOGGING: this.config.security.auditLogging.toString()
      }
    });
  }

  private grantPermissions(props: EnhancedJwtManagementConstructProps, sessionsTable: dynamodb.Table): void {
    // Token generation permissions
    sessionsTable.grantReadWriteData(this.tokenGenerationFunction);
    this.refreshTokensTable.grantReadWriteData(this.tokenGenerationFunction);
    this.rateLimitTable.grantReadWriteData(this.tokenGenerationFunction);

    // Token validation permissions
    sessionsTable.grantReadData(this.tokenValidationFunction);
    this.revokedTokensTable.grantReadData(this.tokenValidationFunction);

    // Refresh token permissions
    sessionsTable.grantReadWriteData(this.refreshTokenFunction);
    this.refreshTokensTable.grantReadWriteData(this.refreshTokenFunction);
    this.rateLimitTable.grantReadWriteData(this.refreshTokenFunction);

    // Revocation permissions
    sessionsTable.grantWriteData(this.tokenRevocationFunction);
    this.refreshTokensTable.grantWriteData(this.tokenRevocationFunction);
    this.revokedTokensTable.grantWriteData(this.tokenRevocationFunction);

    // Grant Cognito permissions
    const cognitoPolicy = new iam.PolicyStatement({
      actions: [
        'cognito-idp:GetUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsers'
      ],
      resources: [props.playerUserPoolArn, props.adminUserPoolArn]
    });

    [this.tokenGenerationFunction, this.tokenValidationFunction, this.refreshTokenFunction]
      .forEach(fn => fn.addToRolePolicy(cognitoPolicy));
  }

  private setupApiEndpoints(api: apigateway.RestApi): void {
    const jwt = api.root.addResource('jwt');

    // Enhanced API Gateway configuration based on environment
    const requestValidator = new apigateway.RequestValidator(this, 'JwtRequestValidator', {
      restApi: api,
      requestValidatorName: `jwt-validator-${this.config.environment}`,
      validateRequestBody: true,
      validateRequestParameters: false
    });

    // Token generation endpoint
    const generate = jwt.addResource('generate');
    generate.addMethod('POST', new apigateway.LambdaIntegration(this.tokenGenerationFunction), {
      requestValidator,
      requestModels: {
        'application/json': this.createTokenGenerationModel(api)
      }
    });

    // Token validation endpoint
    const validate = jwt.addResource('validate');
    validate.addMethod('POST', new apigateway.LambdaIntegration(this.tokenValidationFunction));

    // Refresh token endpoint
    const refresh = jwt.addResource('refresh');
    refresh.addMethod('POST', new apigateway.LambdaIntegration(this.refreshTokenFunction));

    // Token revocation endpoint
    const revoke = jwt.addResource('revoke');
    revoke.addMethod('POST', new apigateway.LambdaIntegration(this.tokenRevocationFunction));

    // Enhanced usage plan with environment-specific settings
    const plan = new apigateway.UsagePlan(this, 'JwtUsagePlan', {
      name: `jwt-usage-plan-${this.config.environment}`,
      throttle: {
        rateLimit: this.config.apiGateway.throttle.rateLimit,
        burstLimit: this.config.apiGateway.throttle.burstLimit
      },
      quota: {
        limit: this.config.apiGateway.quota.limit,
        period: apigateway.Period.DAY
      }
    });

    plan.addApiStage({
      api: api,
      stage: api.deploymentStage
    });
  }

  private createTokenGenerationModel(api: apigateway.RestApi): apigateway.Model {
    return new apigateway.Model(this, 'TokenGenerationModel', {
      restApi: api,
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          username: { type: apigateway.JsonSchemaType.STRING },
          password: { type: apigateway.JsonSchemaType.STRING },
          deviceId: { type: apigateway.JsonSchemaType.STRING },
          userType: { 
            type: apigateway.JsonSchemaType.STRING,
            enum: ['player', 'admin']
          }
        },
        required: ['username', 'password', 'deviceId', 'userType']
      }
    });
  }

  private createCloudWatchAlarms(): void {
    // Environment-specific alarm thresholds
    const errorThreshold = this.config.environment === 'production' ? 5 : 10;
    const latencyThreshold = this.config.environment === 'production' ? 50 : 100;

    // Token validation latency alarm
    new cloudwatch.Alarm(this, 'TokenValidationLatencyAlarm', {
      metric: this.tokenValidationFunction.metricDuration({
        statistic: 'Average'
      }),
      threshold: latencyThreshold,
      evaluationPeriods: 2,
      alarmDescription: `Token validation exceeding ${latencyThreshold}ms in ${this.config.environment}`,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Enhanced error monitoring for production
    if (this.config.environment === 'production') {
      new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
        metric: new cloudwatch.MathExpression({
          expression: 'e1 + e2 + e3 + e4',
          usingMetrics: {
            e1: this.tokenGenerationFunction.metricErrors(),
            e2: this.refreshTokenFunction.metricErrors(),
            e3: this.tokenValidationFunction.metricErrors(),
            e4: this.tokenRevocationFunction.metricErrors()
          }
        }),
        threshold: errorThreshold,
        evaluationPeriods: 1,
        alarmDescription: 'High error rate across JWT management system'
      });
    }
  }

  private outputConfigurationSummary(): void {
    new cdk.CfnOutput(this, 'EnvironmentConfiguration', {
      value: JSON.stringify({
        environment: this.config.environment,
        region: this.config.region,
        accountId: this.config.accountId,
        features: this.config.features,
        naming: this.config.naming
      }, null, 2),
      description: 'JWT Management Configuration Summary'
    });
  }
}