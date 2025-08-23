import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { UserEntityManagementConstruct } from '../../../lib/constructs/user-entity-management-construct';

describe('UserEntityManagementConstruct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');

    // Create mock dependencies
    const entityStore = new dynamodb.Table(stack, 'MockEntityStore', {
      partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entityId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    const api = new apigateway.RestApi(stack, 'MockApi', {
      restApiName: 'mock-api'
    });

    // Create the construct
    new UserEntityManagementConstruct(stack, 'UserEntityManagement', {
      environment: 'test',
      entityStore,
      playerUserPoolId: 'player-pool-id',
      adminUserPoolId: 'admin-pool-id',
      api
    });

    template = Template.fromStack(stack);
  });

  describe('Lambda Functions', () => {
    test('creates user entity service function with correct configuration', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 15,
        MemorySize: 512,
        Environment: {
          Variables: Match.objectLike({
            ENVIRONMENT: 'test',
            PLAYER_USER_POOL_ID: 'player-pool-id',
            ADMIN_USER_POOL_ID: 'admin-pool-id'
          })
        },
        TracingConfig: {
          Mode: 'Disabled'
        }
      });
    });

    test('creates user stats service function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 10,
        MemorySize: 256
      });
    });

    test('creates user batch service function with higher timeout', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Architectures: ['arm64'],
        Timeout: 300,
        MemorySize: 1024,
        Environment: {
          Variables: Match.objectLike({
            BATCH_SIZE: '50'
          })
        }
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
                Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'])
              })
            ])
          }
        }
      });
    });

    test('grants Cognito permissions to appropriate functions', () => {
      template.hasResource('AWS::IAM::Policy', {
        Properties: {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Action: Match.arrayWith(['cognito-idp:AdminGetUser'])
              })
            ])
          }
        }
      });
    });

    test('grants CloudWatch metrics permissions', () => {
      template.hasResource('AWS::IAM::Policy', {
        Properties: {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Action: ['cloudwatch:PutMetricData'],
                Condition: {
                  StringEquals: {
                    'cloudwatch:namespace': 'Loupeen/UserManagement'
                  }
                }
              })
            ])
          }
        }
      });
    });
  });

  describe('API Gateway Integration', () => {
    test('creates user profile endpoints', () => {
      // Check for user resource creation
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'users'
      });

      // Check for {userId} parameter resource
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: '{userId}'
      });

      // Check for GET method on user profile
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'GET',
        RequestParameters: {
          'method.request.path.userId': true
        },
        Integration: {
          Type: 'AWS_PROXY'
        }
      });

      // Check for PUT method on user profile
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'PUT',
        RequestParameters: {
          'method.request.path.userId': true
        },
        Integration: {
          Type: 'AWS_PROXY'
        }
      });
    });

    test('creates alliance endpoints', () => {
      // Check for alliance resource
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'alliances'
      });

      // Check for alliance members endpoint
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'members'
      });
    });

    test('creates batch operations endpoints', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'batch'
      });

      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'users'
      });
    });

    test('creates CORS options methods', () => {
      // Check for OPTIONS methods with CORS configuration
      template.hasResource('AWS::ApiGateway::Method', {
        Properties: {
          HttpMethod: 'OPTIONS',
          Integration: {
            Type: 'MOCK',
            IntegrationResponses: Match.arrayWith([
              Match.objectLike({
                ResponseParameters: {
                  'method.response.header.Access-Control-Allow-Origin': "'*'",
                  'method.response.header.Access-Control-Allow-Headers': "'Content-Type,Authorization'",
                  'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE'"
                }
              })
            ])
          }
        }
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    test('creates user service latency alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-user-service-high-latency',
        MetricName: 'Duration',
        Statistic: 'Average',
        Threshold: 5000,
        EvaluationPeriods: 2,
        TreatMissingData: 'notBreaching'
      });
    });

    test('creates user service error alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-user-service-errors',
        MetricName: 'Errors',
        Statistic: 'Sum',
        Threshold: 5,
        EvaluationPeriods: 1
      });
    });

    test('creates batch service throttle alarm', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'test-batch-service-throttles',
        MetricName: 'Throttles',
        Statistic: 'Sum',
        Threshold: 10,
        EvaluationPeriods: 1
      });
    });
  });

  describe('Environment-specific Configuration', () => {
    test('uses different configurations for production', () => {
      const prodApp = new cdk.App();
      const prodStack = new cdk.Stack(prodApp, 'ProdStack');
      
      const entityStore = new dynamodb.Table(prodStack, 'EntityStore', {
        partitionKey: { name: 'entityType', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'entityId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
      });

      const api = new apigateway.RestApi(prodStack, 'Api');

      new UserEntityManagementConstruct(prodStack, 'ProdUserEntityManagement', {
        environment: 'production',
        entityStore,
        playerUserPoolId: 'prod-player-pool',
        adminUserPoolId: 'prod-admin-pool',
        api
      });

      const prodTemplate = Template.fromStack(prodStack);
      
      // Check for production-specific configurations
      prodTemplate.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            ENVIRONMENT: 'production'
          })
        }
      });
    });
  });

  describe('Outputs', () => {
    test('creates stack outputs for function ARNs', () => {
      template.hasOutput('UserEntityServiceArn', {
        Description: 'User Entity Service Lambda ARN'
      });

      template.hasOutput('UserStatsServiceArn', {
        Description: 'User Stats Service Lambda ARN'
      });

      template.hasOutput('UserBatchServiceArn', {
        Description: 'User Batch Service Lambda ARN'
      });
    });
  });
});