import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

// Mock AWS environment for testing
process.env.REGION = 'us-east-1';
process.env.POLICY_STORE_TABLE = 'test-cedar-policies';
process.env.ENTITY_STORE_TABLE = 'test-cedar-entities';
process.env.ENABLE_DETAILED_METRICS = 'false';

interface TestUser {
  userId: string;
  userType: 'player' | 'admin';
  roles: string[];
  level: number;
  allianceId?: string;
  isActive: boolean;
}

interface TestAuthorizationRequest {
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

class CedarTestFramework {
  private policies: string[];
  private entities: Record<string, any>;

  constructor() {
    this.policies = [];
    this.entities = {};
    this.initializeDefaultPolicies();
  }

  private initializeDefaultPolicies(): void {
    this.policies = [
      `
      // Player base permissions
      permit (
        principal in Group::"Players",
        action in [
          Action::"login",
          Action::"viewProfile",
          Action::"updateProfile",
          Action::"collectResources"
        ],
        resource
      ) when {
        principal.isActive == true &&
        ((resource has ownerId && resource.ownerId == principal.userId) || resource.resourceType == "public")
      };
      `,
      `
      // Alliance member permissions
      permit (
        principal in Group::"AllianceMembers",
        action in [
          Action::"viewAllianceInfo",
          Action::"sendMessage",
          Action::"participateInBattle"
        ],
        resource
      ) when {
        principal.isActive == true &&
        principal.alliance == resource.alliance
      };
      `,
      `
      // Alliance leader permissions
      permit (
        principal in Group::"AllianceLeaders",
        action in [
          Action::"inviteMember",
          Action::"kickMember",
          Action::"promoteMember",
          Action::"declareWar"
        ],
        resource
      ) when {
        principal.isActive == true &&
        principal.alliance == resource.alliance
      };
      `,
      `
      // Admin permissions
      permit (
        principal in Group::"Admins",
        action in [
          Action::"banUser",
          Action::"resetGameState",
          Action::"viewSystemLogs"
        ],
        resource
      );
      `,
      `
      // Combat permissions with level restrictions
      permit (
        principal in Group::"Players",
        action == Action::"attack",
        resource
      ) when {
        principal.isActive == true &&
        principal.level >= (context.target.level - 10) &&
        principal.level <= (context.target.level + 10) &&
        principal.alliance != context.target.alliance &&
        context.pvpEnabled == true
      };
      `
    ];
  }

  addUser(user: TestUser): void {
    const groups = this.determineUserGroups(user);
    
    this.entities[`GameUser::"${user.userId}"`] = {
      userId: user.userId,
      userType: user.userType,
      level: user.level,
      isActive: user.isActive,
      alliance: user.allianceId,
      parents: groups.map(group => ({ type: "Group", id: group }))
    };

    // Add user to appropriate groups
    groups.forEach(group => {
      const groupKey = `Group::"${group}"`;
      if (!this.entities[groupKey]) {
        this.entities[groupKey] = {
          name: group,
          members: [],
          parents: []
        };
      }
    });
  }

  addAlliance(allianceId: string, leaderId: string, memberIds: string[]): void {
    this.entities[`Alliance::"${allianceId}"`] = {
      allianceId,
      leader: leaderId,
      members: memberIds,
      isActive: true,
      parents: []
    };
  }

  addResource(resourceId: string, resourceType: string, owner?: string, alliance?: string): void {
    const resourceAttrs: any = {
      resourceId,
      resourceType,
      parents: []
    };

    if (owner) {
      resourceAttrs.ownerId = owner;
    }

    if (alliance) {
      resourceAttrs.alliance = alliance;
    }

    this.entities[`GameResource::"${resourceId}"`] = resourceAttrs;
  }

  private determineUserGroups(user: TestUser): string[] {
    const groups = ['Players']; // All users are players

    if (user.roles.includes('admin')) {
      groups.push('Admins');
    }

    if (user.allianceId) {
      groups.push('AllianceMembers');
      
      if (user.roles.includes('alliance-leader')) {
        groups.push('AllianceLeaders');
      } else if (user.roles.includes('alliance-officer')) {
        groups.push('AllianceOfficers');
      }
    }

    return groups;
  }

  async authorize(request: TestAuthorizationRequest): Promise<{
    decision: 'ALLOW' | 'DENY';
    determiningPolicies: string[];
    errors: string[];
  }> {
    try {
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
          staticPolicies: this.policies.join('\n\n')
        },
        entities: Object.keys(this.entities).map(uid => {
          const [type, id] = uid.split('::"').map(s => s.replace(/"/g, ''));
          const entityData = { ...this.entities[uid] };
          const parents = entityData.parents || [];
          delete entityData.parents; // Don't include parents in attrs
          
          return {
            uid: { type, id },
            attrs: entityData,
            parents: parents
          };
        })
      };

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
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Test framework error: ${error}`]
      };
    }
  }
}

describe('Cedar Authorization - Game Scenarios', () => {
  let cedarTest: CedarTestFramework;

  beforeEach(() => {
    cedarTest = new CedarTestFramework();
    
    // Setup test users
    cedarTest.addUser({
      userId: 'player1',
      userType: 'player',
      roles: ['player'],
      level: 15,
      allianceId: 'alliance1',
      isActive: true
    });

    cedarTest.addUser({
      userId: 'player2',
      userType: 'player',
      roles: ['player'],
      level: 20,
      allianceId: 'alliance2',
      isActive: true
    });

    cedarTest.addUser({
      userId: 'leader1',
      userType: 'player',
      roles: ['player', 'alliance-leader'],
      level: 25,
      allianceId: 'alliance1',
      isActive: true
    });

    cedarTest.addUser({
      userId: 'admin1',
      userType: 'admin',
      roles: ['admin'],
      level: 50,
      isActive: true
    });

    // Setup test alliances
    cedarTest.addAlliance('alliance1', 'leader1', ['player1', 'leader1']);
    cedarTest.addAlliance('alliance2', 'player2', ['player2']);

    // Setup test resources
    cedarTest.addResource('profile1', 'profile', 'player1');
    cedarTest.addResource('alliance1-info', 'alliance', undefined, 'alliance1');
    cedarTest.addResource('enemy-base', 'base', 'player2', 'alliance2');
  });

  describe('Player Base Permissions', () => {
    it('should allow player to view their own profile', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      });

      expect(result.decision).toBe('ALLOW');
      expect(result.errors).toHaveLength(0);
    });

    it('should deny player from viewing another player profile', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player2' },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      });

      expect(result.decision).toBe('DENY');
    });

    it('should allow player to collect their own resources', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'collectResources' },
        resource: { entityType: 'GameResource', entityId: 'profile1' },
        context: {
          lastCollection: Date.now() - 7200, // 2 hours ago
          currentTime: Date.now()
        }
      });

      expect(result.decision).toBe('ALLOW');
    });
  });

  describe('Alliance Member Permissions', () => {
    it('should allow alliance member to view alliance info', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'viewAllianceInfo' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('should deny non-alliance member from viewing alliance info', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player2' },
        action: { actionType: 'Action', actionId: 'viewAllianceInfo' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('DENY');
    });

    it('should allow alliance member to participate in battle', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'participateInBattle' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('ALLOW');
    });
  });

  describe('Alliance Leader Permissions', () => {
    it('should allow alliance leader to invite members', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'leader1' },
        action: { actionType: 'Action', actionId: 'inviteMember' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('should deny regular member from inviting members', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'inviteMember' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('DENY');
    });

    it('should allow alliance leader to kick members', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'leader1' },
        action: { actionType: 'Action', actionId: 'kickMember' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('should allow alliance leader to declare war', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'leader1' },
        action: { actionType: 'Action', actionId: 'declareWar' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(result.decision).toBe('ALLOW');
    });
  });

  describe('Admin Permissions', () => {
    it('should allow admin to ban users', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'admin1' },
        action: { actionType: 'Action', actionId: 'banUser' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('should allow admin to reset game state', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'admin1' },
        action: { actionType: 'Action', actionId: 'resetGameState' },
        resource: { entityType: 'GameResource', entityId: 'enemy-base' }
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('should deny regular player from admin actions', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'banUser' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      });

      expect(result.decision).toBe('DENY');
    });
  });

  describe('Combat Authorization', () => {
    it('should allow attack within level range with PvP enabled', async () => {
      cedarTest.addResource('target-base', 'base', 'player2', 'alliance2');
      
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'attack' },
        resource: { entityType: 'GameResource', entityId: 'target-base' },
        context: {
          pvpEnabled: true,
          target: { level: 18, alliance: 'alliance2' }
        }
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('should deny attack outside level range', async () => {
      cedarTest.addResource('high-level-base', 'base', 'player2', 'alliance2');
      
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'attack' },
        resource: { entityType: 'GameResource', entityId: 'high-level-base' },
        context: {
          pvpEnabled: true,
          target: { level: 50, alliance: 'alliance2' }
        }
      });

      expect(result.decision).toBe('DENY');
    });

    it('should deny attack when PvP is disabled', async () => {
      cedarTest.addResource('target-base-2', 'base', 'player2', 'alliance2');
      
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'attack' },
        resource: { entityType: 'GameResource', entityId: 'target-base-2' },
        context: {
          pvpEnabled: false,
          target: { level: 18, alliance: 'alliance2' }
        }
      });

      expect(result.decision).toBe('DENY');
    });

    it('should deny attack on same alliance member', async () => {
      cedarTest.addResource('ally-base', 'base', 'leader1', 'alliance1');
      
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'attack' },
        resource: { entityType: 'GameResource', entityId: 'ally-base' },
        context: {
          pvpEnabled: true,
          target: { level: 25, alliance: 'alliance1' }
        }
      });

      expect(result.decision).toBe('DENY');
    });
  });

  describe('Context-Aware Authorization', () => {
    it('should deny resource collection too soon after last collection', async () => {
      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'player1' },
        action: { actionType: 'Action', actionId: 'collectResources' },
        resource: { entityType: 'GameResource', entityId: 'profile1' },
        context: {
          lastCollection: Date.now() - 1800, // 30 minutes ago (less than 1 hour)
          currentTime: Date.now()
        }
      });

      expect(result.decision).toBe('DENY');
    });

    it('should deny actions for inactive users', async () => {
      cedarTest.addUser({
        userId: 'inactive-player',
        userType: 'player',
        roles: ['player'],
        level: 10,
        isActive: false
      });

      const result = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'inactive-player' },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      });

      expect(result.decision).toBe('DENY');
    });
  });

  describe('Complex Multi-Role Scenarios', () => {
    it('should allow player with multiple roles to access all permitted actions', async () => {
      // Test that alliance leader can perform both player and leader actions
      const playerActionResult = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'leader1' },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      });

      const leaderActionResult = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'leader1' },
        action: { actionType: 'Action', actionId: 'kickMember' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(playerActionResult.decision).toBe('ALLOW');
      expect(leaderActionResult.decision).toBe('ALLOW');
    });

    it('should properly enforce hierarchy in alliance operations', async () => {
      // Alliance leader should be able to manage regular members
      const manageResult = await cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: 'leader1' },
        action: { actionType: 'Action', actionId: 'promoteMember' },
        resource: { entityType: 'GameResource', entityId: 'alliance1-info' }
      });

      expect(manageResult.decision).toBe('ALLOW');
    });
  });
});

describe('Cedar Authorization - Performance Tests', () => {
  let cedarTest: CedarTestFramework;

  beforeAll(() => {
    cedarTest = new CedarTestFramework();
    
    // Add many users for performance testing
    for (let i = 0; i < 100; i++) {
      cedarTest.addUser({
        userId: `perf-user-${i}`,
        userType: 'player',
        roles: ['player'],
        level: Math.floor(Math.random() * 50) + 1,
        allianceId: `alliance-${i % 10}`,
        isActive: true
      });
    }
  });

  it('should authorize requests quickly for large user base', async () => {
    const startTime = Date.now();
    
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(cedarTest.authorize({
        principal: { entityType: 'GameUser', entityId: `perf-user-${i}` },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'GameResource', entityId: 'profile1' }
      }));
    }
    
    const results = await Promise.all(promises);
    const endTime = Date.now();
    const totalTime = endTime - startTime;
    
    console.log(`50 authorization requests completed in ${totalTime}ms (${totalTime/50}ms average)`);
    
    // All should complete within reasonable time (less than 5 seconds total)
    expect(totalTime).toBeLessThan(5000);
    
    // Most should be denied (wrong resource owner)
    const deniedCount = results.filter(r => r.decision === 'DENY').length;
    expect(deniedCount).toBeGreaterThan(40);
  });
});

describe('Cedar Authorization - Error Handling', () => {
  let cedarTest: CedarTestFramework;

  beforeEach(() => {
    cedarTest = new CedarTestFramework();
  });

  it('should handle malformed authorization requests gracefully', async () => {
    const result = await cedarTest.authorize({
      principal: { entityType: 'InvalidType', entityId: 'nonexistent' },
      action: { actionType: 'InvalidAction', actionId: 'unknown' },
      resource: { entityType: 'InvalidResource', entityId: 'missing' }
    });

    expect(result.decision).toBe('DENY');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should handle missing context gracefully', async () => {
    cedarTest.addUser({
      userId: 'test-user',
      userType: 'player',
      roles: ['player'],
      level: 10,
      isActive: true
    });

    const result = await cedarTest.authorize({
      principal: { entityType: 'GameUser', entityId: 'test-user' },
      action: { actionType: 'Action', actionId: 'attack' },
      resource: { entityType: 'GameResource', entityId: 'enemy-base' }
      // No context provided
    });

    expect(result.decision).toBe('DENY');
  });
});