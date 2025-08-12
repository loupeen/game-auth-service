import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export interface GameAuthServiceStackProps extends cdk.StackProps {
  environment: string;
}

export class GameAuthServiceStack extends cdk.Stack {
  public readonly playerUserPool: cognito.UserPool;
  public readonly adminUserPool: cognito.UserPool;
  public readonly sessionsTable: dynamodb.Table;
  public readonly authApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: GameAuthServiceStackProps) {
    super(scope, id, props);

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

    // Output important values
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
  }

  private createAuthLambdas(environment: string): void {
    // Token validation Lambda
    const tokenValidationLambda = new NodejsFunction(this, 'TokenValidationFunction', {
      entry: 'lambda/auth/token-validation.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      environment: {
        ENVIRONMENT: environment,
        SESSIONS_TABLE_NAME: this.sessionsTable.tableName,
        PLAYER_USER_POOL_ID: this.playerUserPool.userPoolId,
        ADMIN_USER_POOL_ID: this.adminUserPool.userPoolId
      }
    });

    // Grant DynamoDB permissions
    this.sessionsTable.grantReadWriteData(tokenValidationLambda);

    // User registration Lambda
    const userRegistrationLambda = new NodejsFunction(this, 'UserRegistrationFunction', {
      entry: 'lambda/auth/user-registration.ts', 
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      environment: {
        ENVIRONMENT: environment,
        PLAYER_USER_POOL_ID: this.playerUserPool.userPoolId,
        SESSIONS_TABLE_NAME: this.sessionsTable.tableName
      }
    });

    this.sessionsTable.grantReadWriteData(userRegistrationLambda);

    // Grant Cognito permissions
    this.playerUserPool.grant(userRegistrationLambda, 'cognito-idp:AdminCreateUser');

    // API Gateway integrations
    const auth = this.authApi.root.addResource('auth');
    
    const validateToken = auth.addResource('validate-token');
    validateToken.addMethod('POST', new apigateway.LambdaIntegration(tokenValidationLambda));

    const register = auth.addResource('register');
    register.addMethod('POST', new apigateway.LambdaIntegration(userRegistrationLambda));
  }
}