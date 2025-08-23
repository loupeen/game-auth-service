import { PostAuthenticationTriggerEvent, Context, Callback } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

/**
 * Cognito Post-Authentication Trigger
 * 
 * Synchronizes Cognito user attributes with Cedar entities after successful authentication.
 * This ensures Cedar has up-to-date user information for authorization decisions.
 */

interface CedarUserEntity {
  entityType: string;
  entityId: string;
  attributes: {
    userId: string;
    username: string;
    email: string;
    userType: 'player' | 'admin';
    playerId?: string;
    allianceId?: string;
    allianceRole?: string;
    roleId?: string;
    deviceFingerprint?: string;
    level: number;
    experience: number;
    isActive: boolean;
    isPremium: boolean;
    lastLoginAt: string;
    createdAt: string;
    updatedAt: string;
  };
  relationships: {
    groups: string[];
    alliance?: string;
    roles: string[];
    permissions: string[];
  };
  metadata: {
    loginCount: number;
    lastIpAddress?: string;
    lastUserAgent?: string;
    lastLoginLocation?: string;
  };
}

class CognitoCedarEntitySync {
  private dynamodb: DynamoDBClient;
  private entityStoreTable: string;
  private environment: string;

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    this.environment = process.env.ENVIRONMENT!;
  }

  async handlePostAuthentication(event: PostAuthenticationTriggerEvent): Promise<PostAuthenticationTriggerEvent> {
    console.log('Post-authentication trigger fired', { 
      userPoolId: event.userPoolId,
      userId: event.request.userAttributes.sub,
      trigger: event.triggerSource 
    });

    try {
      // Extract user attributes from Cognito event
      const cognitoAttributes = event.request.userAttributes;
      const userId = cognitoAttributes.sub;
      const userPoolId = event.userPoolId;
      
      // Determine user type based on user pool
      const isAdminPool = userPoolId.includes('admins');
      const userType = isAdminPool ? 'admin' : 'player';

      // Get existing entity if it exists
      const existingEntity = await this.getExistingEntity(userId);
      
      // Merge attributes with existing data
      const cedarEntity = this.buildCedarEntity(
        userId,
        userType,
        cognitoAttributes,
        existingEntity,
        event
      );

      // Save or update entity in Cedar entity store
      await this.saveCedarEntity(cedarEntity);

      // Update user groups based on attributes
      await this.updateUserGroups(userId, cedarEntity);

      console.log('Successfully synchronized user entity to Cedar', { userId });

      return event;
    } catch (error) {
      console.error('Error in post-authentication trigger:', error);
      // Don't fail authentication even if sync fails
      return event;
    }
  }

  private async getExistingEntity(userId: string): Promise<CedarUserEntity | null> {
    try {
      const getCommand = new GetItemCommand({
        TableName: this.entityStoreTable,
        Key: marshall({
          entityType: 'GameUser',
          entityId: userId
        })
      });

      const result = await this.dynamodb.send(getCommand);
      if (result.Item) {
        return unmarshall(result.Item) as CedarUserEntity;
      }
      return null;
    } catch (error) {
      console.error('Error getting existing entity:', error);
      return null;
    }
  }

  private buildCedarEntity(
    userId: string,
    userType: 'player' | 'admin',
    cognitoAttributes: any,
    existingEntity: CedarUserEntity | null,
    event: PostAuthenticationTriggerEvent
  ): CedarUserEntity {
    const now = new Date().toISOString();
    
    // Extract custom attributes
    const playerId = cognitoAttributes['custom:playerId'];
    const allianceId = cognitoAttributes['custom:allianceId'];
    const allianceRole = cognitoAttributes['custom:allianceRole'];
    const roleId = cognitoAttributes['custom:roleId'];
    const deviceFingerprint = cognitoAttributes['custom:deviceFingerprint'];

    // Get or initialize game attributes
    const level = existingEntity?.attributes.level || 1;
    const experience = existingEntity?.attributes.experience || 0;
    const loginCount = (existingEntity?.metadata.loginCount || 0) + 1;

    // Determine user groups and roles
    const groups = this.determineUserGroups(userType, level, allianceId, allianceRole);
    const roles = this.determineUserRoles(userType, allianceRole, roleId);
    const permissions = this.determineUserPermissions(userType, level, roles);

    // Build the Cedar entity
    const entity: CedarUserEntity = {
      entityType: 'GameUser',
      entityId: userId,
      attributes: {
        userId,
        username: cognitoAttributes.preferred_username || cognitoAttributes.email,
        email: cognitoAttributes.email,
        userType,
        playerId,
        allianceId,
        allianceRole,
        roleId,
        deviceFingerprint,
        level,
        experience,
        isActive: true,
        isPremium: existingEntity?.attributes.isPremium || false,
        lastLoginAt: now,
        createdAt: existingEntity?.attributes.createdAt || now,
        updatedAt: now
      },
      relationships: {
        groups,
        alliance: allianceId,
        roles,
        permissions
      },
      metadata: {
        loginCount,
        lastIpAddress: event.request.clientMetadata?.ipAddress,
        lastUserAgent: event.request.clientMetadata?.userAgent,
        lastLoginLocation: event.request.clientMetadata?.location
      }
    };

    return entity;
  }

  private determineUserGroups(
    userType: string,
    level: number,
    allianceId?: string,
    allianceRole?: string
  ): string[] {
    const groups: string[] = [];

    // Base group
    if (userType === 'admin') {
      groups.push('Administrators');
    } else {
      groups.push('Players');
    }

    // Level-based groups
    if (level >= 10) {
      groups.push('ExperiencedPlayers');
    }
    if (level >= 25) {
      groups.push('VeteranPlayers');
    }
    if (level >= 50) {
      groups.push('ElitePlayers');
    }

    // Alliance groups
    if (allianceId) {
      groups.push('AllianceMembers');
      groups.push(`Alliance::${allianceId}`);
      
      if (allianceRole === 'leader' || allianceRole === 'co-leader') {
        groups.push('AllianceLeaders');
      }
      if (allianceRole === 'officer') {
        groups.push('AllianceOfficers');
      }
    }

    return groups;
  }

  private determineUserRoles(
    userType: string,
    allianceRole?: string,
    roleId?: string
  ): string[] {
    const roles: string[] = [];

    // Base role
    if (userType === 'admin') {
      roles.push('Administrator');
      roles.push('Moderator');
    } else {
      roles.push('Player');
    }

    // Alliance roles
    if (allianceRole) {
      const formattedRole = allianceRole.charAt(0).toUpperCase() + allianceRole.slice(1);
      roles.push(`Alliance${formattedRole}`);
    }

    // Custom role ID
    if (roleId) {
      roles.push(roleId);
    }

    return roles;
  }

  private determineUserPermissions(
    userType: string,
    level: number,
    roles: string[]
  ): string[] {
    const permissions: string[] = [];

    // Base permissions for all users
    permissions.push('login', 'viewProfile', 'updateProfile', 'viewLeaderboard');

    // Player permissions
    if (userType === 'player') {
      permissions.push('collectResources', 'upgradeBuildings', 'trainTroops');
      
      if (level >= 5) {
        permissions.push('joinAlliance', 'participateInChat');
      }
      if (level >= 10) {
        permissions.push('attackBase', 'defendBase', 'sendResources');
      }
      if (level >= 25) {
        permissions.push('createAlliance', 'participateInTournament');
      }
    }

    // Alliance leader permissions
    if (roles.includes('AllianceLeader') || roles.includes('AllianceCo-leader')) {
      permissions.push(
        'inviteMember',
        'kickMember',
        'promoteMember',
        'demoteMember',
        'declareWar',
        'manageAllianceSettings',
        'distributeRewards'
      );
    }

    // Alliance officer permissions
    if (roles.includes('AllianceOfficer')) {
      permissions.push('inviteMember', 'manageAllianceChat', 'organizeRaids');
    }

    // Admin permissions
    if (userType === 'admin') {
      permissions.push(
        'banUser',
        'unbanUser',
        'resetGameState',
        'viewSystemLogs',
        'manageAlliances',
        'adjustPlayerStats',
        'sendGlobalNotification',
        'manageEvents',
        'viewAnalytics'
      );
    }

    return [...new Set(permissions)]; // Remove duplicates
  }

  private async saveCedarEntity(entity: CedarUserEntity): Promise<void> {
    // Add TTL for entity expiration (optional)
    const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days

    const item = {
      ...entity,
      ttl
    };

    const putCommand = new PutItemCommand({
      TableName: this.entityStoreTable,
      Item: marshall(item, { removeUndefinedValues: true })
    });

    await this.dynamodb.send(putCommand);
  }

  private async updateUserGroups(userId: string, entity: CedarUserEntity): Promise<void> {
    // Create group membership entities for Cedar
    for (const group of entity.relationships.groups) {
      const groupMembership = {
        entityType: 'GroupMembership',
        entityId: `${userId}::${group}`,
        userId,
        groupId: group,
        memberSince: entity.attributes.createdAt,
        isActive: true
      };

      const putCommand = new PutItemCommand({
        TableName: this.entityStoreTable,
        Item: marshall(groupMembership, { removeUndefinedValues: true })
      });

      await this.dynamodb.send(putCommand);
    }
  }
}

// Lambda handler
const syncService = new CognitoCedarEntitySync();

export const handler = async (
  event: PostAuthenticationTriggerEvent,
  context: Context,
  callback: Callback
): Promise<PostAuthenticationTriggerEvent> => {
  console.log('Cognito Post-Authentication Trigger:', JSON.stringify(event, null, 2));
  
  try {
    const result = await syncService.handlePostAuthentication(event);
    return result;
  } catch (error) {
    console.error('Error in post-authentication trigger:', error);
    // Return the event unchanged to not block authentication
    return event;
  }
};