import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { JwtManagementConstruct } from './constructs/jwt-management-construct';
import { CedarAuthorizationConstruct } from './constructs/cedar-authorization-construct';
import { UserEntityManagementConstruct } from './constructs/user-entity-management-construct';

export interface GameAuthServiceStackProps extends cdk.StackProps {
  environment: string;
}

export class GameAuthServiceStack extends cdk.Stack {
  public readonly playerUserPool: cognito.UserPool;
  public readonly adminUserPool: cognito.UserPool;
  public readonly playerUserPoolClient: cognito.UserPoolClient;
  public readonly adminUserPoolClient: cognito.UserPoolClient;
  public readonly sessionsTable: dynamodb.Table;
  public readonly authApi: apigateway.RestApi;
  public readonly jwtManagement: JwtManagementConstruct;
  public readonly cedarAuthorization: CedarAuthorizationConstruct;
  public readonly userEntityManagement: UserEntityManagementConstruct;
  
  private tokenValidationLambda!: NodejsFunction;
  private userRegistrationLambda!: NodejsFunction;
  private postAuthenticationTrigger!: NodejsFunction;
  private preTokenGenerationTrigger!: NodejsFunction;
  private props: GameAuthServiceStackProps;

  constructor(scope: Construct, id: string, props: GameAuthServiceStackProps) {
    super(scope, id, props);
    
    this.props = props;
    const { environment } = props;

    // DynamoDB table for session storage
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `game-auth-sessions-${environment}`,
      partitionKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: environment === 'production',
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // Player User Pool
    this.playerUserPool = new cognito.UserPool(this, 'PlayerUserPool', {
      userPoolName: `loupeen-players-${environment}`,
      signInAliases: {
        email: true,
        username: true
      },
      selfSignUpEnabled: true,
      userVerification: {
        emailSubject: 'Welcome to Loupeen RTS!',
        emailBody: 'Your verification code is {####}',
        emailStyle: cognito.VerificationEmailStyle.CODE
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      customAttributes: {
        playerId: new cognito.StringAttribute({ minLen: 1, maxLen: 50 }),
        allianceId: new cognito.StringAttribute({ minLen: 1, maxLen: 50 }),
        roleId: new cognito.StringAttribute({ minLen: 1, maxLen: 20 }),
        deviceFingerprint: new cognito.StringAttribute({ minLen: 1, maxLen: 100 })
      },
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Admin User Pool
    this.adminUserPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: `loupeen-admins-${environment}`,
      signInAliases: {
        email: true
      },
      selfSignUpEnabled: false,
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: {
        sms: true,
        otp: true
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true
      },
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Player User Pool Client
    this.playerUserPoolClient = new cognito.UserPoolClient(this, 'PlayerUserPoolClient', {
      userPool: this.playerUserPool,
      userPoolClientName: `loupeen-players-client-${environment}`,
      generateSecret: false, // Public client for frontend/mobile apps
      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,
        adminUserPassword: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE
        ]
      },
      accessTokenValidity: cdk.Duration.minutes(15),
      idTokenValidity: cdk.Duration.minutes(15),
      refreshTokenValidity: cdk.Duration.days(30)
    });

    // Admin User Pool Client
    this.adminUserPoolClient = new cognito.UserPoolClient(this, 'AdminUserPoolClient', {
      userPool: this.adminUserPool,
      userPoolClientName: `loupeen-admins-client-${environment}`,
      generateSecret: false, // Public client for admin dashboard
      authFlows: {
        userPassword: true,
        userSrp: true,
        adminUserPassword: true
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE
        ]
      },
      accessTokenValidity: cdk.Duration.minutes(30), // Longer for admin sessions
      idTokenValidity: cdk.Duration.minutes(30),
      refreshTokenValidity: cdk.Duration.days(7) // Shorter for security
    });

    // Auth API Gateway
    this.authApi = new apigateway.RestApi(this, 'AuthApi', {
      restApiName: `loupeen-auth-api-${environment}`,
      description: `Authentication API for Loupeen RTS Platform (${environment})`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization']
      }
    });

    // Basic Lambda functions
    this.createAuthLambdas(environment);

    // JWT Management Construct
    this.jwtManagement = new JwtManagementConstruct(this, 'JwtManagement', {
      environment,
      playerUserPoolId: this.playerUserPool.userPoolId,
      adminUserPoolId: this.adminUserPool.userPoolId,
      playerUserPoolArn: this.playerUserPool.userPoolArn,
      adminUserPoolArn: this.adminUserPool.userPoolArn,
      sessionsTable: this.sessionsTable,
      api: this.authApi
    });

    // Cedar Authorization Construct
    this.cedarAuthorization = new CedarAuthorizationConstruct(this, 'CedarAuthorization', {
      environment,
      region: this.region,
      accountId: this.account,
      playerUserPoolId: this.playerUserPool.userPoolId,
      adminUserPoolId: this.adminUserPool.userPoolId,
      playerUserPoolClientId: this.playerUserPoolClient.userPoolClientId,
      adminUserPoolClientId: this.adminUserPoolClient.userPoolClientId,
      sessionsTable: this.sessionsTable
    });

    // User Entity Management Construct
    this.userEntityManagement = new UserEntityManagementConstruct(this, 'UserEntityManagement', {
      environment,
      entityStore: this.cedarAuthorization.entityStore,
      playerUserPoolId: this.playerUserPool.userPoolId,
      adminUserPoolId: this.adminUserPool.userPoolId,
      api: this.authApi
    });

    // Create Cognito triggers after Cedar Authorization is created
    this.createCognitoTriggers(environment);

    // Create API endpoints after all constructs are initialized
    this.createApiEndpoints();

    // Create stack outputs
    this.createOutputs();
  }

  private createAuthLambdas(environment: string): void {
    // Token validation Lambda
    this.tokenValidationLambda = new NodejsFunction(this, 'TokenValidationFunction', {
      entry: 'lambda/auth/token-validation.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
      },
      environment: {
        ENVIRONMENT: environment,
        SESSIONS_TABLE_NAME: this.sessionsTable.tableName,
        PLAYER_USER_POOL_ID: this.playerUserPool.userPoolId,
        ADMIN_USER_POOL_ID: this.adminUserPool.userPoolId
      }
    });

    // Grant DynamoDB permissions
    this.sessionsTable.grantReadWriteData(this.tokenValidationLambda);

    // User registration Lambda
    this.userRegistrationLambda = new NodejsFunction(this, 'UserRegistrationFunction', {
      entry: 'lambda/auth/user-registration.ts', 
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
      },
      environment: {
        ENVIRONMENT: environment,
        PLAYER_USER_POOL_ID: this.playerUserPool.userPoolId,
        SESSIONS_TABLE_NAME: this.sessionsTable.tableName
      }
    });

    this.sessionsTable.grantReadWriteData(this.userRegistrationLambda);

    // Grant Cognito permissions
    this.playerUserPool.grant(this.userRegistrationLambda, 'cognito-idp:AdminCreateUser');
  }

  private createApiEndpoints(): void {
    // API Gateway integrations
    const auth = this.authApi.root.addResource('auth');
    
    const validateToken = auth.addResource('validate-token');
    validateToken.addMethod('POST', new apigateway.LambdaIntegration(this.tokenValidationLambda));

    const register = auth.addResource('register');
    register.addMethod('POST', new apigateway.LambdaIntegration(this.userRegistrationLambda));

    // Cedar Authorization endpoints
    const authz = this.authApi.root.addResource('authz');
    authz.addMethod('POST', new apigateway.LambdaIntegration(this.cedarAuthorization.authorizationFunction));

    const policies = this.authApi.root.addResource('policies');
    policies.addMethod('POST', new apigateway.LambdaIntegration(this.cedarAuthorization.policyManagementFunction));
    policies.addMethod('GET', new apigateway.LambdaIntegration(this.cedarAuthorization.policyManagementFunction));

    // Enhanced JWT-Cedar validation endpoint
    const enhancedAuth = this.authApi.root.addResource('enhanced-auth');
    enhancedAuth.addMethod('POST', new apigateway.LambdaIntegration(this.cedarAuthorization.enhancedJWTCedarFunction));

    // Entity management endpoints
    const entities = this.authApi.root.addResource('entities');
    entities.addMethod('POST', new apigateway.LambdaIntegration(this.cedarAuthorization.entityManagementFunction));
    entities.addMethod('GET', new apigateway.LambdaIntegration(this.cedarAuthorization.entityManagementFunction));
  }

  private createCognitoTriggers(environment: string): void {
    // Post-Authentication Trigger
    this.postAuthenticationTrigger = new NodejsFunction(this, 'PostAuthenticationTrigger', {
      entry: 'lambda/cognito/post-authentication-trigger.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
      },
      environment: {
        ENVIRONMENT: environment,
        ENTITY_STORE_TABLE: this.cedarAuthorization.entityStore.tableName,
        REGION: this.region
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    // Pre-Token Generation Trigger
    this.preTokenGenerationTrigger = new NodejsFunction(this, 'PreTokenGenerationTrigger', {
      entry: 'lambda/cognito/pre-token-generation-trigger.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
      },
      environment: {
        ENVIRONMENT: environment,
        ENTITY_STORE_TABLE: this.cedarAuthorization.entityStore.tableName,
        REGION: this.region
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    // Grant permissions to access Cedar entity store
    this.cedarAuthorization.entityStore.grantReadWriteData(this.postAuthenticationTrigger);
    this.cedarAuthorization.entityStore.grantReadData(this.preTokenGenerationTrigger);

    // Add triggers to Player User Pool
    this.playerUserPool.addTrigger(
      cognito.UserPoolOperation.POST_AUTHENTICATION,
      this.postAuthenticationTrigger
    );
    
    this.playerUserPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
      this.preTokenGenerationTrigger
    );

    // Add triggers to Admin User Pool
    this.adminUserPool.addTrigger(
      cognito.UserPoolOperation.POST_AUTHENTICATION,
      this.postAuthenticationTrigger
    );
    
    this.adminUserPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION,
      this.preTokenGenerationTrigger
    );
  }

  /**
   * Export stack outputs for monitoring and integration
   */
  private createOutputs(): void {
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.authApi.url,
      description: 'Game Auth Service API URL',
      exportName: `GameAuthService-${this.props.environment}-ApiUrl`
    });

    new cdk.CfnOutput(this, 'PlayerUserPoolId', {
      value: this.playerUserPool.userPoolId,
      description: 'Player User Pool ID',
      exportName: `GameAuthService-${this.props.environment}-PlayerUserPoolId`
    });

    new cdk.CfnOutput(this, 'PlayerUserPoolClientId', {
      value: this.playerUserPoolClient.userPoolClientId,
      description: 'Player User Pool Client ID', 
      exportName: `GameAuthService-${this.props.environment}-PlayerUserPoolClientId`
    });

    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: this.adminUserPool.userPoolId,
      description: 'Admin User Pool ID',
      exportName: `GameAuthService-${this.props.environment}-AdminUserPoolId`
    });
  }
}