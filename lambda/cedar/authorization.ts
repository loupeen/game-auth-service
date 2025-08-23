import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

interface AuthorizationRequest {
  principal: {
    entityType: string;
    entityId: string;
  };
  action: {
    actionType: string;
    actionId: string;
  };
  resource: {
    entityType: string;
    entityId: string;
  };
  context?: Record<string, any>;
}

interface AuthorizationResult {
  decision: 'ALLOW' | 'DENY';
  determiningPolicies: string[];
  errors: string[];
  latency: number;
  cached: boolean;
}

interface PolicyRecord {
  policyId: string;
  policyContent: string;
  policyType: string;
  isActive: boolean;
  priority: number;
  version: string;
}

interface EntityRecord {
  entityType: string;
  entityId: string;
  attributes: Record<string, any>;
  relationships: Record<string, any>;
  expiresAt?: number;
}

class CedarAuthorizationService {
  private dynamodb: DynamoDBClient;
  private cloudwatch: CloudWatchClient;
  private policyStoreTable: string;
  private entityStoreTable: string;
  private policyCache: Map<string, PolicyRecord[]>;
  private entityCache: Map<string, EntityRecord>;
  
  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cloudwatch = new CloudWatchClient({ region: process.env.REGION });
    this.policyStoreTable = process.env.POLICY_STORE_TABLE!;
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    this.policyCache = new Map();
    this.entityCache = new Map();
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    const startTime = Date.now();
    
    try {
      // Get active policies
      const policies = await this.getActivePolicies();
      
      // Get entity information
      const principalEntity = await this.getEntity(request.principal.entityType, request.principal.entityId);
      const resourceEntity = await this.getEntity(request.resource.entityType, request.resource.entityId);
      
      // Build Cedar entities
      const entities = this.buildCedarEntities(principalEntity, resourceEntity);
      
      // Evaluate policies using Cedar WASM
      const decision = await this.evaluatePolicies(policies, entities, request);
      
      const latency = Date.now() - startTime;
      
      // Send metrics to CloudWatch
      if (process.env.ENABLE_DETAILED_METRICS === 'true') {
        await this.sendMetrics(decision, latency);
      }
      
      return {
        decision: decision.decision,
        determiningPolicies: decision.determiningPolicies,
        errors: decision.errors,
        latency,
        cached: false
      };
      
    } catch (error) {
      console.error('Authorization error:', error);
      
      const latency = Date.now() - startTime;
      await this.sendErrorMetrics(latency);
      
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Authorization evaluation failed: ${error}`],
        latency,
        cached: false
      };
    }
  }

  private async getActivePolicies(): Promise<PolicyRecord[]> {
    const cacheKey = 'active-policies';
    
    if (this.policyCache.has(cacheKey)) {
      return this.policyCache.get(cacheKey)!;
    }

    const command = new QueryCommand({
      TableName: this.policyStoreTable,
      IndexName: 'ActivePoliciesIndex',
      KeyConditionExpression: 'isActive = :active',
      ExpressionAttributeValues: {
        ':active': { S: 'true' }
      },
      ScanIndexForward: false // Sort by priority descending
    });

    const result = await this.dynamodb.send(command);
    const policies = result.Items?.map(item => unmarshall(item) as PolicyRecord) || [];
    
    // Cache for 5 minutes
    this.policyCache.set(cacheKey, policies);
    setTimeout(() => this.policyCache.delete(cacheKey), 300000);
    
    return policies;
  }

  private async getEntity(entityType: string, entityId: string): Promise<EntityRecord | null> {
    const cacheKey = `${entityType}:${entityId}`;
    
    if (this.entityCache.has(cacheKey)) {
      return this.entityCache.get(cacheKey)!;
    }

    const command = new GetItemCommand({
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: entityType },
        entityId: { S: entityId }
      }
    });

    const result = await this.dynamodb.send(command);
    
    if (!result.Item) {
      return null;
    }

    const entity = unmarshall(result.Item) as EntityRecord;
    
    // Cache for 1 minute (entities change more frequently)
    this.entityCache.set(cacheKey, entity);
    setTimeout(() => this.entityCache.delete(cacheKey), 60000);
    
    return entity;
  }

  private buildCedarEntities(principalEntity: EntityRecord | null, resourceEntity: EntityRecord | null): string {
    const entities: Record<string, any> = {};
    
    if (principalEntity) {
      entities[`${principalEntity.entityType}::"${principalEntity.entityId}"`] = {
        ...principalEntity.attributes,
        parents: this.buildParentRelationships(principalEntity)
      };
    }
    
    if (resourceEntity) {
      entities[`${resourceEntity.entityType}::"${resourceEntity.entityId}"`] = {
        ...resourceEntity.attributes,
        parents: this.buildParentRelationships(resourceEntity)
      };
    }
    
    return JSON.stringify(entities);
  }

  private buildParentRelationships(entity: EntityRecord): string[] {
    const parents: string[] = [];
    
    if (entity.relationships) {
      // Add alliance membership
      if (entity.relationships.alliance) {
        parents.push(`Alliance::"${entity.relationships.alliance}"`);
      }
      
      // Add role memberships
      if (entity.relationships.roles) {
        entity.relationships.roles.forEach((role: string) => {
          parents.push(`Role::"${role}"`);
        });
      }
      
      // Add group memberships
      if (entity.relationships.groups) {
        entity.relationships.groups.forEach((group: string) => {
          parents.push(`Group::"${group}"`);
        });
      }
    }
    
    return parents;
  }

  private async evaluatePolicies(
    policies: PolicyRecord[],
    entities: string,
    request: AuthorizationRequest
  ): Promise<{ decision: 'ALLOW' | 'DENY'; determiningPolicies: string[]; errors: string[] }> {
    try {
      // Build Cedar authorization call with correct types
      const authorizationCall = {
        principal: {
          type: request.principal.entityType,
          id: request.principal.entityId
        },
        action: {
          type: request.action.actionType,
          id: request.action.actionId
        },
        resource: {
          type: request.resource.entityType,
          id: request.resource.entityId
        },
        context: request.context || {},
        policies: {
          staticPolicies: policies.map(p => p.policyContent).join('\n\n')
        },
        entities: JSON.parse(entities)
      };
      
      // Evaluate authorization using Cedar WASM
      const result = cedar.isAuthorized(authorizationCall);
      
      if (result.type === 'success') {
        return {
          decision: result.response.decision === 'allow' ? 'ALLOW' : 'DENY',
          determiningPolicies: result.response.diagnostics?.reason || [],
          errors: result.response.diagnostics?.errors?.map(e => e.error.message) || []
        };
      } else {
        return {
          decision: 'DENY',
          determiningPolicies: [],
          errors: result.errors?.map(e => e.message) || ['Authorization failed']
        };
      }
      
    } catch (error) {
      console.error('Cedar evaluation error:', error);
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Policy evaluation failed: ${error}`]
      };
    }
  }

  private async sendMetrics(decision: any, latency: number): Promise<void> {
    try {
      const command = new PutMetricDataCommand({
        Namespace: 'Loupeen/Authorization',
        MetricData: [
          {
            MetricName: 'AuthorizationLatency',
            Value: latency,
            Unit: 'Milliseconds',
            Dimensions: [
              {
                Name: 'Environment',
                Value: process.env.ENVIRONMENT!
              },
              {
                Name: 'Decision',
                Value: decision.decision
              }
            ]
          },
          {
            MetricName: 'AuthorizationRequests',
            Value: 1,
            Unit: 'Count',
            Dimensions: [
              {
                Name: 'Environment',
                Value: process.env.ENVIRONMENT!
              },
              {
                Name: 'Decision',
                Value: decision.decision
              }
            ]
          }
        ]
      });

      await this.cloudwatch.send(command);
    } catch (error) {
      console.error('Failed to send metrics:', error);
    }
  }

  private async sendErrorMetrics(latency: number): Promise<void> {
    try {
      const command = new PutMetricDataCommand({
        Namespace: 'Loupeen/Authorization',
        MetricData: [
          {
            MetricName: 'AuthorizationErrors',
            Value: 1,
            Unit: 'Count',
            Dimensions: [
              {
                Name: 'Environment',
                Value: process.env.ENVIRONMENT!
              }
            ]
          },
          {
            MetricName: 'AuthorizationLatency',
            Value: latency,
            Unit: 'Milliseconds',
            Dimensions: [
              {
                Name: 'Environment',
                Value: process.env.ENVIRONMENT!
              },
              {
                Name: 'Decision',
                Value: 'ERROR'
              }
            ]
          }
        ]
      });

      await this.cloudwatch.send(command);
    } catch (error) {
      console.error('Failed to send error metrics:', error);
    }
  }
}

// Global instance to reuse across Lambda invocations
let authService: CedarAuthorizationService;

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  console.log('Cedar Authorization Request:', JSON.stringify(event, null, 2));
  
  if (!authService) {
    authService = new CedarAuthorizationService();
  }

  try {
    // Parse request body
    const request: AuthorizationRequest = JSON.parse(event.body || '{}');
    
    // Validate request structure
    if (!request.principal || !request.action || !request.resource) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: 'Invalid request',
          message: 'Principal, action, and resource are required'
        })
      };
    }

    // Perform authorization
    const result = await authService.authorize(request);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Handler error:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: 'Authorization evaluation failed'
      })
    };
  }
};