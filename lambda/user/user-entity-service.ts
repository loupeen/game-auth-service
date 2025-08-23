import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';

interface UserProfileRequest {
  action: 'get' | 'update' | 'list-alliance-members' | 'get-player-stats' | 'update-game-settings' | 'join-alliance' | 'leave-alliance';
  userId?: string;
  allianceId?: string;
  gameSettings?: Record<string, any>;
  playerStats?: Record<string, any>;
  profileUpdates?: Record<string, any>;
}

interface UserProfile {
  userId: string;
  username: string;
  email: string;
  playerId: string;
  allianceId?: string;
  level: number;
  experience: number;
  resources: {
    food: number;
    wood: number;
    stone: number;
    iron: number;
    gold: number;
  };
  buildings: Record<string, number>;
  troops: Record<string, number>;
  gameSettings: {
    notifications: boolean;
    soundEnabled: boolean;
    language: string;
    timezone: string;
  };
  lastActive: number;
  joinedDate: number;
  roles: string[];
  status: 'active' | 'inactive' | 'banned';
}

interface AllianceMember {
  userId: string;
  username: string;
  level: number;
  role: 'member' | 'officer' | 'leader';
  contribution: number;
  joinedDate: number;
  lastActive: number;
}

class UserEntityService {
  private dynamodb: DynamoDBClient;
  private cognito: CognitoIdentityProviderClient;
  private entityStoreTable: string;
  private playerUserPoolId: string;
  private adminUserPoolId: string;

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    this.playerUserPoolId = process.env.PLAYER_USER_POOL_ID!;
    this.adminUserPoolId = process.env.ADMIN_USER_POOL_ID!;
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    try {
      // Get user entity from Cedar store
      const entityCommand = new GetItemCommand({
        TableName: this.entityStoreTable,
        Key: {
          entityType: { S: 'GameUser' },
          entityId: { S: userId }
        }
      });

      const entityResult = await this.dynamodb.send(entityCommand);
      
      if (!entityResult.Item) {
        return null;
      }

      const entity = unmarshall(entityResult.Item);
      
      // Get additional user details from Cognito
      let cognitoUser;
      try {
        const cognitoCommand = new AdminGetUserCommand({
          UserPoolId: this.playerUserPoolId,
          Username: userId
        });
        cognitoUser = await this.cognito.send(cognitoCommand);
      } catch (error) {
        // Try admin pool if not found in player pool
        try {
          const cognitoCommand = new AdminGetUserCommand({
            UserPoolId: this.adminUserPoolId,
            Username: userId
          });
          cognitoUser = await this.cognito.send(cognitoCommand);
        } catch (adminError) {
          console.warn('User not found in either Cognito pool:', userId);
        }
      }

      // Merge entity data with Cognito attributes
      const profile: UserProfile = {
        userId,
        username: entity.attributes.username || cognitoUser?.Username || userId,
        email: entity.attributes.email || this.getCognitoAttribute(cognitoUser, 'email') || '',
        playerId: entity.attributes.playerId || userId,
        allianceId: entity.attributes.allianceId,
        level: entity.attributes.level || 1,
        experience: entity.attributes.experience || 0,
        resources: entity.attributes.resources || {
          food: 1000,
          wood: 1000,
          stone: 1000,
          iron: 500,
          gold: 100
        },
        buildings: entity.attributes.buildings || {},
        troops: entity.attributes.troops || {},
        gameSettings: entity.attributes.gameSettings || {
          notifications: true,
          soundEnabled: true,
          language: 'en',
          timezone: 'UTC'
        },
        lastActive: entity.attributes.lastActive || Date.now(),
        joinedDate: entity.createdAt || Date.now(),
        roles: entity.relationships.roles || ['player'],
        status: entity.attributes.status || 'active'
      };

      return profile;
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error getting user profile:', error);
      }
      return null;
    }
  }

  async updateUserProfile(userId: string, updates: Partial<UserProfile>): Promise<UserProfile | null> {
    try {
      // Prepare update expression
      const updateExpression: string[] = [];
      const expressionAttributeNames: Record<string, string> = {};
      const expressionAttributeValues: Record<string, any> = {};

      // Build updates for attributes
      if (updates.gameSettings) {
        updateExpression.push('#attributes.#gameSettings = :gameSettings');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#gameSettings'] = 'gameSettings';
        expressionAttributeValues[':gameSettings'] = updates.gameSettings;
      }

      if (updates.resources) {
        updateExpression.push('#attributes.#resources = :resources');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#resources'] = 'resources';
        expressionAttributeValues[':resources'] = updates.resources;
      }

      if (updates.level !== undefined) {
        updateExpression.push('#attributes.#level = :level');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#level'] = 'level';
        expressionAttributeValues[':level'] = updates.level;
      }

      if (updates.experience !== undefined) {
        updateExpression.push('#attributes.#experience = :experience');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#experience'] = 'experience';
        expressionAttributeValues[':experience'] = updates.experience;
      }

      if (updates.buildings) {
        updateExpression.push('#attributes.#buildings = :buildings');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#buildings'] = 'buildings';
        expressionAttributeValues[':buildings'] = updates.buildings;
      }

      if (updates.troops) {
        updateExpression.push('#attributes.#troops = :troops');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#troops'] = 'troops';
        expressionAttributeValues[':troops'] = updates.troops;
      }

      if (updates.status) {
        updateExpression.push('#attributes.#status = :status');
        expressionAttributeNames['#attributes'] = 'attributes';
        expressionAttributeNames['#status'] = 'status';
        expressionAttributeValues[':status'] = updates.status;
      }

      // Always update lastActive and updatedAt
      updateExpression.push('#attributes.#lastActive = :lastActive', '#updatedAt = :updatedAt');
      expressionAttributeNames['#attributes'] = 'attributes';
      expressionAttributeNames['#lastActive'] = 'lastActive';
      expressionAttributeNames['#updatedAt'] = 'updatedAt';
      expressionAttributeValues[':lastActive'] = Date.now();
      expressionAttributeValues[':updatedAt'] = Date.now();

      if (updateExpression.length === 0) {
        throw new Error('No valid updates provided');
      }

      const command = new UpdateItemCommand({
        TableName: this.entityStoreTable,
        Key: {
          entityType: { S: 'GameUser' },
          entityId: { S: userId }
        },
        UpdateExpression: `SET ${updateExpression.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
        ConditionExpression: 'attribute_exists(entityType) AND attribute_exists(entityId)',
        ReturnValues: 'ALL_NEW'
      });

      const result = await this.dynamodb.send(command);
      
      if (!result.Attributes) {
        return null;
      }

      // Return updated profile
      return await this.getUserProfile(userId);
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error updating user profile:', error);
      }
      return null;
    }
  }

  async getAllianceMembers(allianceId: string): Promise<AllianceMember[]> {
    try {
      // Query all users who are members of this alliance
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
      
      if (!result.Items) {
        return [];
      }

      const members: AllianceMember[] = [];
      
      for (const item of result.Items) {
        const entity = unmarshall(item);
        const profile = await this.getUserProfile(entity.entityId);
        
        if (profile) {
          members.push({
            userId: profile.userId,
            username: profile.username,
            level: profile.level,
            role: entity.relationships.allianceRole || 'member',
            contribution: entity.attributes.allianceContribution || 0,
            joinedDate: entity.attributes.allianceJoinedDate || Date.now(),
            lastActive: profile.lastActive
          });
        }
      }

      return members.sort((a, b) => {
        // Sort by role (leader first, then officers, then members) and then by contribution
        const roleOrder = { leader: 3, officer: 2, member: 1 };
        if (roleOrder[a.role] !== roleOrder[b.role]) {
          return roleOrder[b.role] - roleOrder[a.role];
        }
        return b.contribution - a.contribution;
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error getting alliance members:', error);
      }
      return [];
    }
  }

  async joinAlliance(userId: string, allianceId: string): Promise<boolean> {
    try {
      // Update user entity to include alliance relationship
      const updateCommand = new UpdateItemCommand({
        TableName: this.entityStoreTable,
        Key: {
          entityType: { S: 'GameUser' },
          entityId: { S: userId }
        },
        UpdateExpression: 'SET #attributes.#allianceId = :allianceId, #relationships.#alliance = :alliance, #attributes.#allianceJoinedDate = :joinedDate, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#attributes': 'attributes',
          '#allianceId': 'allianceId',
          '#relationships': 'relationships',
          '#alliance': 'alliance',
          '#allianceJoinedDate': 'allianceJoinedDate',
          '#updatedAt': 'updatedAt'
        },
        ConditionExpression: 'attribute_exists(entityType) AND attribute_exists(entityId) AND (attribute_not_exists(#attributes.#allianceId) OR #attributes.#allianceId = :empty)',
        ExpressionAttributeValues: marshall({
          ':allianceId': allianceId,
          ':alliance': `Alliance::${allianceId}`,
          ':joinedDate': Date.now(),
          ':updatedAt': Date.now(),
          ':empty': ''
        })
      });

      await this.dynamodb.send(updateCommand);
      return true;
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error joining alliance:', error);
      }
      return false;
    }
  }

  async leaveAlliance(userId: string): Promise<boolean> {
    try {
      // Remove alliance from user entity
      const updateCommand = new UpdateItemCommand({
        TableName: this.entityStoreTable,
        Key: {
          entityType: { S: 'GameUser' },
          entityId: { S: userId }
        },
        UpdateExpression: 'REMOVE #attributes.#allianceId, #relationships.#alliance, #attributes.#allianceJoinedDate, #attributes.#allianceContribution SET #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#attributes': 'attributes',
          '#allianceId': 'allianceId',
          '#relationships': 'relationships',
          '#alliance': 'alliance',
          '#allianceJoinedDate': 'allianceJoinedDate',
          '#allianceContribution': 'allianceContribution',
          '#updatedAt': 'updatedAt'
        },
        ExpressionAttributeValues: marshall({
          ':updatedAt': Date.now()
        }),
        ConditionExpression: 'attribute_exists(entityType) AND attribute_exists(entityId)'
      });

      await this.dynamodb.send(updateCommand);
      return true;
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Error leaving alliance:', error);
      }
      return false;
    }
  }

  private getCognitoAttribute(cognitoUser: any, attributeName: string): string | undefined {
    if (!cognitoUser?.UserAttributes) return undefined;
    
    const attribute = cognitoUser.UserAttributes.find((attr: any) => attr.Name === attributeName);
    return attribute?.Value;
  }
}

// Global instance
let userEntityService: UserEntityService;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('User Entity Service Request:', JSON.stringify(event, null, 2));

  if (!userEntityService) {
    userEntityService = new UserEntityService();
  }

  try {
    const request: UserProfileRequest = JSON.parse(event.body || '{}');
    let result: any;

    switch (request.action) {
      case 'get':
        if (!request.userId) {
          throw new Error('User ID is required for get action');
        }
        result = await userEntityService.getUserProfile(request.userId);
        if (!result) {
          return {
            statusCode: 404,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'User profile not found' })
          };
        }
        break;

      case 'update':
        if (!request.userId || !request.profileUpdates) {
          throw new Error('User ID and profile updates are required for update action');
        }
        result = await userEntityService.updateUserProfile(request.userId, request.profileUpdates);
        if (!result) {
          return {
            statusCode: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Failed to update user profile' })
          };
        }
        break;

      case 'list-alliance-members':
        if (!request.allianceId) {
          throw new Error('Alliance ID is required for list-alliance-members action');
        }
        result = await userEntityService.getAllianceMembers(request.allianceId);
        break;

      case 'join-alliance':
        if (!request.userId || !request.allianceId) {
          throw new Error('User ID and Alliance ID are required for join-alliance action');
        }
        const joinSuccess = await userEntityService.joinAlliance(request.userId, request.allianceId);
        if (!joinSuccess) {
          return {
            statusCode: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Failed to join alliance - user may already be in an alliance' })
          };
        }
        result = { success: true, message: 'Successfully joined alliance' };
        break;

      case 'leave-alliance':
        if (!request.userId) {
          throw new Error('User ID is required for leave-alliance action');
        }
        const leaveSuccess = await userEntityService.leaveAlliance(request.userId);
        if (!leaveSuccess) {
          return {
            statusCode: 400,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Failed to leave alliance' })
          };
        }
        result = { success: true, message: 'Successfully left alliance' };
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
    if (process.env.NODE_ENV !== 'production') {
      console.error('User entity service error:', error);
    }

    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'User entity service failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};