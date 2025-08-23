import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand, DeleteItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

interface EntityRequest {
  action: 'create' | 'update' | 'delete' | 'get' | 'list';
  entityType?: string;
  entityId?: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, any>;
  ttl?: number; // TTL in seconds
}

interface EntityRecord {
  entityType: string;
  entityId: string;
  attributes: Record<string, any>;
  relationships: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  version: number;
}

class CedarEntityManagementService {
  private dynamodb: DynamoDBClient;
  private entityStoreTable: string;
  
  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
  }

  async createEntity(entityData: Omit<EntityRecord, 'createdAt' | 'updatedAt' | 'version'>): Promise<EntityRecord> {
    const timestamp = Date.now();
    
    const entity: EntityRecord = {
      entityType: entityData.entityType,
      entityId: entityData.entityId,
      attributes: entityData.attributes || {},
      relationships: entityData.relationships || {},
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      ...(entityData.expiresAt && { expiresAt: entityData.expiresAt })
    };

    const command = new PutItemCommand({
      TableName: this.entityStoreTable,
      Item: marshall(entity),
      ConditionExpression: 'attribute_not_exists(entityType) AND attribute_not_exists(entityId)'
    });

    await this.dynamodb.send(command);
    return entity;
  }

  async updateEntity(entityType: string, entityId: string, updates: Partial<EntityRecord>): Promise<EntityRecord> {
    // Get current entity for version checking
    const currentEntity = await this.getEntity(entityType, entityId);
    if (!currentEntity) {
      throw new Error('Entity not found');
    }

    const updateExpression: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    // Build update expression
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'entityType' && key !== 'entityId' && key !== 'createdAt') {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    // Always update timestamp and increment version
    updateExpression.push('#updatedAt = :updatedAt', '#version = :version');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeNames['#version'] = 'version';
    expressionAttributeValues[':updatedAt'] = Date.now();
    expressionAttributeValues[':version'] = currentEntity.version + 1;

    const command = new UpdateItemCommand({
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: entityType },
        entityId: { S: entityId }
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
      ConditionExpression: 'attribute_exists(entityType) AND attribute_exists(entityId) AND version = :currentVersion',
      ReturnValues: 'ALL_NEW'
    });

    // Add current version to condition
    expressionAttributeValues[':currentVersion'] = currentEntity.version;

    const result = await this.dynamodb.send(command);
    return unmarshall(result.Attributes!) as EntityRecord;
  }

  async getEntity(entityType: string, entityId: string): Promise<EntityRecord | null> {
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

    return unmarshall(result.Item) as EntityRecord;
  }

  async deleteEntity(entityType: string, entityId: string): Promise<void> {
    const command = new DeleteItemCommand({
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: entityType },
        entityId: { S: entityId }
      },
      ConditionExpression: 'attribute_exists(entityType) AND attribute_exists(entityId)'
    });

    await this.dynamodb.send(command);
  }

  async listEntitiesByType(entityType: string, limit?: number): Promise<EntityRecord[]> {
    const command = new QueryCommand({
      TableName: this.entityStoreTable,
      KeyConditionExpression: 'entityType = :entityType',
      ExpressionAttributeValues: {
        ':entityType': { S: entityType }
      },
      ...(limit && { Limit: limit })
    });

    const result = await this.dynamodb.send(command);
    return result.Items?.map(item => unmarshall(item) as EntityRecord) || [];
  }

  async listEntitiesByRelationship(parentEntity: string, relationshipType: string): Promise<EntityRecord[]> {
    const command = new QueryCommand({
      TableName: this.entityStoreTable,
      IndexName: 'EntityRelationshipIndex',
      KeyConditionExpression: 'parentEntity = :parentEntity AND relationshipType = :relationshipType',
      ExpressionAttributeValues: {
        ':parentEntity': { S: parentEntity },
        ':relationshipType': { S: relationshipType }
      }
    });

    const result = await this.dynamodb.send(command);
    return result.Items?.map(item => unmarshall(item) as EntityRecord) || [];
  }

  async syncUserEntity(userId: string, userAttributes: any): Promise<EntityRecord> {
    const entityId = userId;
    const entityType = 'GameUser';

    // Determine user groups/roles based on attributes
    const relationships: Record<string, any> = {};
    
    if (userAttributes.alliance) {
      relationships.alliance = userAttributes.alliance;
      relationships.groups = ['AllianceMembers'];
    }

    if (userAttributes.roles) {
      relationships.roles = userAttributes.roles;
      relationships.groups = [...(relationships.groups || []), ...userAttributes.roles];
    }

    // Check if entity exists
    const existingEntity = await this.getEntity(entityType, entityId);

    if (existingEntity) {
      // Update existing entity
      return await this.updateEntity(entityType, entityId, {
        attributes: userAttributes,
        relationships
      });
    } else {
      // Create new entity
      return await this.createEntity({
        entityType,
        entityId,
        attributes: userAttributes,
        relationships
      });
    }
  }

  async syncAllianceEntity(allianceId: string, allianceData: any): Promise<EntityRecord> {
    const entityType = 'Alliance';
    const entityId = allianceId;

    const relationships: Record<string, any> = {};
    
    if (allianceData.leader) {
      relationships.leader = allianceData.leader;
    }

    if (allianceData.members) {
      relationships.members = allianceData.members;
    }

    // Check if entity exists
    const existingEntity = await this.getEntity(entityType, entityId);

    if (existingEntity) {
      return await this.updateEntity(entityType, entityId, {
        attributes: allianceData,
        relationships
      });
    } else {
      return await this.createEntity({
        entityType,
        entityId,
        attributes: allianceData,
        relationships
      });
    }
  }
}

// Global instance
let entityService: CedarEntityManagementService;

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  console.log('Cedar Entity Management Request:', JSON.stringify(event, null, 2));
  
  if (!entityService) {
    entityService = new CedarEntityManagementService();
  }

  try {
    const request: EntityRequest = JSON.parse(event.body || '{}');

    let result: any;

    switch (request.action) {
      case 'create':
        if (!request.entityType || !request.entityId) {
          throw new Error('Entity type and ID are required for create action');
        }
        result = await entityService.createEntity({
          entityType: request.entityType,
          entityId: request.entityId,
          attributes: request.attributes || {},
          relationships: request.relationships || {},
          ...(request.ttl && { expiresAt: Date.now() + (request.ttl * 1000) })
        });
        break;

      case 'update':
        if (!request.entityType || !request.entityId) {
          throw new Error('Entity type and ID are required for update action');
        }
        result = await entityService.updateEntity(request.entityType, request.entityId, {
          attributes: request.attributes,
          relationships: request.relationships,
          ...(request.ttl && { expiresAt: Date.now() + (request.ttl * 1000) })
        });
        break;

      case 'get':
        if (!request.entityType || !request.entityId) {
          throw new Error('Entity type and ID are required for get action');
        }
        result = await entityService.getEntity(request.entityType, request.entityId);
        if (!result) {
          return {
            statusCode: 404,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Entity not found' })
          };
        }
        break;

      case 'delete':
        if (!request.entityType || !request.entityId) {
          throw new Error('Entity type and ID are required for delete action');
        }
        await entityService.deleteEntity(request.entityType, request.entityId);
        result = { success: true, message: 'Entity deleted successfully' };
        break;

      case 'list':
        if (!request.entityType) {
          throw new Error('Entity type is required for list action');
        }
        result = await entityService.listEntitiesByType(request.entityType);
        break;

      default:
        throw new Error(`Unknown action: ${request.action}`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Entity management error:', error);
    
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Entity management failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};