import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { getGameAuthConfig } from '../config/environment-config';

export interface CedarAuthorizationConstructProps {
  environment: string;
  region?: string;
  accountId?: string;
  playerUserPoolId: string;
  adminUserPoolId: string;
  playerUserPoolClientId: string;
  adminUserPoolClientId: string;
  sessionsTable: dynamodb.Table;
}

/**
 * Cedar Authorization Engine Construct
 * 
 * Implements fine-grained access control for the Loupeen RTS Platform using
 * Cedar authorization policies with custom policy store and evaluation engine.
 */
export class CedarAuthorizationConstruct extends Construct {
  private _policyStore!: dynamodb.Table;
  private _entityStore!: dynamodb.Table;
  private _authorizationFunction!: NodejsFunction;
  private _policyManagementFunction!: NodejsFunction;
  private _entityManagementFunction!: NodejsFunction;
  private _enhancedJWTCedarFunction!: NodejsFunction;
  
  private readonly config: ReturnType<typeof getGameAuthConfig>;
  private readonly props: CedarAuthorizationConstructProps;

  public get policyStore(): dynamodb.Table {
    return this._policyStore;
  }

  public get entityStore(): dynamodb.Table {
    return this._entityStore;
  }

  public get authorizationFunction(): NodejsFunction {
    return this._authorizationFunction;
  }

  public get policyManagementFunction(): NodejsFunction {
    return this._policyManagementFunction;
  }

  public get entityManagementFunction(): NodejsFunction {
    return this._entityManagementFunction;
  }

  public get enhancedJWTCedarFunction(): NodejsFunction {
    return this._enhancedJWTCedarFunction;
  }

  constructor(scope: Construct, id: string, props: CedarAuthorizationConstructProps) {
    super(scope, id);

    this.props = props;
    
    // Get comprehensive configuration
    this.config = getGameAuthConfig(props.environment, props.region);

    // Create DynamoDB tables for Cedar policy and entity storage
    this.createPolicyStorage();
    
    // Create Lambda functions for authorization and policy management
    this.createAuthorizationFunctions();
    
    // Grant permissions
    this.grantPermissions();
    
    // Initialize default policies
    this.createDefaultPolicies();
    
    // Output configuration
    this.outputConfiguration();
  }

  private createPolicyStorage(): void {
    // Cedar Policy Store - stores authorization policies
    this._policyStore = new dynamodb.Table(this, 'CedarPolicyStore', {
      tableName: this.config.naming.sessionsTable.replace('sessions', 'cedar-policies'),
      partitionKey: {
        name: 'policyId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'version',
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
        : cdk.RemovalPolicy.DESTROY
    });

    // Add Global Secondary Index for policy type queries
    this._policyStore.addGlobalSecondaryIndex({
      indexName: 'PolicyTypeIndex',
      partitionKey: {
        name: 'policyType',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Add GSI for active policies
    this._policyStore.addGlobalSecondaryIndex({
      indexName: 'ActivePoliciesIndex',
      partitionKey: {
        name: 'isActive',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'priority',
        type: dynamodb.AttributeType.NUMBER
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Cedar Entity Store - stores game entities (users, alliances, resources)
    this._entityStore = new dynamodb.Table(this, 'CedarEntityStore', {
      tableName: this.config.naming.sessionsTable.replace('sessions', 'cedar-entities'),
      partitionKey: {
        name: 'entityType',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'entityId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: this.config.security.pointInTimeRecovery,
      removalPolicy: this.config.security.deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    // Add GSI for entity relationships
    this._entityStore.addGlobalSecondaryIndex({
      indexName: 'EntityRelationshipIndex',
      partitionKey: {
        name: 'parentEntity',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'relationshipType',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });
  }

  private createAuthorizationFunctions(): void {
    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: this.config.lambda.memorySize,
      bundling: {
        forceDockerBundling: false,
        minify: true,
        target: 'es2020',
        keepNames: true,
        esbuildArgs: {
          '--packages': 'bundle'
        },
        commandHooks: {
          beforeBundling(_inputDir: string, _outputDir: string): string[] {
            return [];
          },
          beforeInstall(_inputDir: string, _outputDir: string): string[] {
            return [];
          },
          afterBundling(_inputDir: string, outputDir: string): string[] {
            return [
              `cp node_modules/@cedar-policy/cedar-wasm/nodejs/cedar_wasm_bg.wasm ${outputDir}/`
            ];
          }
        }
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: this.config.features.xrayTracing
        ? lambda.Tracing.ACTIVE
        : lambda.Tracing.DISABLED
    };

    // Main authorization function
    this._authorizationFunction = new NodejsFunction(this, 'CedarAuthorizationFunction', {
      ...commonLambdaProps,
      entry: 'lambda/cedar/authorization.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      environment: {
        ENVIRONMENT: this.config.environment,
        POLICY_STORE_TABLE: this._policyStore.tableName,
        ENTITY_STORE_TABLE: this._entityStore.tableName,
        REGION: this.config.region,
        ENABLE_CACHING: 'true',
        CACHE_TTL_SECONDS: '300', // 5 minutes
        ENABLE_DETAILED_METRICS: this.config.features.detailedMetrics.toString()
      }
    });

    // Policy management function
    this._policyManagementFunction = new NodejsFunction(this, 'CedarPolicyManagementFunction', {
      ...commonLambdaProps,
      entry: 'lambda/cedar/policy-management.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        ENVIRONMENT: this.config.environment,
        POLICY_STORE_TABLE: this._policyStore.tableName,
        ENTITY_STORE_TABLE: this._entityStore.tableName,
        REGION: this.config.region,
        ENABLE_POLICY_VALIDATION: 'true'
      }
    });

    // Entity management function
    this._entityManagementFunction = new NodejsFunction(this, 'CedarEntityManagementFunction', {
      ...commonLambdaProps,
      entry: 'lambda/cedar/entity-management.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      environment: {
        ENVIRONMENT: this.config.environment,
        ENTITY_STORE_TABLE: this._entityStore.tableName,
        REGION: this.config.region
      }
    });

    // Enhanced JWT-Cedar validation function
    this._enhancedJWTCedarFunction = new NodejsFunction(this, 'EnhancedJWTCedarFunction', {
      ...commonLambdaProps,
      entry: 'lambda/jwt/enhanced-jwt-cedar-validation.ts',
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: Math.floor(this.config.lambda.memorySize * 1.5), // More memory for JWT + Cedar
      environment: {
        ENVIRONMENT: this.config.environment,
        ENTITY_STORE_TABLE: this._entityStore.tableName,
        POLICY_STORE_TABLE: this._policyStore.tableName,
        SESSIONS_TABLE_NAME: this.props.sessionsTable.tableName,
        PLAYER_USER_POOL_ID: this.props.playerUserPoolId,
        ADMIN_USER_POOL_ID: this.props.adminUserPoolId,
        PLAYER_USER_POOL_CLIENT_ID: this.props.playerUserPoolClientId,
        ADMIN_USER_POOL_CLIENT_ID: this.props.adminUserPoolClientId,
        REGION: this.config.region,
        ENABLE_DETAILED_METRICS: this.config.features.detailedMetrics.toString()
      }
    });
  }

  private grantPermissions(): void {
    // Authorization function permissions
    this._policyStore.grantReadData(this.authorizationFunction);
    this._entityStore.grantReadData(this.authorizationFunction);

    // Policy management permissions
    this._policyStore.grantReadWriteData(this.policyManagementFunction);
    this._entityStore.grantReadWriteData(this.policyManagementFunction);

    // Entity management permissions
    this._entityStore.grantReadWriteData(this.entityManagementFunction);

    // Enhanced JWT-Cedar function permissions
    this._policyStore.grantReadData(this.enhancedJWTCedarFunction);
    this._entityStore.grantReadWriteData(this.enhancedJWTCedarFunction);
    this.props.sessionsTable.grantReadWriteData(this.enhancedJWTCedarFunction);

    // CloudWatch permissions for custom metrics
    const cloudWatchPolicy = new iam.PolicyStatement({
      actions: [
        'cloudwatch:PutMetricData'
      ],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': ['Loupeen/Authorization', 'Loupeen/EnhancedAuth']
        }
      }
    });

    [this.authorizationFunction, this.policyManagementFunction, this.enhancedJWTCedarFunction].forEach(fn =>
      fn.addToRolePolicy(cloudWatchPolicy)
    );
  }

  private createDefaultPolicies(): void {
    // Create a custom resource to initialize default policies
    const policyInitializer = new NodejsFunction(this, 'PolicyInitializerFunction', {
      entry: 'lambda/cedar/policy-initializer.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      environment: {
        POLICY_STORE_TABLE: this._policyStore.tableName,
        ENTITY_STORE_TABLE: this._entityStore.tableName,
        ENVIRONMENT: this.config.environment
      }
    });

    this._policyStore.grantReadWriteData(policyInitializer);
    this._entityStore.grantReadWriteData(policyInitializer);

    // Custom resource to initialize policies on deployment
    new cdk.CustomResource(this, 'DefaultPolicyInitializer', {
      serviceToken: policyInitializer.functionArn,
      properties: {
        Environment: this.config.environment,
        Version: '1.0.0'
      }
    });
  }

  private outputConfiguration(): void {
    new cdk.CfnOutput(this, 'CedarPolicyStoreTable', {
      value: this._policyStore.tableName,
      description: 'Cedar Policy Store DynamoDB Table'
    });

    new cdk.CfnOutput(this, 'CedarEntityStoreTable', {
      value: this._entityStore.tableName,
      description: 'Cedar Entity Store DynamoDB Table'
    });

    new cdk.CfnOutput(this, 'CedarAuthorizationFunctionArn', {
      value: this._authorizationFunction.functionArn,
      description: 'Cedar Authorization Function ARN'
    });

    new cdk.CfnOutput(this, 'CedarPolicyManagementFunctionArn', {
      value: this._policyManagementFunction.functionArn,
      description: 'Cedar Policy Management Function ARN'
    });

    new cdk.CfnOutput(this, 'CedarConfiguration', {
      value: JSON.stringify({
        environment: this.config.environment,
        policyStore: this._policyStore.tableName,
        entityStore: this._entityStore.tableName,
        authorizationFunction: this._authorizationFunction.functionName
      }, null, 2),
      description: 'Cedar Authorization Configuration'
    });
  }
}