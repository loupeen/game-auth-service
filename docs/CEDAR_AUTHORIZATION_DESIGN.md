# Cedar Authorization Engine Design for Loupeen RTS Platform

## 🎯 Overview

This document outlines the Cedar Authorization Engine implementation for the Loupeen RTS Platform, providing fine-grained access control for alliance-based gameplay with hierarchical roles and permissions.

## 🎮 Game Authorization Model

### Entity Hierarchy
```
GameUser (Base Entity)
├── Player (Basic game participant)
├── AllianceMember (Player in an alliance)
├── AllianceOfficer (Alliance management permissions)
├── AllianceLeader (Full alliance control)
└── Admin (System administration)
```

### Resource Categories
```
GameResource
├── PlayerData (profiles, stats, inventory)
├── AllianceData (alliance info, member lists, resources)
├── BattleData (ongoing battles, battle history)
├── GameConfig (system settings, rules)
└── SystemData (logs, metrics, admin tools)
```

## 📋 Cedar Schema Definition

### Core Entities
```cedar
// User entity with hierarchical roles
entity GameUser = {
  "userId": String,
  "username": String,
  "level": Long,
  "alliance"?: Alliance,
  "roles": Set<Role>,
  "isActive": Boolean,
  "lastLogin": String
};

// Alliance entity
entity Alliance = {
  "allianceId": String,
  "name": String,
  "leader": GameUser,
  "officers": Set<GameUser>,
  "members": Set<GameUser>,
  "level": Long,
  "isActive": Boolean
};

// Game resources
entity GameResource = {
  "resourceId": String,
  "resourceType": String,
  "owner"?: GameUser,
  "alliance"?: Alliance,
  "permissions": Set<String>
};

// Actions users can perform
entity GameAction = {
  "actionId": String,
  "category": String,
  "riskLevel": Long,
  "requiresApproval": Boolean
};

// Roles with specific permissions
entity Role = {
  "roleId": String,
  "name": String,
  "permissions": Set<String>,
  "hierarchy": Long
};
```

### Action Categories
```cedar
// Define action types for the game
namespace GameActions {
  // Player actions
  PlayerActions = [
    "login", "logout", "viewProfile", "updateProfile",
    "buildStructure", "upgradeBuilding", "collectResources",
    "trainUnits", "moveUnits", "scout"
  ];
  
  // Combat actions
  CombatActions = [
    "attack", "defend", "reinforce", "retreat",
    "declareWar", "proposePeace", "viewBattleHistory"
  ];
  
  // Alliance actions
  AllianceActions = [
    "viewAllianceInfo", "sendMessage", "requestSupport",
    "shareResources", "participateInBattle", "voteOnDecisions"
  ];
  
  // Alliance management actions
  AllianceManagementActions = [
    "inviteMember", "kickMember", "promoteMember", "demoteMember",
    "setAlliancePolicy", "manageResources", "scheduleEvents",
    "disbandAlliance"
  ];
  
  // Admin actions
  AdminActions = [
    "banUser", "unbanUser", "resetGameState", "modifyGameConfig",
    "viewSystemLogs", "manageEvents", "emergencyActions"
  ];
}
```

## 🔐 Authorization Policies

### 1. Player Base Permissions
```cedar
// Basic player permissions - self-management
permit (
  principal in GameUser::Players,
  action in GameActions::PlayerActions,
  resource
) when {
  principal.isActive == true &&
  (resource.owner == principal || resource.resourceType == "public")
};

// Players can view their own data
permit (
  principal in GameUser::Players,
  action == GameAction::"viewProfile",
  resource
) when {
  principal.isActive == true &&
  (resource.owner == principal || resource.permissions.contains("public_view"))
};

// Resource collection with rate limiting
permit (
  principal in GameUser::Players,
  action == GameAction::"collectResources",
  resource
) when {
  principal.isActive == true &&
  resource.owner == principal &&
  context.lastCollection + 3600 <= context.currentTime // 1 hour cooldown
};
```

### 2. Alliance Member Permissions
```cedar
// Alliance members can view alliance information
permit (
  principal in GameUser::AllianceMembers,
  action in [
    GameAction::"viewAllianceInfo",
    GameAction::"sendMessage",
    GameAction::"requestSupport"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance
};

// Alliance members can participate in alliance battles
permit (
  principal in GameUser::AllianceMembers,
  action in [
    GameAction::"participateInBattle",
    GameAction::"reinforce",
    GameAction::"shareResources"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  context.battleActive == true
};

// Alliance member voting rights
permit (
  principal in GameUser::AllianceMembers,
  action == GameAction::"voteOnDecisions",
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  context.votingOpen == true &&
  !context.alreadyVoted.contains(principal.userId)
};
```

### 3. Alliance Officer Permissions
```cedar
// Alliance officers have member management permissions
permit (
  principal in GameUser::AllianceOfficers,
  action in [
    GameAction::"inviteMember",
    GameAction::"kickMember",
    GameAction::"scheduleEvents"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  (resource.targetUser.hierarchy < principal.hierarchy || action == GameAction::"inviteMember")
};

// Officers can manage alliance resources
permit (
  principal in GameUser::AllianceOfficers,
  action in [
    GameAction::"manageResources",
    GameAction::"setAlliancePolicy"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  resource.resourceType != "critical"
};
```

### 4. Alliance Leader Permissions
```cedar
// Alliance leaders have full alliance control
permit (
  principal in GameUser::AllianceLeaders,
  action in GameActions::AllianceManagementActions,
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance
};

// Alliance leaders can promote/demote any member except other leaders
permit (
  principal in GameUser::AllianceLeaders,
  action in [
    GameAction::"promoteMember",
    GameAction::"demoteMember"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  resource.targetUser.roles.excludes("AllianceLeader") &&
  resource.targetUser != principal
};

// Alliance leaders can declare war and manage diplomacy
permit (
  principal in GameUser::AllianceLeaders,
  action in [
    GameAction::"declareWar",
    GameAction::"proposePeace",
    GameAction::"formAlliance"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance != resource.targetAlliance &&
  context.diplomaticActionsEnabled == true
};
```

### 5. Admin Permissions
```cedar
// System administrators have broad access
permit (
  principal in GameUser::Admins,
  action in GameActions::AdminActions,
  resource
);

// Emergency admin actions with approval
permit (
  principal in GameUser::Admins,
  action in [
    GameAction::"emergencyShutdown",
    GameAction::"rollbackGameState",
    GameAction::"massUserAction"
  ],
  resource
) when {
  context.emergencyLevel >= 3 ||
  context.approvals.contains("senior-admin")
};

// Admins can impersonate users for support (with audit)
permit (
  principal in GameUser::Admins,
  action == GameAction::"impersonateUser",
  resource
) when {
  context.supportTicket != null &&
  context.auditTrail == true &&
  !resource.targetUser.roles.contains("Admin")
};
```

### 6. Combat and PvP Permissions
```cedar
// Players can attack enemies within level range
permit (
  principal in GameUser::Players,
  action == GameAction::"attack",
  resource
) when {
  principal.isActive == true &&
  principal.level >= (resource.target.level - 10) &&
  principal.level <= (resource.target.level + 10) &&
  principal.alliance != resource.target.alliance &&
  context.pvpEnabled == true &&
  !context.protectedNewPlayer.contains(resource.target.userId)
};

// Alliance vs alliance combat
permit (
  principal in GameUser::AllianceMembers,
  action in [
    GameAction::"attack",
    GameAction::"reinforce",
    GameAction::"groupAttack"
  ],
  resource
) when {
  principal.isActive == true &&
  (
    (principal.alliance.wars.contains(resource.target.alliance) && 
     context.warActive == true) ||
    (context.battleType == "tournament" && 
     context.tournamentParticipants.contains(principal.alliance))
  )
};
```

### 7. Context-Aware Permissions
```cedar
// Time-based restrictions
permit (
  principal in GameUser::Players,
  action in GameActions::CombatActions,
  resource
) when {
  principal.isActive == true &&
  context.gameTime >= 800 && // 8:00 AM
  context.gameTime <= 2200 && // 10:00 PM
  context.maintenanceMode == false
};

// Event-specific permissions
permit (
  principal in GameUser::Players,
  action in [
    GameAction::"participateInEvent",
    GameAction::"claimEventRewards"
  ],
  resource
) when {
  principal.isActive == true &&
  context.eventActive == true &&
  context.eventParticipants.contains(principal.userId) &&
  principal.level >= resource.event.minimumLevel
};
```

## 🔧 Implementation Architecture

### Cedar Policy Store Structure
```typescript
interface PolicyStoreConfig {
  environment: 'test' | 'qa' | 'production';
  policies: {
    player: string[];
    alliance: string[];
    admin: string[];
    combat: string[];
    events: string[];
  };
  schema: CedarSchema;
  validationMode: 'STRICT' | 'PERMISSIVE';
}
```

### Authorization Service Integration
```typescript
class GameAuthorizationService {
  private verifiedPermissions: VerifiedPermissionsClient;
  private policyStoreId: string;
  private cache: Map<string, AuthResult>;

  async authorize(
    userId: string,
    action: string,
    resourceId: string,
    context: GameContext
  ): Promise<AuthorizationResult> {
    const cacheKey = `${userId}:${action}:${resourceId}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const authRequest = {
      policyStoreId: this.policyStoreId,
      principal: {
        entityType: 'GameUser',
        entityId: userId
      },
      action: {
        actionType: 'GameAction',
        actionId: action
      },
      resource: {
        entityType: 'GameResource',
        entityId: resourceId
      },
      context: {
        contextMap: this.buildContextMap(context)
      }
    };

    const result = await this.verifiedPermissions.isAuthorized(authRequest);
    
    const authResult = {
      allowed: result.decision === 'ALLOW',
      reason: result.determiningPolicies,
      errors: result.errors
    };

    // Cache result for 60 seconds
    this.cache.set(cacheKey, authResult);
    setTimeout(() => this.cache.delete(cacheKey), 60000);

    return authResult;
  }

  private buildContextMap(context: GameContext): Record<string, any> {
    return {
      currentTime: Date.now(),
      gameTime: context.gameTime,
      pvpEnabled: context.pvpEnabled,
      battleActive: context.battleActive,
      maintenanceMode: context.maintenanceMode,
      emergencyLevel: context.emergencyLevel || 0,
      eventActive: context.eventActive || false
    };
  }
}
```

### JWT Integration Enhancement
```typescript
interface EnhancedJWTPayload {
  // Existing JWT fields
  sub: string;
  sessionId: string;
  deviceId: string;
  userType: string;
  roles: string[];
  
  // Cedar-specific additions
  allianceId?: string;
  allianceRole?: string;
  userLevel: number;
  permissions: string[];
  hierarchyLevel: number;
}

class CedarJWTValidator {
  async validateWithAuthorization(
    token: string,
    requestedAction: string,
    resourceId: string
  ): Promise<{ valid: boolean; authorized: boolean; user?: any }> {
    // First validate JWT
    const jwtResult = await this.validateJWT(token);
    if (!jwtResult.valid) {
      return { valid: false, authorized: false };
    }

    // Then check Cedar authorization
    const authResult = await this.gameAuth.authorize(
      jwtResult.user.sub,
      requestedAction,
      resourceId,
      this.buildGameContext(jwtResult.user)
    );

    return {
      valid: true,
      authorized: authResult.allowed,
      user: jwtResult.user
    };
  }
}
```

## 📊 Performance Considerations

### Optimization Strategies
1. **Policy Indexing**: Use Cedar's built-in indexing for frequently accessed policies
2. **Result Caching**: Cache authorization results for 60 seconds to reduce API calls
3. **Batch Operations**: Group related authorization checks
4. **Context Minimization**: Include only necessary context data

### Latency Targets
- **Authorization Decision**: <10ms (cached), <50ms (uncached)
- **Policy Evaluation**: <5ms for simple policies
- **Context Resolution**: <20ms for complex game state

## 🧪 Testing Strategy

### Policy Testing Framework
```typescript
class CedarPolicyTester {
  async testPlayerPermissions() {
    const testCases = [
      {
        user: 'player-123',
        action: 'attack',
        resource: 'enemy-base-456',
        context: { pvpEnabled: true, userLevel: 10, targetLevel: 12 },
        expected: true
      },
      {
        user: 'player-123',
        action: 'attack', 
        resource: 'ally-base-789',
        context: { pvpEnabled: true, sameAlliance: true },
        expected: false
      }
    ];

    for (const test of testCases) {
      const result = await this.authorize(test.user, test.action, test.resource, test.context);
      assert.equal(result.allowed, test.expected, `Test failed for ${test.action}`);
    }
  }
}
```

## 🔄 Migration Strategy

### Phase 1: Foundation (Week 1)
- Set up AWS Verified Permissions policy store
- Implement basic authorization service
- Create initial player and admin policies

### Phase 2: Alliance Integration (Week 2) 
- Add alliance-based permissions
- Implement hierarchical role system
- Test alliance member interactions

### Phase 3: Combat Authorization (Week 3)
- Add PvP and alliance combat permissions
- Implement context-aware battle restrictions
- Performance optimization and caching

### Phase 4: Advanced Features (Week 4)
- Event-based permissions
- Emergency admin actions
- Comprehensive audit logging

## 📈 Monitoring and Metrics

### Key Metrics to Track
- Authorization request latency
- Policy evaluation time
- Cache hit rate
- Authorization denial reasons
- Failed authorization attempts

### CloudWatch Alarms
```typescript
const authMetrics = {
  'Authorization-Latency': { threshold: 50, unit: 'Milliseconds' },
  'Authorization-Errors': { threshold: 10, unit: 'Count' },
  'Cache-Hit-Rate': { threshold: 80, unit: 'Percent' },
  'Policy-Evaluation-Time': { threshold: 10, unit: 'Milliseconds' }
};
```

This Cedar Authorization Engine design provides a robust, scalable foundation for managing complex game permissions while maintaining the performance requirements for real-time gaming applications.