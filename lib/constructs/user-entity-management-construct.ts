import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { getGameAuthConfig } from '../config/environment-config';

export interface UserEntityManagementConstructProps {
  environment: string;
  entityStore: dynamodb.Table;
  playerUserPoolId: string;
  adminUserPoolId: string;
  api: apigateway.RestApi;
}

/**
 * User Entity Management Construct
 * 
 * Provides user-focused entity management APIs for the Loupeen RTS Platform.
 * Handles user profiles, alliance membership, game statistics, and settings.
 */
export class UserEntityManagementConstruct extends Construct {
  private _userEntityService!: NodejsFunction;
  private _userStatsService!: NodejsFunction;
  private _userBatchService!: NodejsFunction;

  public get userEntityService(): NodejsFunction {
    return this._userEntityService;
  }

  public get userStatsService(): NodejsFunction {
    return this._userStatsService;
  }

  public get userBatchService(): NodejsFunction {
    return this._userBatchService;
  }

  private readonly config: ReturnType<typeof getGameAuthConfig>;

  constructor(scope: Construct, id: string, props: UserEntityManagementConstructProps) {
    super(scope, id);

    this.config = getGameAuthConfig(props.environment);

    // Create user entity services
    this.createUserEntityServices(props);
    
    // Set up API endpoints
    this.createApiEndpoints(props);
    
    // Create CloudWatch monitoring
    this.createMonitoring();
    
    // Output configuration
    this.outputConfiguration();
  }

  private createUserEntityServices(props: UserEntityManagementConstructProps): void {
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: this.config.features.xrayTracing 
        ? lambda.Tracing.ACTIVE 
        : lambda.Tracing.DISABLED
    };

    // Main user entity service - handles profiles, alliances, settings
    this._userEntityService = new NodejsFunction(this, 'UserEntityService', {
      ...commonLambdaProps,
      entry: 'lambda/user/user-entity-service.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        ENVIRONMENT: props.environment,
        ENTITY_STORE_TABLE: props.entityStore.tableName,
        PLAYER_USER_POOL_ID: props.playerUserPoolId,
        ADMIN_USER_POOL_ID: props.adminUserPoolId,
        REGION: this.config.region
      }
    });

    // User statistics service - handles game stats, leaderboards
    this._userStatsService = new NodejsFunction(this, 'UserStatsService', {
      ...commonLambdaProps,
      entry: 'lambda/user/user-stats-service.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ENVIRONMENT: props.environment,
        ENTITY_STORE_TABLE: props.entityStore.tableName,
        REGION: this.config.region
      }
    });

    // Batch operations service - handles bulk user operations
    this._userBatchService = new NodejsFunction(this, 'UserBatchService', {
      ...commonLambdaProps,
      entry: 'lambda/user/user-batch-service.ts',
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        ENVIRONMENT: props.environment,
        ENTITY_STORE_TABLE: props.entityStore.tableName,
        PLAYER_USER_POOL_ID: props.playerUserPoolId,
        ADMIN_USER_POOL_ID: props.adminUserPoolId,
        REGION: this.config.region,
        BATCH_SIZE: '50'
      }
    });

    // Grant permissions
    this.grantPermissions(props);
  }

  private grantPermissions(props: UserEntityManagementConstructProps): void {
    // Entity store permissions
    props.entityStore.grantReadWriteData(this.userEntityService);
    props.entityStore.grantReadData(this.userStatsService);
    props.entityStore.grantReadWriteData(this.userBatchService);

    // Cognito permissions for user details
    const cognitoPolicy = new iam.PolicyStatement({
      actions: [
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminListGroupsForUser'
      ],
      resources: [
        `arn:aws:cognito-idp:${this.config.region}:${this.config.accountId}:userpool/${props.playerUserPoolId}`,
        `arn:aws:cognito-idp:${this.config.region}:${this.config.accountId}:userpool/${props.adminUserPoolId}`
      ]
    });

    [this.userEntityService, this.userBatchService].forEach(fn => 
      fn.addToRolePolicy(cognitoPolicy)
    );

    // CloudWatch metrics permissions
    const cloudWatchPolicy = new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': 'Loupeen/UserManagement'
        }
      }
    });

    [this.userEntityService, this.userStatsService, this.userBatchService].forEach(fn =>
      fn.addToRolePolicy(cloudWatchPolicy)
    );
  }

  private createApiEndpoints(props: UserEntityManagementConstructProps): void {
    // User profiles endpoint
    const users = props.api.root.addResource('users');
    
    // GET /users/{userId} - Get user profile
    const userById = users.addResource('{userId}');
    userById.addMethod('GET', new apigateway.LambdaIntegration(this.userEntityService), {
      requestParameters: {
        'method.request.path.userId': true
      }
    });

    // PUT /users/{userId} - Update user profile
    userById.addMethod('PUT', new apigateway.LambdaIntegration(this.userEntityService), {
      requestParameters: {
        'method.request.path.userId': true
      }
    });

    // POST /users/{userId}/alliance - Join/leave alliance
    const userAlliance = userById.addResource('alliance');
    userAlliance.addMethod('POST', new apigateway.LambdaIntegration(this.userEntityService));
    userAlliance.addMethod('DELETE', new apigateway.LambdaIntegration(this.userEntityService));

    // GET /users/{userId}/stats - Get user statistics
    const userStats = userById.addResource('stats');
    userStats.addMethod('GET', new apigateway.LambdaIntegration(this.userStatsService));

    // Alliance members endpoint
    const alliances = props.api.root.addResource('alliances');
    const allianceMembers = alliances.addResource('{allianceId}').addResource('members');
    allianceMembers.addMethod('GET', new apigateway.LambdaIntegration(this.userEntityService), {
      requestParameters: {
        'method.request.path.allianceId': true
      }
    });

    // Batch operations endpoint (admin only)
    const batch = props.api.root.addResource('batch');
    const batchUsers = batch.addResource('users');
    batchUsers.addMethod('POST', new apigateway.LambdaIntegration(this.userBatchService));
    batchUsers.addMethod('PUT', new apigateway.LambdaIntegration(this.userBatchService));

    // CORS is handled globally by the main API Gateway configuration
  }


  private createMonitoring(): void {
    // User service performance alarm
    new cloudwatch.Alarm(this, 'UserServiceLatencyAlarm', {
      alarmName: `${this.config.environment}-user-service-high-latency`,
      alarmDescription: 'User entity service high latency',
      metric: this.userEntityService.metricDuration({
        statistic: 'Average'
      }),
      threshold: 5000, // 5 seconds
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // User service error alarm
    new cloudwatch.Alarm(this, 'UserServiceErrorAlarm', {
      alarmName: `${this.config.environment}-user-service-errors`,
      alarmDescription: 'User entity service errors',
      metric: this.userEntityService.metricErrors({
        statistic: 'Sum'
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Batch operations monitoring
    new cloudwatch.Alarm(this, 'BatchServiceThrottleAlarm', {
      alarmName: `${this.config.environment}-batch-service-throttles`,
      alarmDescription: 'Batch service throttling',
      metric: this.userBatchService.metricThrottles({
        statistic: 'Sum'
      }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    });
  }

  private outputConfiguration(): void {
    new cdk.CfnOutput(this, 'UserEntityServiceArn', {
      value: this.userEntityService.functionArn,
      description: 'User Entity Service Lambda ARN'
    });

    new cdk.CfnOutput(this, 'UserStatsServiceArn', {
      value: this.userStatsService.functionArn,
      description: 'User Stats Service Lambda ARN'
    });

    new cdk.CfnOutput(this, 'UserBatchServiceArn', {
      value: this.userBatchService.functionArn,
      description: 'User Batch Service Lambda ARN'
    });
  }
}