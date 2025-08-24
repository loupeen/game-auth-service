import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface MfaManagementConstructProps {
  environment: string;
  playerUserPool: cognito.UserPool;
  adminUserPool: cognito.UserPool;
  sessionsTable: dynamodb.Table;
  api: apigateway.RestApi;
}

/**
 * MFA Management Construct
 * Implements adaptive MFA with gaming-specific optimizations
 * 
 * Features:
 * - TOTP authentication (Google Authenticator, Authy)
 * - SMS-based MFA fallback
 * - Risk-based MFA triggers
 * - Device fingerprinting and trust management
 * - Recovery codes generation
 * - Gaming incentives for MFA enrollment
 */
export class MfaManagementConstruct extends Construct {
  public readonly mfaDevicesTable: dynamodb.Table;
  public readonly trustedDevicesTable: dynamodb.Table;
  public readonly recoveryCodesTable: dynamodb.Table;
  public readonly riskAssessmentTable: dynamodb.Table;
  public readonly smsCodesTable: dynamodb.Table;
  public readonly mfaEnrollmentFunction: NodejsFunction;
  public readonly mfaVerificationFunction: NodejsFunction;
  public readonly deviceTrustFunction: NodejsFunction;
  public readonly riskAssessmentFunction: NodejsFunction;
  public readonly smsFallbackFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: MfaManagementConstructProps) {
    super(scope, id);

    const { environment, playerUserPool, adminUserPool, sessionsTable, api } = props;

    // Create DynamoDB tables for MFA management
    const tables = this.createMfaTables(environment);
    this.mfaDevicesTable = tables.mfaDevicesTable;
    this.trustedDevicesTable = tables.trustedDevicesTable;
    this.recoveryCodesTable = tables.recoveryCodesTable;
    this.riskAssessmentTable = tables.riskAssessmentTable;
    this.smsCodesTable = tables.smsCodesTable;

    // Create MFA Lambda functions
    const functions = this.createMfaFunctions(environment, playerUserPool, adminUserPool, sessionsTable);
    this.mfaEnrollmentFunction = functions.mfaEnrollmentFunction;
    this.mfaVerificationFunction = functions.mfaVerificationFunction;
    this.deviceTrustFunction = functions.deviceTrustFunction;
    this.riskAssessmentFunction = functions.riskAssessmentFunction;
    this.smsFallbackFunction = functions.smsFallbackFunction;

    // Create API endpoints for MFA management
    this.createMfaApiEndpoints(api);

    // Create CloudWatch alarms for MFA monitoring
    this.createMfaMonitoring(environment);
  }


  private createMfaTables(environment: string) {
    // Table for storing MFA device registrations
    const mfaDevicesTable = new dynamodb.Table(this, 'MfaDevicesTable', {
      tableName: `game-auth-mfa-devices-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'deviceId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: environment === 'production',
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Table for trusted devices
    const trustedDevicesTable = new dynamodb.Table(this, 'TrustedDevicesTable', {
      tableName: `game-auth-trusted-devices-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'deviceFingerprint',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt', // Trusted device expires after 30 days
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for querying by IP address
    trustedDevicesTable.addGlobalSecondaryIndex({
      indexName: 'IpAddressIndex',
      partitionKey: {
        name: 'ipAddress',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Table for recovery codes
    const recoveryCodesTable = new dynamodb.Table(this, 'RecoveryCodesTable', {
      tableName: `game-auth-recovery-codes-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'codeHash',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Table for risk assessment data
    const riskAssessmentTable = new dynamodb.Table(this, 'RiskAssessmentTable', {
      tableName: `game-auth-risk-assessment-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt', // Keep risk data for 90 days
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for querying by risk level
    riskAssessmentTable.addGlobalSecondaryIndex({
      indexName: 'RiskLevelIndex',
      partitionKey: {
        name: 'riskLevel',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Table for SMS codes (fallback MFA)
    const smsCodesTable = new dynamodb.Table(this, 'SmsCodesTable', {
      tableName: `game-auth-sms-codes-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'codeHash',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: 'expiresAt', // SMS codes expire in 5 minutes
      removalPolicy: environment === 'production' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY
    });

    return {
      mfaDevicesTable,
      trustedDevicesTable,
      recoveryCodesTable,
      riskAssessmentTable,
      smsCodesTable
    };
  }

  private createMfaFunctions(
    environment: string,
    playerUserPool: cognito.UserPool,
    adminUserPool: cognito.UserPool,
    sessionsTable: dynamodb.Table
  ) {
    // MFA Enrollment Function - Handles TOTP setup
    const mfaEnrollmentFunction = new NodejsFunction(this, 'MfaEnrollmentFunction', {
      entry: 'lambda/mfa/enrollment.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
        externalModules: ['aws-sdk']
      },
      environment: {
        ENVIRONMENT: environment,
        MFA_DEVICES_TABLE: `game-auth-mfa-devices-${environment}`,
        RECOVERY_CODES_TABLE: `game-auth-recovery-codes-${environment}`,
        PLAYER_USER_POOL_ID: playerUserPool.userPoolId,
        ADMIN_USER_POOL_ID: adminUserPool.userPoolId,
        ENCRYPTION_KEY: 'mfa-encryption-key-' + environment
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    // MFA Verification Function - Handles TOTP and recovery code verification
    const mfaVerificationFunction = new NodejsFunction(this, 'MfaVerificationFunction', {
      entry: 'lambda/mfa/verification.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
        externalModules: ['aws-sdk']
      },
      environment: {
        ENVIRONMENT: environment,
        MFA_DEVICES_TABLE: `game-auth-mfa-devices-${environment}`,
        RECOVERY_CODES_TABLE: `game-auth-recovery-codes-${environment}`,
        RISK_ASSESSMENT_TABLE: `game-auth-risk-assessment-${environment}`,
        PLAYER_USER_POOL_ID: playerUserPool.userPoolId,
        ADMIN_USER_POOL_ID: adminUserPool.userPoolId,
        ENCRYPTION_KEY: 'mfa-encryption-key-' + environment
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    // Device Trust Management Function
    const deviceTrustFunction = new NodejsFunction(this, 'DeviceTrustFunction', {
      entry: 'lambda/mfa/device-trust.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
        externalModules: ['aws-sdk']
      },
      environment: {
        ENVIRONMENT: environment,
        TRUSTED_DEVICES_TABLE: `game-auth-trusted-devices-${environment}`,
        RISK_ASSESSMENT_TABLE: `game-auth-risk-assessment-${environment}`
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    // Risk Assessment Function - Analyzes suspicious behavior
    const riskAssessmentFunction = new NodejsFunction(this, 'RiskAssessmentFunction', {
      entry: 'lambda/mfa/risk-assessment.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
        externalModules: ['aws-sdk']
      },
      environment: {
        ENVIRONMENT: environment,
        RISK_ASSESSMENT_TABLE: `game-auth-risk-assessment-${environment}`,
        TRUSTED_DEVICES_TABLE: `game-auth-trusted-devices-${environment}`,
        ADMIN_EMAIL: 'admin@loupeen.com'
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    // SMS Fallback Function - Handles SMS-based MFA
    const smsFallbackFunction = new NodejsFunction(this, 'SmsFallbackFunction', {
      entry: 'lambda/mfa/sms-fallback.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: environment === 'production' ? 1024 : 512,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
        externalModules: ['aws-sdk']
      },
      environment: {
        ENVIRONMENT: environment,
        SMS_CODES_TABLE: `game-auth-sms-codes-${environment}`,
        PLAYER_USER_POOL_ID: playerUserPool.userPoolId,
        ADMIN_USER_POOL_ID: adminUserPool.userPoolId,
        SMS_SALT: 'sms-salt-' + environment
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    return {
      mfaEnrollmentFunction,
      mfaVerificationFunction,
      deviceTrustFunction,
      riskAssessmentFunction,
      smsFallbackFunction
    };
  }

  private createMfaApiEndpoints(api: apigateway.RestApi): void {
    const mfa = api.root.addResource('mfa');

    // MFA enrollment endpoint
    const enroll = mfa.addResource('enroll');
    enroll.addMethod('POST', new apigateway.LambdaIntegration(this.mfaEnrollmentFunction));

    // MFA verification endpoint
    const verify = mfa.addResource('verify');
    verify.addMethod('POST', new apigateway.LambdaIntegration(this.mfaVerificationFunction));

    // Device trust management
    const devices = mfa.addResource('devices');
    devices.addMethod('GET', new apigateway.LambdaIntegration(this.deviceTrustFunction));
    devices.addMethod('POST', new apigateway.LambdaIntegration(this.deviceTrustFunction));
    devices.addMethod('DELETE', new apigateway.LambdaIntegration(this.deviceTrustFunction));

    // Risk assessment endpoint
    const risk = mfa.addResource('risk');
    risk.addMethod('POST', new apigateway.LambdaIntegration(this.riskAssessmentFunction));

    // SMS fallback endpoint
    const sms = mfa.addResource('sms');
    sms.addMethod('POST', new apigateway.LambdaIntegration(this.smsFallbackFunction));
  }

  private createMfaMonitoring(environment: string): void {
    // Create CloudWatch metrics for MFA adoption
    const mfaAdoptionMetric = new cdk.aws_cloudwatch.Metric({
      namespace: 'GameAuth/MFA',
      metricName: 'MFAEnrollments',
      dimensionsMap: {
        Environment: environment
      }
    });

    // Create alarm for low MFA adoption
    new cdk.aws_cloudwatch.Alarm(this, 'LowMfaAdoptionAlarm', {
      metric: mfaAdoptionMetric,
      threshold: 50, // Alert if less than 50% users have MFA
      evaluationPeriods: 1,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert when MFA adoption is below 50%'
    });

    // Create metric for failed MFA attempts
    const failedMfaMetric = new cdk.aws_cloudwatch.Metric({
      namespace: 'GameAuth/MFA',
      metricName: 'FailedMFAAttempts',
      dimensionsMap: {
        Environment: environment
      }
    });

    // Create alarm for suspicious MFA failures
    new cdk.aws_cloudwatch.Alarm(this, 'SuspiciousMfaFailuresAlarm', {
      metric: failedMfaMetric,
      threshold: 10, // Alert on 10+ failures in evaluation period
      evaluationPeriods: 2,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Alert on suspicious number of MFA failures'
    });
  }
}