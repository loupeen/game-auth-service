import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { JwtManagementConstruct } from '../lib/constructs/jwt-management-construct';

describe('JwtManagementConstruct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');

    // Create mock dependencies
    const sessionsTable = new dynamodb.Table(stack, 'MockSessionsTable', {
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    const api = new apigateway.RestApi(stack, 'MockApi', {
      restApiName: 'mock-api'
    });

    // Create the construct
    new JwtManagementConstruct(stack, 'JwtManagement', {
      environment: 'test',
      playerUserPoolId: 'player-pool-id',
      adminUserPoolId: 'admin-pool-id',
      playerUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/player-pool-id',
      adminUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/admin-pool-id',
      sessionsTable,
      api
    });

    template = Template.fromStack(stack);
  });

  describe('DynamoDB Tables', () => {
    test('creates refresh tokens table with correct configuration', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'game-auth-refresh-tokens-test',
        KeySchema: [
          { AttributeName: 'tokenId', KeyType: 'HASH' },
          { AttributeName: 'userId', KeyType: 'RANGE' }
        ],
        SSESpecification: {
          SSEEnabled: true
        },
        TimeToLiveSpecification: {
          AttributeName: 'expiresAt',
          Enabled: true
        }
      });
    });

    test('creates UserIdIndex global secondary index', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'game-auth-refresh-tokens-test',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'UserIdIndex',
            KeySchema: [
              { AttributeName: 'userId', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' }
            ],
            Projection: { ProjectionType: 'ALL' }
          })
        ])
      });
    });

    test('creates TokenFamilyIndex global secondary index', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'game-auth-refresh-tokens-test',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'TokenFamilyIndex',
            KeySchema: [
              { AttributeName: 'tokenFamily', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' }
            ],
            Projection: { ProjectionType: 'ALL' }
          })
        ])
      });
    });

    test('creates rate limit table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'game-auth-rate-limits-test',
        KeySchema: [
          { AttributeName: 'identifier', KeyType: 'HASH' },
          { AttributeName: 'windowStart', KeyType: 'RANGE' }
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: {
          AttributeName: 'expiresAt',
          Enabled: true
        }
      });
    });

    test('creates revoked tokens table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'game-auth-revoked-tokens-test',
        KeySchema: [
          { AttributeName: 'jti', KeyType: 'HASH' }
        ],
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: {
          AttributeName: 'expiresAt',
          Enabled: true
        }
      });
    });
  });

  describe('Lambda Functions', () => {
    test('creates token generation function with correct configuration', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 10,
        MemorySize: 512,
        Environment: {
          Variables: Match.objectLike({
            ENVIRONMENT: 'test',
            PLAYER_USER_POOL_ID: 'player-pool-id',
            ADMIN_USER_POOL_ID: 'admin-pool-id',
            JWT_ACCESS_TOKEN_EXPIRY: '900',
            JWT_REFRESH_TOKEN_EXPIRY: '2592000'
          })
        },
        TracingConfig: {
          Mode: 'Active'
        }
      });
    });

    test('creates token validation function with fast timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 5,
        Environment: {
          Variables: Match.objectLike({
            JWKS_CACHE_TTL: '3600'
          })
        }
      });
    });

    test('creates refresh token function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 10,
        MemorySize: 512
      });
    });

    test('creates token revocation function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 5,
        MemorySize: 512
      });
    });
  });

  describe('IAM Permissions', () => {
    test('grants DynamoDB permissions to Lambda functions', () => {
      // Verify that policies are created for Lambda functions
      template.hasResource('AWS::IAM::Policy', {
        Properties: {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Resource: Match.anyValue()
              })
            ])
          }
        }
      });
      
      // Check that multiple IAM policies exist (should be more than 0)
      const resources = template.findResources('AWS::IAM::Policy');
      expect(Object.keys(resources).length).toBeGreaterThan(0);
    });

    test('grants Cognito permissions to Lambda functions', () => {
      // Verify that Cognito policies are created
      template.hasResource('AWS::IAM::Policy', {
        Properties: {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Action: Match.arrayWith(['cognito-idp:GetUser'])
              })
            ])
          }
        }
      });
    });
  });

  describe('API Gateway Integration', () => {
    test('creates JWT endpoints', () => {
      // Check for Lambda integrations
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST',
        ResourceId: Match.anyValue(),
        RestApiId: Match.anyValue(),
        Integration: {
          Type: 'AWS_PROXY'
        }
      });
    });

    test('creates usage plan with rate limiting', () => {
      template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
        Throttle: {
          RateLimit: 10,
          BurstLimit: 20
        },
        Quota: {
          Limit: 10000,
          Period: 'DAY'
        }
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    test('creates token validation latency alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Duration',
        Statistic: 'Average',
        Threshold: 50,
        EvaluationPeriods: 2,
        TreatMissingData: 'notBreaching'
      });
    });

    test('creates token generation error alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Errors',
        Statistic: 'Sum',
        Threshold: 10,
        EvaluationPeriods: 1
      });
    });

    test('creates refresh token failure alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Errors',
        Statistic: 'Sum',
        Threshold: 5,
        EvaluationPeriods: 1
      });
    });

    test('creates rate limit breach alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Throttles',
        Statistic: 'Sum',
        Threshold: 100,
        EvaluationPeriods: 1
      });
    });
  });

  describe('Environment-specific Configuration', () => {
    test('uses PAY_PER_REQUEST billing for production refresh tokens table', () => {
      const prodApp = new cdk.App();
      const prodStack = new cdk.Stack(prodApp, 'ProdStack');
      const sessionsTable = new dynamodb.Table(prodStack, 'SessionsTable', {
        partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
      });
      const api = new apigateway.RestApi(prodStack, 'Api');

      new JwtManagementConstruct(prodStack, 'ProdJwtManagement', {
        environment: 'production',
        playerUserPoolId: 'player-pool-id',
        adminUserPoolId: 'admin-pool-id',
        playerUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/player-pool-id',
        adminUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/admin-pool-id',
        sessionsTable,
        api
      });

      const prodTemplate = Template.fromStack(prodStack);
      prodTemplate.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'game-auth-refresh-tokens-production',
        BillingMode: 'PAY_PER_REQUEST'
      });
    });

    test('uses higher memory for production Lambda functions', () => {
      const prodApp = new cdk.App();
      const prodStack = new cdk.Stack(prodApp, 'ProdStack');
      const sessionsTable = new dynamodb.Table(prodStack, 'SessionsTable', {
        partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
      });
      const api = new apigateway.RestApi(prodStack, 'Api');

      new JwtManagementConstruct(prodStack, 'ProdJwtManagement', {
        environment: 'production',
        playerUserPoolId: 'player-pool-id',
        adminUserPoolId: 'admin-pool-id',
        playerUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/player-pool-id',
        adminUserPoolArn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/admin-pool-id',
        sessionsTable,
        api
      });

      const prodTemplate = Template.fromStack(prodStack);
      prodTemplate.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 1024
      });
    });
  });
});