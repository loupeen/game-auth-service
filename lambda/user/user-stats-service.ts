import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

interface UserStatsRequest {
  action: 'get-user-stats' | 'get-leaderboard' | 'get-alliance-stats' | 'calculate-combat-power';
  userId?: string;
  allianceId?: string;
  leaderboardType?: 'level' | 'power' | 'alliance' | 'resources';
  limit?: number;
  period?: 'daily' | 'weekly' | 'monthly' | 'all-time';
}

interface UserStats {
  userId: string;
  username: string;
  level: number;
  experience: number;
  totalCombatPower: number;
  resources: {
    food: number;
    wood: number;
    stone: number;
    iron: number;
    gold: number;
    total: number;
  };
  buildings: {
    totalBuildings: number;
    maxBuildingLevel: number;
    buildingScore: number;
  };
  troops: {
    totalTroops: number;
    troopPower: number;
    armyComposition: Record<string, number>;
  };
  combat: {
    battlesWon: number;
    battlesLost: number;
    winRate: number;
    damageDealt: number;
    damageReceived: number;
  };
  alliance: {
    allianceId?: string;
    allianceName?: string;
    role: string;
    contribution: number;
    joinedDate?: number;
  };
  achievements: {
    totalAchievements: number;
    recentAchievements: string[];
  };
  ranking: {
    levelRank: number;
    powerRank: number;
    allianceRank?: number;
  };
  activity: {
    lastActive: number;
    loginStreak: number;
    totalPlayTime: number;
    sessionsThisWeek: number;
  };
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  value: number;
  allianceId?: string;
  allianceName?: string;
  change?: number; // Change from previous period
}

interface AllianceStats {
  allianceId: string;
  allianceName: string;
  memberCount: number;
  totalPower: number;
  averageLevel: number;
  totalResources: number;
  activeMembers: number; // Active in last 7 days
  leaderboard: {
    powerRank: number;
    memberRank: number;
  };
  members: {
    leaders: number;
    officers: number;
    members: number;
  };
}

class UserStatsService {
  private dynamodb: DynamoDBClient;
  private cloudwatch: CloudWatchClient;
  private entityStoreTable: string;

  // Combat power calculation constants
  private readonly TROOP_POWER = {
    infantry: 1,
    archer: 1.2,
    cavalry: 1.5,
    siege: 2,
    tank: 3,
    fighter: 2.5,
    bomber: 4
  };

  private readonly BUILDING_POWER = {
    headquarters: 10,
    barracks: 5,
    archery: 5,
    stable: 7,
    factory: 8,
    airfield: 10,
    wall: 3,
    warehouse: 2,
    farm: 1,
    mine: 2,
    research: 8
  };

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cloudwatch = new CloudWatchClient({ region: process.env.REGION });
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
  }

  async getUserStats(userId: string): Promise<UserStats | null> {
    try {
      // Get user entity
      const userEntity = await this.getUserEntity(userId);
      if (!userEntity) return null;

      const attrs = userEntity.attributes;
      const relationships = userEntity.relationships;

      // Calculate combat power
      const combatPower = this.calculateCombatPower(attrs.buildings || {}, attrs.troops || {});

      // Calculate resource totals
      const resources = attrs.resources || { food: 0, wood: 0, stone: 0, iron: 0, gold: 0 };
      const totalResources = Object.values(resources).reduce((sum: number, val: unknown) => sum + Number(val), 0);

      // Calculate building stats
      const buildings = attrs.buildings || {};
      const buildingStats = this.calculateBuildingStats(buildings);

      // Calculate troop stats  
      const troops = attrs.troops || {};
      const troopStats = this.calculateTroopStats(troops);

      // Get rankings (simplified - would need more complex queries for real rankings)
      const rankings = await this.getUserRankings(userId, combatPower, attrs.level || 1);

      const stats: UserStats = {
        userId,
        username: attrs.username || userId,
        level: attrs.level || 1,
        experience: attrs.experience || 0,
        totalCombatPower: combatPower,
        resources: {
          ...resources,
          total: totalResources
        },
        buildings: buildingStats,
        troops: troopStats,
        combat: {
          battlesWon: attrs.battlesWon || 0,
          battlesLost: attrs.battlesLost || 0,
          winRate: this.calculateWinRate(attrs.battlesWon || 0, attrs.battlesLost || 0),
          damageDealt: attrs.totalDamageDealt || 0,
          damageReceived: attrs.totalDamageReceived || 0
        },
        alliance: {
          allianceId: attrs.allianceId,
          allianceName: attrs.allianceName,
          role: relationships.allianceRole || 'none',
          contribution: attrs.allianceContribution || 0,
          joinedDate: attrs.allianceJoinedDate
        },
        achievements: {
          totalAchievements: (attrs.achievements || []).length,
          recentAchievements: (attrs.achievements || []).slice(-5)
        },
        ranking: rankings,
        activity: {
          lastActive: attrs.lastActive || Date.now(),
          loginStreak: attrs.loginStreak || 0,
          totalPlayTime: attrs.totalPlayTime || 0,
          sessionsThisWeek: attrs.sessionsThisWeek || 0
        }
      };

      // Send metrics to CloudWatch
      await this.sendUserMetrics(stats);

      return stats;
    } catch (error) {
      console.error('Error getting user stats:', error);
      return null;
    }
  }

  async getLeaderboard(type: string, limit: number = 50): Promise<LeaderboardEntry[]> {
    try {
      // For this implementation, we'll query users and sort
      // In production, you'd want separate leaderboard tables updated via DynamoDB Streams
      
      const command = new QueryCommand({
        TableName: this.entityStoreTable,
        KeyConditionExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': { S: 'GameUser' }
        },
        Limit: 1000 // Get more users to sort properly
      });

      const result = await this.dynamodb.send(command);
      if (!result.Items) return [];

      // Convert to user data and sort based on leaderboard type
      const users = result.Items.map(item => {
        const entity = unmarshall(item);
        const attrs = entity.attributes;
        const combatPower = this.calculateCombatPower(attrs.buildings || {}, attrs.troops || {});
        
        return {
          userId: entity.entityId,
          username: attrs.username || entity.entityId,
          level: attrs.level || 1,
          power: combatPower,
          allianceId: attrs.allianceId,
          allianceName: attrs.allianceName,
          resources: Object.values(attrs.resources || {}).reduce((sum: number, val: unknown) => sum + Number(val), 0)
        };
      });

      // Sort based on leaderboard type
      let sortedUsers;
      switch (type) {
        case 'level':
          sortedUsers = users.sort((a, b) => b.level - a.level);
          break;
        case 'power':
          sortedUsers = users.sort((a, b) => b.power - a.power);
          break;
        case 'resources':
          sortedUsers = users.sort((a, b) => Number(b.resources) - Number(a.resources));
          break;
        default:
          sortedUsers = users.sort((a, b) => b.power - a.power);
      }

      return sortedUsers.slice(0, limit).map((user, index) => ({
        rank: index + 1,
        userId: user.userId,
        username: user.username,
        value: type === 'level' ? user.level : type === 'resources' ? user.resources : user.power,
        allianceId: user.allianceId,
        allianceName: user.allianceName
      }));
    } catch (error) {
      console.error('Error getting leaderboard:', error);
      return [];
    }
  }

  async getAllianceStats(allianceId: string): Promise<AllianceStats | null> {
    try {
      // Query all alliance members
      const membersCommand = new QueryCommand({
        TableName: this.entityStoreTable,
        IndexName: 'EntityRelationshipIndex',
        KeyConditionExpression: 'parentEntity = :parentEntity AND relationshipType = :relationshipType',
        ExpressionAttributeValues: {
          ':parentEntity': { S: `Alliance::${allianceId}` },
          ':relationshipType': { S: 'member' }
        }
      });

      const membersResult = await this.dynamodb.send(membersCommand);
      if (!membersResult.Items) return null;

      const members = membersResult.Items.map(item => unmarshall(item));
      
      // Calculate alliance statistics
      let totalPower = 0;
      let totalLevel = 0;
      let totalResources = 0;
      let activeMembers = 0;
      const now = Date.now();
      const weekAgo = now - (7 * 24 * 60 * 60 * 1000);

      const roleCount = { leaders: 0, officers: 0, members: 0 };

      for (const member of members) {
        const attrs = member.attributes;
        const relationships = member.relationships;
        
        // Calculate power
        const power = this.calculateCombatPower(attrs.buildings || {}, attrs.troops || {});
        totalPower += power;
        
        totalLevel += attrs.level || 1;
        
        // Calculate resources
        const resources = attrs.resources || {};
        totalResources += Object.values(resources).reduce((sum: number, val: unknown) => sum + Number(val), 0);
        
        // Check if active
        if ((attrs.lastActive || 0) > weekAgo) {
          activeMembers++;
        }
        
        // Count roles
        const role = relationships.allianceRole || 'members';
        if (role === 'leader') roleCount.leaders++;
        else if (role === 'officer') roleCount.officers++;
        else roleCount.members++;
      }

      // Get alliance entity for name
      const allianceEntity = await this.getAllianceEntity(allianceId);
      const allianceName = allianceEntity?.attributes.name || `Alliance ${allianceId}`;

      const stats: AllianceStats = {
        allianceId,
        allianceName,
        memberCount: members.length,
        totalPower,
        averageLevel: totalLevel / members.length,
        totalResources,
        activeMembers,
        leaderboard: {
          powerRank: 0, // Would need cross-alliance query
          memberRank: 0  // Would need cross-alliance query
        },
        members: roleCount
      };

      return stats;
    } catch (error) {
      console.error('Error getting alliance stats:', error);
      return null;
    }
  }

  private calculateCombatPower(buildings: Record<string, number>, troops: Record<string, number>): number {
    let power = 0;
    
    // Calculate building power
    for (const [buildingType, level] of Object.entries(buildings)) {
      const basePower = this.BUILDING_POWER[buildingType as keyof typeof this.BUILDING_POWER] || 1;
      power += basePower * level;
    }
    
    // Calculate troop power
    for (const [troopType, count] of Object.entries(troops)) {
      const unitPower = this.TROOP_POWER[troopType as keyof typeof this.TROOP_POWER] || 1;
      power += unitPower * count;
    }
    
    return Math.floor(power);
  }

  private calculateBuildingStats(buildings: Record<string, number>) {
    const totalBuildings = Object.values(buildings).reduce((sum, level) => sum + (level > 0 ? 1 : 0), 0);
    const maxBuildingLevel = Math.max(...Object.values(buildings), 0);
    const buildingScore = Object.values(buildings).reduce((sum, level) => sum + level, 0);
    
    return { totalBuildings, maxBuildingLevel, buildingScore };
  }

  private calculateTroopStats(troops: Record<string, number>) {
    const totalTroops = Object.values(troops).reduce((sum, count) => sum + count, 0);
    const troopPower = this.calculateCombatPower({}, troops);
    
    return {
      totalTroops,
      troopPower,
      armyComposition: troops
    };
  }

  private calculateWinRate(won: number, lost: number): number {
    const total = won + lost;
    return total > 0 ? Math.round((won / total) * 100) : 0;
  }

  private async getUserRankings(userId: string, power: number, level: number) {
    // Simplified ranking calculation - in production would use dedicated ranking tables
    return {
      levelRank: Math.floor(Math.random() * 1000) + 1, // Placeholder
      powerRank: Math.floor(Math.random() * 1000) + 1, // Placeholder
      allianceRank: Math.floor(Math.random() * 50) + 1 // Placeholder
    };
  }

  private async getUserEntity(userId: string) {
    const command = new GetItemCommand({
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: 'GameUser' },
        entityId: { S: userId }
      }
    });

    const result = await this.dynamodb.send(command);
    return result.Item ? unmarshall(result.Item) : null;
  }

  private async getAllianceEntity(allianceId: string) {
    const command = new GetItemCommand({
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: 'Alliance' },
        entityId: { S: allianceId }
      }
    });

    const result = await this.dynamodb.send(command);
    return result.Item ? unmarshall(result.Item) : null;
  }

  private async sendUserMetrics(stats: UserStats): Promise<void> {
    try {
      const command = new PutMetricDataCommand({
        Namespace: 'Loupeen/UserManagement',
        MetricData: [
          {
            MetricName: 'UserLevel',
            Value: stats.level,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
            ]
          },
          {
            MetricName: 'UserCombatPower', 
            Value: stats.totalCombatPower,
            Unit: 'Count',
            Dimensions: [
              { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
            ]
          }
        ]
      });

      await this.cloudwatch.send(command);
    } catch (error) {
      console.error('Error sending user metrics:', error);
      // Don't throw - metrics are non-critical
    }
  }
}

// Global instance
let userStatsService: UserStatsService;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('User Stats Service Request:', JSON.stringify(event, null, 2));

  if (!userStatsService) {
    userStatsService = new UserStatsService();
  }

  try {
    const request: UserStatsRequest = JSON.parse(event.body || '{}');
    
    // Extract from path parameters if present
    const userId = event.pathParameters?.userId || request.userId;
    const allianceId = event.pathParameters?.allianceId || request.allianceId;
    
    let result: any;

    switch (request.action) {
      case 'get-user-stats':
        if (!userId) {
          throw new Error('User ID is required for get-user-stats action');
        }
        result = await userStatsService.getUserStats(userId);
        if (!result) {
          return {
            statusCode: 404,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'User stats not found' })
          };
        }
        break;

      case 'get-leaderboard':
        result = await userStatsService.getLeaderboard(
          request.leaderboardType || 'power',
          request.limit || 50
        );
        break;

      case 'get-alliance-stats':
        if (!allianceId) {
          throw new Error('Alliance ID is required for get-alliance-stats action');
        }
        result = await userStatsService.getAllianceStats(allianceId);
        if (!result) {
          return {
            statusCode: 404,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Alliance stats not found' })
          };
        }
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
    console.error('User stats service error:', error);

    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'User stats service failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};