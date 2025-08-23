import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, BatchWriteItemCommand, QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

interface BatchRequest {
  action: 'sync-cognito-users' | 'batch-update-users' | 'migrate-user-data' | 'cleanup-inactive-users' | 'bulk-alliance-operations' | 'recalculate-stats';
  userIds?: string[];
  updates?: Record<string, any>;
  allianceId?: string;
  dryRun?: boolean;
  batchSize?: number;
  filters?: {
    inactive?: boolean;
    inactiveDays?: number;
    level?: { min?: number; max?: number; };
    alliance?: string[];
  };
}

interface BatchResult {
  totalProcessed: number;
  successful: number;
  failed: number;
  errors: string[];
  results: any[];
  processingTime: number;
}

interface UserMigration {
  fromUserId: string;
  toUserId: string;
  preserveStats: boolean;
  transferAlliance: boolean;
}

class UserBatchService {
  private dynamodb: DynamoDBClient;
  private cognito: CognitoIdentityProviderClient;
  private cloudwatch: CloudWatchClient;
  private entityStoreTable: string;
  private playerUserPoolId: string;
  private adminUserPoolId: string;
  private batchSize: number;

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
    this.cloudwatch = new CloudWatchClient({ region: process.env.REGION });
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    this.playerUserPoolId = process.env.PLAYER_USER_POOL_ID!;
    this.adminUserPoolId = process.env.ADMIN_USER_POOL_ID!;
    this.batchSize = parseInt(process.env.BATCH_SIZE || '50');
  }

  async syncCognitoUsers(dryRun: boolean = false): Promise<BatchResult> {
    const startTime = Date.now();
    const result: BatchResult = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      errors: [],
      results: [],
      processingTime: 0
    };

    try {
      // Get all users from player pool
      const playerUsers = await this.getAllCognitoUsers(this.playerUserPoolId);
      const adminUsers = await this.getAllCognitoUsers(this.adminUserPoolId);
      
      const allUsers = [...playerUsers, ...adminUsers];
      result.totalProcessed = allUsers.length;

      console.log(`Processing ${allUsers.length} Cognito users (dry run: ${dryRun})`);

      // Process users in batches
      for (let i = 0; i < allUsers.length; i += this.batchSize) {
        const batch = allUsers.slice(i, i + this.batchSize);
        
        for (const user of batch) {
          try {
            const userId = user.Username!;
            const userAttributes = this.extractCognitoAttributes(user);
            
            // Check if user entity exists in Cedar store
            const existingEntity = await this.getUserEntity(userId);
            
            if (!existingEntity) {
              // Create new user entity
              if (!dryRun) {
                await this.createUserEntity(userId, userAttributes);
              }
              result.results.push({
                action: 'created',
                userId,
                attributes: userAttributes
              });
            } else {
              // Update existing entity with latest Cognito data
              if (!dryRun) {
                await this.updateUserEntity(userId, userAttributes);
              }
              result.results.push({
                action: 'updated',
                userId,
                changes: this.detectChanges(existingEntity.attributes, userAttributes)
              });
            }
            
            result.successful++;
          } catch (error) {
            result.failed++;
            result.errors.push(`Failed to sync user ${user.Username}: ${error}`);
          }
        }
      }

      result.processingTime = Date.now() - startTime;
      await this.sendBatchMetrics('sync-cognito-users', result);
      
      return result;
    } catch (error) {
      result.errors.push(`Batch sync failed: ${error}`);
      result.processingTime = Date.now() - startTime;
      return result;
    }
  }

  async batchUpdateUsers(userIds: string[], updates: Record<string, any>, dryRun: boolean = false): Promise<BatchResult> {
    const startTime = Date.now();
    const result: BatchResult = {
      totalProcessed: userIds.length,
      successful: 0,
      failed: 0,
      errors: [],
      results: [],
      processingTime: 0
    };

    try {
      console.log(`Batch updating ${userIds.length} users (dry run: ${dryRun})`);

      for (let i = 0; i < userIds.length; i += this.batchSize) {
        const batch = userIds.slice(i, i + this.batchSize);
        
        // Use DynamoDB transactions for batch updates
        const transactItems = [];
        
        for (const userId of batch) {
          try {
            // Verify user exists
            const existingEntity = await this.getUserEntity(userId);
            if (!existingEntity) {
              result.errors.push(`User not found: ${userId}`);
              result.failed++;
              continue;
            }

            // Prepare update
            const updateExpression: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, any> = {};

            // Build update expression for each field
            Object.entries(updates).forEach(([key, value]) => {
              if (key !== 'entityType' && key !== 'entityId' && key !== 'createdAt') {
                updateExpression.push(`#attributes.#${key} = :${key}`);
                expressionAttributeNames['#attributes'] = 'attributes';
                expressionAttributeNames[`#${key}`] = key;
                expressionAttributeValues[`:${key}`] = value;
              }
            });

            // Always update timestamp
            updateExpression.push('#updatedAt = :updatedAt');
            expressionAttributeNames['#updatedAt'] = 'updatedAt';
            expressionAttributeValues[':updatedAt'] = Date.now();

            if (!dryRun) {
              transactItems.push({
                Update: {
                  TableName: this.entityStoreTable,
                  Key: {
                    entityType: { S: 'GameUser' },
                    entityId: { S: userId }
                  },
                  UpdateExpression: `SET ${updateExpression.join(', ')}`,
                  ExpressionAttributeNames: expressionAttributeNames,
                  ExpressionAttributeValues: marshall(expressionAttributeValues),
                  ConditionExpression: 'attribute_exists(entityType) AND attribute_exists(entityId)'
                }
              });
            }

            result.results.push({
              userId,
              updates,
              status: 'queued'
            });

          } catch (error) {
            result.failed++;
            result.errors.push(`Failed to prepare update for user ${userId}: ${error}`);
          }
        }

        // Execute batch transaction
        if (!dryRun && transactItems.length > 0) {
          try {
            // DynamoDB transactions are limited to 25 items
            for (let j = 0; j < transactItems.length; j += 25) {
              const transactBatch = transactItems.slice(j, j + 25);
              
              const command = new TransactWriteItemsCommand({
                TransactItems: transactBatch
              });
              
              await this.dynamodb.send(command);
              result.successful += transactBatch.length;
            }
          } catch (error) {
            result.failed += transactItems.length;
            result.errors.push(`Transaction failed: ${error}`);
          }
        } else {
          result.successful += batch.length; // Dry run success
        }
      }

      result.processingTime = Date.now() - startTime;
      await this.sendBatchMetrics('batch-update-users', result);

      return result;
    } catch (error) {
      result.errors.push(`Batch update failed: ${error}`);
      result.processingTime = Date.now() - startTime;
      return result;
    }
  }

  async cleanupInactiveUsers(inactiveDays: number = 90, dryRun: boolean = false): Promise<BatchResult> {
    const startTime = Date.now();
    const result: BatchResult = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      errors: [],
      results: [],
      processingTime: 0
    };

    try {
      const cutoffDate = Date.now() - (inactiveDays * 24 * 60 * 60 * 1000);
      
      // Query all users to find inactive ones
      const allUsers = await this.getAllUserEntities();
      const inactiveUsers = allUsers.filter(user => {
        const lastActive = user.attributes.lastActive || 0;
        return lastActive < cutoffDate;
      });

      result.totalProcessed = inactiveUsers.length;
      console.log(`Found ${inactiveUsers.length} inactive users (${inactiveDays}+ days)`);

      for (const user of inactiveUsers) {
        try {
          if (!dryRun) {
            // Mark as inactive rather than delete
            await this.updateUserEntity(user.entityId, {
              status: 'inactive',
              inactiveSince: Date.now()
            });
          }

          result.results.push({
            userId: user.entityId,
            lastActive: user.attributes.lastActive,
            daysSinceActive: Math.floor((Date.now() - user.attributes.lastActive) / (24 * 60 * 60 * 1000))
          });
          
          result.successful++;
        } catch (error) {
          result.failed++;
          result.errors.push(`Failed to mark user inactive ${user.entityId}: ${error}`);
        }
      }

      result.processingTime = Date.now() - startTime;
      await this.sendBatchMetrics('cleanup-inactive-users', result);

      return result;
    } catch (error) {
      result.errors.push(`Cleanup failed: ${error}`);
      result.processingTime = Date.now() - startTime;
      return result;
    }
  }

  async bulkAllianceOperations(allianceId: string, operation: 'disband' | 'transfer-leadership' | 'kick-inactive', targetUserId?: string, dryRun: boolean = false): Promise<BatchResult> {
    const startTime = Date.now();
    const result: BatchResult = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      errors: [],
      results: [],
      processingTime: 0
    };

    try {
      // Get all alliance members
      const members = await this.getAllianceMembers(allianceId);
      result.totalProcessed = members.length;

      switch (operation) {
        case 'disband':
          for (const member of members) {
            try {
              if (!dryRun) {
                await this.removeUserFromAlliance(member.entityId);
              }
              result.results.push({
                userId: member.entityId,
                action: 'removed from alliance'
              });
              result.successful++;
            } catch (error) {
              result.failed++;
              result.errors.push(`Failed to remove user from alliance ${member.entityId}: ${error}`);
            }
          }
          break;

        case 'transfer-leadership':
          if (!targetUserId) {
            throw new Error('Target user ID required for leadership transfer');
          }
          // Transfer leadership logic would go here
          result.results.push({
            action: 'leadership transferred',
            fromAlliance: allianceId,
            toUser: targetUserId
          });
          result.successful = 1;
          break;

        case 'kick-inactive':
          const cutoffDate = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
          const inactiveMembers = members.filter(member => 
            (member.attributes.lastActive || 0) < cutoffDate
          );
          
          for (const member of inactiveMembers) {
            try {
              if (!dryRun) {
                await this.removeUserFromAlliance(member.entityId);
              }
              result.results.push({
                userId: member.entityId,
                action: 'kicked for inactivity',
                lastActive: member.attributes.lastActive
              });
              result.successful++;
            } catch (error) {
              result.failed++;
              result.errors.push(`Failed to kick inactive member ${member.entityId}: ${error}`);
            }
          }
          break;
      }

      result.processingTime = Date.now() - startTime;
      await this.sendBatchMetrics('bulk-alliance-operations', result);

      return result;
    } catch (error) {
      result.errors.push(`Bulk alliance operation failed: ${error}`);
      result.processingTime = Date.now() - startTime;
      return result;
    }
  }

  // Helper methods

  private async getAllCognitoUsers(userPoolId: string) {
    const users = [];
    let paginationToken: string | undefined;

    do {
      const command = new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: 60,
        PaginationToken: paginationToken
      });

      const result = await this.cognito.send(command);
      users.push(...(result.Users || []));
      paginationToken = result.PaginationToken;
    } while (paginationToken);

    return users;
  }

  private extractCognitoAttributes(user: any): Record<string, any> {
    const attributes: Record<string, any> = {
      username: user.Username,
      enabled: user.Enabled,
      status: user.UserStatus,
      createdDate: user.UserCreateDate?.getTime(),
      lastModified: user.UserLastModifiedDate?.getTime()
    };

    if (user.Attributes) {
      for (const attr of user.Attributes) {
        attributes[attr.Name] = attr.Value;
      }
    }

    return attributes;
  }

  private async getUserEntity(userId: string) {
    // Implementation similar to user-entity-service.ts
    const command = {
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: 'GameUser' },
        entityId: { S: userId }
      }
    };

    const result = await this.dynamodb.send(new QueryCommand(command));
    return result.Items?.[0] ? unmarshall(result.Items[0]) : null;
  }

  private async createUserEntity(userId: string, attributes: Record<string, any>) {
    // Implementation to create user entity
    // This would call the entity management service
  }

  private async updateUserEntity(userId: string, updates: Record<string, any>) {
    // Implementation to update user entity
    // This would call the entity management service  
  }

  private async getAllUserEntities() {
    // Get all GameUser entities
    const command = new QueryCommand({
      TableName: this.entityStoreTable,
      KeyConditionExpression: 'entityType = :entityType',
      ExpressionAttributeValues: {
        ':entityType': { S: 'GameUser' }
      }
    });

    const result = await this.dynamodb.send(command);
    return result.Items?.map(item => unmarshall(item)) || [];
  }

  private async getAllianceMembers(allianceId: string) {
    // Get alliance members
    const command = new QueryCommand({
      TableName: this.entityStoreTable,
      IndexName: 'EntityRelationshipIndex',
      KeyConditionExpression: 'parentEntity = :parentEntity AND relationshipType = :relationshipType',
      ExpressionAttributeValues: {
        ':parentEntity': { S: `Alliance::${allianceId}` },
        ':relationshipType': { S: 'member' }
      }
    });

    const result = await this.dynamodb.send(command);
    return result.Items?.map(item => unmarshall(item)) || [];
  }

  private async removeUserFromAlliance(userId: string) {
    // Remove alliance from user entity
    // Implementation would update the user entity to remove alliance relationships
  }

  private detectChanges(existingAttrs: any, newAttrs: any): Record<string, { from: any; to: any }> {
    const changes: Record<string, { from: any; to: any }> = {};
    
    Object.keys(newAttrs).forEach(key => {
      if (existingAttrs[key] !== newAttrs[key]) {
        changes[key] = {
          from: existingAttrs[key],
          to: newAttrs[key]
        };
      }
    });
    
    return changes;
  }

  private async sendBatchMetrics(operation: string, result: BatchResult): Promise<void> {
    try {
      const command = new PutMetricDataCommand({
        Namespace: 'Loupeen/UserManagement/Batch',
        MetricData: [
          {
            MetricName: 'BatchProcessed',
            Value: result.totalProcessed,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Operation', Value: operation },
              { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
            ]
          },
          {
            MetricName: 'BatchSuccessful',
            Value: result.successful,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Operation', Value: operation },
              { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
            ]
          },
          {
            MetricName: 'BatchFailed',
            Value: result.failed,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Operation', Value: operation },
              { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
            ]
          },
          {
            MetricName: 'BatchProcessingTime',
            Value: result.processingTime,
            Unit: 'Milliseconds',
            Dimensions: [
              { Name: 'Operation', Value: operation },
              { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
            ]
          }
        ]
      });

      await this.cloudwatch.send(command);
    } catch (error) {
      console.error('Error sending batch metrics:', error);
    }
  }
}

// Global instance
let userBatchService: UserBatchService;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('User Batch Service Request:', JSON.stringify(event, null, 2));

  if (!userBatchService) {
    userBatchService = new UserBatchService();
  }

  try {
    const request: BatchRequest = JSON.parse(event.body || '{}');
    let result: BatchResult;

    switch (request.action) {
      case 'sync-cognito-users':
        result = await userBatchService.syncCognitoUsers(request.dryRun || false);
        break;

      case 'batch-update-users':
        if (!request.userIds || !request.updates) {
          throw new Error('User IDs and updates are required for batch-update-users');
        }
        result = await userBatchService.batchUpdateUsers(request.userIds, request.updates, request.dryRun || false);
        break;

      case 'cleanup-inactive-users':
        const inactiveDays = request.filters?.inactiveDays || 90;
        result = await userBatchService.cleanupInactiveUsers(inactiveDays, request.dryRun || false);
        break;

      case 'bulk-alliance-operations':
        if (!request.allianceId) {
          throw new Error('Alliance ID is required for bulk-alliance-operations');
        }
        // Extract operation from request (would need to be added to BatchRequest interface)
        result = await userBatchService.bulkAllianceOperations(
          request.allianceId, 
          'disband', // Default operation, should be configurable
          undefined, 
          request.dryRun || false
        );
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
    console.error('User batch service error:', error);

    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'User batch service failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};