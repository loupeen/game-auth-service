import { PreTokenGenerationTriggerEvent, Context, Callback } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

/**
 * Cognito Pre-Token Generation Trigger
 * 
 * Enriches JWT tokens with Cedar entity information and game-specific claims.
 * This allows game clients to have authorization context without additional API calls.
 */

interface TokenEnrichmentData {
  cedarEntityId: string;
  groups: string[];
  roles: string[];
  permissions: string[];
  gameData: {
    level: number;
    experience: number;
    allianceId?: string;
    allianceRole?: string;
    isPremium: boolean;
  };
}

class CognitoTokenEnrichment {
  private dynamodb: DynamoDBClient;
  private entityStoreTable: string;
  private environment: string;

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    this.environment = process.env.ENVIRONMENT!;
  }

  async handlePreTokenGeneration(event: PreTokenGenerationTriggerEvent): Promise<PreTokenGenerationTriggerEvent> {
    console.log('Pre-token generation trigger fired', {
      userPoolId: event.userPoolId,
      userId: event.request.userAttributes.sub,
      trigger: event.triggerSource
    });

    try {
      const userId = event.request.userAttributes.sub;
      
      // Fetch Cedar entity data
      const entityData = await this.getCedarEntityData(userId);
      
      if (entityData) {
        // Add custom claims to ID token
        event.response.claimsOverrideDetails = {
          claimsToAddOrOverride: {
            // Cedar entity information
            'custom:cedarEntityId': entityData.cedarEntityId,
            'custom:groups': JSON.stringify(entityData.groups),
            'custom:roles': JSON.stringify(entityData.roles),
            'custom:permissions': JSON.stringify(entityData.permissions),
            
            // Game-specific data
            'custom:level': String(entityData.gameData.level),
            'custom:experience': String(entityData.gameData.experience),
            'custom:allianceId': entityData.gameData.allianceId || '',
            'custom:allianceRole': entityData.gameData.allianceRole || '',
            'custom:isPremium': String(entityData.gameData.isPremium),
            
            // Additional context
            'custom:environment': this.environment,
            'custom:enrichmentVersion': '1.0.0',
            'custom:enrichedAt': new Date().toISOString()
          },
          
          // Group overrides for authorization
          groupOverrideDetails: {
            groupsToOverride: entityData.groups,
            iamRolesToOverride: [],
            preferredRole: entityData.roles[0]
          }
        };

        console.log('Successfully enriched token with Cedar entity data', {
          userId,
          groups: entityData.groups.length,
          roles: entityData.roles.length,
          permissions: entityData.permissions.length
        });
      } else {
        console.warn('No Cedar entity found for user, using default claims', { userId });
        
        // Add minimal default claims
        event.response.claimsOverrideDetails = {
          claimsToAddOrOverride: {
            'custom:cedarEntityId': userId,
            'custom:groups': JSON.stringify(['Players']),
            'custom:roles': JSON.stringify(['Player']),
            'custom:permissions': JSON.stringify(['login', 'viewProfile']),
            'custom:level': '1',
            'custom:experience': '0',
            'custom:isPremium': 'false',
            'custom:environment': this.environment,
            'custom:enrichmentVersion': '1.0.0',
            'custom:enrichedAt': new Date().toISOString()
          }
        };
      }

      return event;
    } catch (error) {
      console.error('Error in pre-token generation trigger:', error);
      // Return event unchanged on error to not block token generation
      return event;
    }
  }

  private async getCedarEntityData(userId: string): Promise<TokenEnrichmentData | null> {
    try {
      const getCommand = new GetItemCommand({
        TableName: this.entityStoreTable,
        Key: marshall({
          entityType: 'GameUser',
          entityId: userId
        })
      });

      const result = await this.dynamodb.send(getCommand);
      
      if (!result.Item) {
        return null;
      }

      const entity = unmarshall(result.Item);
      
      // Extract relevant data for token enrichment
      const enrichmentData: TokenEnrichmentData = {
        cedarEntityId: entity.entityId,
        groups: entity.relationships?.groups || ['Players'],
        roles: entity.relationships?.roles || ['Player'],
        permissions: entity.relationships?.permissions || ['login', 'viewProfile'],
        gameData: {
          level: entity.attributes?.level || 1,
          experience: entity.attributes?.experience || 0,
          allianceId: entity.attributes?.allianceId,
          allianceRole: entity.attributes?.allianceRole,
          isPremium: entity.attributes?.isPremium || false
        }
      };

      // Apply dynamic permissions based on current state
      enrichmentData.permissions = this.calculateDynamicPermissions(entity);

      return enrichmentData;
    } catch (error) {
      console.error('Error fetching Cedar entity data:', error);
      return null;
    }
  }

  private calculateDynamicPermissions(entity: any): string[] {
    const permissions: string[] = [];
    const level = entity.attributes?.level || 1;
    const userType = entity.attributes?.userType || 'player';
    const allianceRole = entity.attributes?.allianceRole;
    const isPremium = entity.attributes?.isPremium || false;

    // Base permissions
    permissions.push('login', 'viewProfile', 'updateProfile', 'viewLeaderboard');

    // Level-based permissions
    if (level >= 1) {
      permissions.push('collectResources', 'upgradeBuildings');
    }
    if (level >= 5) {
      permissions.push('joinAlliance', 'participateInChat', 'tradingPost');
    }
    if (level >= 10) {
      permissions.push('attackBase', 'defendBase', 'sendResources', 'scoutEnemy');
    }
    if (level >= 15) {
      permissions.push('useAdvancedUnits', 'participateInEvents');
    }
    if (level >= 25) {
      permissions.push('createAlliance', 'participateInTournament', 'useEliteUnits');
    }
    if (level >= 50) {
      permissions.push('accessEndgameContent', 'legendaryActions');
    }

    // Alliance-based permissions
    if (allianceRole === 'leader') {
      permissions.push(
        'inviteMember', 'kickMember', 'promoteMember', 'demoteMember',
        'declareWar', 'manageAllianceSettings', 'distributeRewards',
        'setAllianceObjectives', 'manageAllianceBank'
      );
    } else if (allianceRole === 'co-leader') {
      permissions.push(
        'inviteMember', 'kickMember', 'promoteMember',
        'declareWar', 'distributeRewards', 'setAllianceObjectives'
      );
    } else if (allianceRole === 'officer') {
      permissions.push('inviteMember', 'manageAllianceChat', 'organizeRaids');
    } else if (allianceRole === 'member') {
      permissions.push('contributeToAlliance', 'participateInWar');
    }

    // Premium permissions
    if (isPremium) {
      permissions.push(
        'premiumQueue', 'extraBuilders', 'instantComplete',
        'exclusiveUnits', 'premiumEvents', 'advancedStatistics'
      );
    }

    // Admin permissions
    if (userType === 'admin') {
      permissions.push(
        'banUser', 'unbanUser', 'resetGameState', 'viewSystemLogs',
        'manageAlliances', 'adjustPlayerStats', 'sendGlobalNotification',
        'manageEvents', 'viewAnalytics', 'accessAdminPanel',
        'modifyGameSettings', 'viewPlayerReports'
      );
    }

    // Time-based permissions (events, special access)
    const now = new Date();
    const hour = now.getUTCHours();
    
    // Tournament hours (18:00 - 22:00 UTC)
    if (hour >= 18 && hour <= 22 && level >= 10) {
      permissions.push('tournamentAccess', 'tournamentBetting');
    }
    
    // Alliance war time (weekends)
    const dayOfWeek = now.getUTCDay();
    if ((dayOfWeek === 0 || dayOfWeek === 6) && entity.attributes?.allianceId) {
      permissions.push('allianceWarActions', 'warRallyPoint');
    }

    return [...new Set(permissions)]; // Remove duplicates
  }
}

// Lambda handler
const enrichmentService = new CognitoTokenEnrichment();

export const handler = async (
  event: PreTokenGenerationTriggerEvent,
  _context: Context,
  _callback: Callback
): Promise<PreTokenGenerationTriggerEvent> => {
  console.log('Cognito Pre-Token Generation Trigger:', JSON.stringify(event, null, 2));
  
  try {
    const result = await enrichmentService.handlePreTokenGeneration(event);
    return result;
  } catch (error) {
    console.error('Error in pre-token generation trigger:', error);
    // Return the event unchanged to not block token generation
    return event;
  }
};