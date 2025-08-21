import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface JwtManagementConstructProps {
  environment: string;
  playerUserPoolId: string;
  adminUserPoolId: string;
  playerUserPoolArn: string;
  adminUserPoolArn: string;
  sessionsTable: dynamodb.Table;
  api: apigateway.RestApi;
}

export class JwtManagementConstruct extends Construct {
  public readonly tokenGenerationFunction: NodejsFunction;
  public readonly tokenValidationFunction: NodejsFunction;
  public readonly refreshTokenFunction: NodejsFunction;
  public readonly tokenRevocationFunction: NodejsFunction;
  public readonly refreshTokensTable: dynamodb.Table;
  public readonly rateLimitTable: dynamodb.Table;
  public readonly revokedTokensTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: JwtManagementConstructProps) {
    super(scope, id);

    const { environment, playerUserPoolId, adminUserPoolId, sessionsTable, api } = props;

    // Refresh tokens table with encryption and TTL
    this.refreshTokensTable = new dynamodb.Table(this, 'RefreshTokensTable', {
      tableName: `game-auth-refresh-tokens-${environment}`,
      partitionKey: {
        name: 'tokenId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: environment === 'production' 
        ? dynamodb.BillingMode.PAY_PER_REQUEST
        : dynamodb.BillingMode.PROVISIONED,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: environment === 'production',
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // Add GSI for querying by userId
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

    // Add GSI for token family tracking (security feature)
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
      tableName: `game-auth-rate-limits-${environment}`,
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

    // Revoked tokens table (for emergency revocation)
    this.revokedTokensTable = new dynamodb.Table(this, 'RevokedTokensTable', {
      tableName: `game-auth-revoked-tokens-${environment}`,
      partitionKey: {
        name: 'jti',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // Token generation Lambda
    this.tokenGenerationFunction = new NodejsFunction(this, 'TokenGenerationFunction', {
      entry: 'lambda/jwt/token-generation.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64, // Cost optimization
      timeout: cdk.Duration.seconds(10),
      memorySize: environment === 'production' ? 1024 : 512,
      environment: {
        ENVIRONMENT: environment,
        PLAYER_USER_POOL_ID: playerUserPoolId,
        ADMIN_USER_POOL_ID: adminUserPoolId,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REFRESH_TOKENS_TABLE_NAME: this.refreshTokensTable.tableName,
        RATE_LIMIT_TABLE_NAME: this.rateLimitTable.tableName,
        JWT_ACCESS_TOKEN_EXPIRY: '900', // 15 minutes
        JWT_REFRESH_TOKEN_EXPIRY: '2592000', // 30 days
        REGION: props.playerUserPoolArn.split(':')[3]
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE
    });

    // Enhanced token validation Lambda
    this.tokenValidationFunction = new NodejsFunction(this, 'EnhancedTokenValidationFunction', {
      entry: 'lambda/jwt/token-validation-enhanced.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(5), // Fast validation
      memorySize: environment === 'production' ? 1024 : 512,
      environment: {
        ENVIRONMENT: environment,
        PLAYER_USER_POOL_ID: playerUserPoolId,
        ADMIN_USER_POOL_ID: adminUserPoolId,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REVOKED_TOKENS_TABLE_NAME: this.revokedTokensTable.tableName,
        REGION: props.playerUserPoolArn.split(':')[3],
        JWKS_CACHE_TTL: '3600' // 1 hour cache for JWKS
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE
    });

    // Refresh token Lambda
    this.refreshTokenFunction = new NodejsFunction(this, 'RefreshTokenFunction', {
      entry: 'lambda/jwt/refresh-token.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: environment === 'production' ? 1024 : 512,
      environment: {
        ENVIRONMENT: environment,
        PLAYER_USER_POOL_ID: playerUserPoolId,
        ADMIN_USER_POOL_ID: adminUserPoolId,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REFRESH_TOKENS_TABLE_NAME: this.refreshTokensTable.tableName,
        RATE_LIMIT_TABLE_NAME: this.rateLimitTable.tableName,
        JWT_ACCESS_TOKEN_EXPIRY: '900',
        JWT_REFRESH_TOKEN_EXPIRY: '2592000',
        REGION: props.playerUserPoolArn.split(':')[3]
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE
    });

    // Token revocation Lambda
    this.tokenRevocationFunction = new NodejsFunction(this, 'TokenRevocationFunction', {
      entry: 'lambda/jwt/token-revocation.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(5),
      memorySize: 512,
      environment: {
        ENVIRONMENT: environment,
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        REFRESH_TOKENS_TABLE_NAME: this.refreshTokensTable.tableName,
        REVOKED_TOKENS_TABLE_NAME: this.revokedTokensTable.tableName
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE
    });

    // Grant permissions
    this.grantPermissions(props, sessionsTable);

    // Setup API Gateway endpoints
    this.setupApiEndpoints(api);

    // Create CloudWatch alarms
    this.createCloudWatchAlarms(environment);
  }

  private grantPermissions(props: JwtManagementConstructProps, sessionsTable: dynamodb.Table): void {
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

    // Grant Cognito permissions for all functions
    const cognitoPolicy = new iam.PolicyStatement({
      actions: [
        'cognito-idp:GetUser',
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsers'
      ],
      resources: [props.playerUserPoolArn, props.adminUserPoolArn]
    });

    this.tokenGenerationFunction.addToRolePolicy(cognitoPolicy);
    this.tokenValidationFunction.addToRolePolicy(cognitoPolicy);
    this.refreshTokenFunction.addToRolePolicy(cognitoPolicy);
  }

  private setupApiEndpoints(api: apigateway.RestApi): void {
    const jwt = api.root.addResource('jwt');

    // Token generation endpoint
    const generate = jwt.addResource('generate');
    generate.addMethod('POST', new apigateway.LambdaIntegration(this.tokenGenerationFunction), {
      requestValidator: new apigateway.RequestValidator(this, 'GenerateTokenValidator', {
        restApi: api,
        requestValidatorName: 'generate-token-validator',
        validateRequestBody: true,
        validateRequestParameters: false
      }),
      requestModels: {
        'application/json': new apigateway.Model(this, 'GenerateTokenModel', {
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
        })
      },
      apiKeyRequired: false,
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL
          }
        },
        {
          statusCode: '400',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL
          }
        },
        {
          statusCode: '401',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL
          }
        },
        {
          statusCode: '429',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL
          }
        }
      ]
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

    // Apply rate limiting at API Gateway level
    const plan = new apigateway.UsagePlan(this, 'JwtUsagePlan', {
      name: `jwt-usage-plan-${api.deploymentStage.stageName}`,
      throttle: {
        rateLimit: 10, // requests per second
        burstLimit: 20
      },
      quota: {
        limit: 10000,
        period: apigateway.Period.DAY
      }
    });

    plan.addApiStage({
      api: api,
      stage: api.deploymentStage
    });
  }

  private createCloudWatchAlarms(environment: string): void {
    // Token validation latency alarm
    new cloudwatch.Alarm(this, 'TokenValidationLatencyAlarm', {
      metric: this.tokenValidationFunction.metricDuration({
        statistic: 'Average'
      }),
      threshold: 50, // 50ms target
      evaluationPeriods: 2,
      alarmDescription: 'Token validation taking longer than 50ms',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Token generation error rate alarm
    new cloudwatch.Alarm(this, 'TokenGenerationErrorAlarm', {
      metric: this.tokenGenerationFunction.metricErrors({
        statistic: 'Sum'
      }),
      threshold: environment === 'production' ? 5 : 10,
      evaluationPeriods: 1,
      alarmDescription: 'High error rate in token generation',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Refresh token rotation failures
    new cloudwatch.Alarm(this, 'RefreshTokenFailureAlarm', {
      metric: this.refreshTokenFunction.metricErrors({
        statistic: 'Sum'
      }),
      threshold: environment === 'production' ? 3 : 5,
      evaluationPeriods: 1,
      alarmDescription: 'Refresh token rotation failures detected',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Rate limiting breaches
    new cloudwatch.Alarm(this, 'RateLimitBreachAlarm', {
      metric: this.tokenGenerationFunction.metricThrottles({
        statistic: 'Sum'
      }),
      threshold: 100,
      evaluationPeriods: 1,
      alarmDescription: 'High number of rate limit breaches',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });
  }
}