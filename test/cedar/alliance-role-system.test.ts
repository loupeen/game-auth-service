/**
 * Alliance Role-Based Authorization System Test Suite
 * Issue #18: Alliance Role-Based Authorization System
 * 
 * Comprehensive tests for hierarchical alliance roles, inheritance,
 * and complex authorization rules.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import {
  ALLIANCE_ROLES,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  ROLE_TRANSITION_RULES,
  QUORUM_REQUIREMENTS,
  AllianceRole,
  AlliancePlayerEntity,
  AllianceContext,
  QuorumVote
} from '../../lambda/cedar/alliance-role-policies-schema';
import AllianceRoleInheritanceManager from '../../lambda/cedar/alliance-role-inheritance';
import AllianceRoleAuditManager, { AuditEventType, RiskLevel } from '../../lambda/cedar/alliance-role-audit-trail';
import { ALLIANCE_ROLE_CEDAR_POLICIES } from '../../lambda/cedar/alliance-role-cedar-policies';

// Mock AWS services
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/client-cloudwatch');

describe('Alliance Role-Based Authorization System', () => {
  let inheritanceManager: AllianceRoleInheritanceManager;
  let auditManager: AllianceRoleAuditManager;
  
  // Test data
  const testAlliance: AllianceContext = {
    allianceId: 'alliance123',
    isAtWar: false,
    isInActiveCombat: false,
    memberCount: 50,
    createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    currentLeader: 'player001',
    viceLeaders: ['player002'],
    officers: ['player003', 'player004'],
    recentActions: []
  };
  
  const testPlayers: Record<string, AlliancePlayerEntity> = {
    leader: {
      playerId: 'player001',
      allianceId: 'alliance123',
      role: ALLIANCE_ROLES.LEADER,
      roleAssignedAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
      roleAssignedBy: 'system',
      permissions: [],
      roleHistory: []
    },
    viceLeader: {
      playerId: 'player002',
      allianceId: 'alliance123',
      role: ALLIANCE_ROLES.VICE_LEADER,
      roleAssignedAt: Date.now() - 5 * 24 * 60 * 60 * 1000, // 5 days ago
      roleAssignedBy: 'player001',
      permissions: [],
      roleHistory: []
    },
    officer: {
      playerId: 'player003',
      allianceId: 'alliance123',
      role: ALLIANCE_ROLES.OFFICERS,
      roleAssignedAt: Date.now() - 15 * 24 * 60 * 60 * 1000, // 15 days ago (past minimum duration)
      roleAssignedBy: 'player001',
      permissions: [],
      roleHistory: []
    },
    managementL1: {
      playerId: 'player004',
      allianceId: 'alliance123',
      role: ALLIANCE_ROLES.MANAGEMENT_L1,
      roleAssignedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
      roleAssignedBy: 'player002',
      permissions: [],
      roleHistory: []
    },
    member: {
      playerId: 'player005',
      allianceId: 'alliance123',
      role: ALLIANCE_ROLES.MEMBERS,
      roleAssignedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, // 4 days ago (past minimum duration)
      roleAssignedBy: 'player003',
      permissions: [],
      roleHistory: []
    },
    recruit: {
      playerId: 'player006',
      allianceId: 'alliance123',
      role: ALLIANCE_ROLES.RECRUITS,
      roleAssignedAt: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago
      roleAssignedBy: 'player004',
      permissions: [],
      roleHistory: []
    }
  };
  
  beforeAll(async () => {
    inheritanceManager = new AllianceRoleInheritanceManager();
    auditManager = new AllianceRoleAuditManager();
  });
  
  beforeEach(() => {
    // Reset test data
    testAlliance.isAtWar = false;
    testAlliance.isInActiveCombat = false;
    testAlliance.recentActions = [];
  });
  
  describe('Role Hierarchy and Permissions', () => {
    
    test('should have correct role hierarchy levels', () => {
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.LEADER]).toBe(8);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.VICE_LEADER]).toBe(7);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.OFFICERS]).toBe(6);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.MANAGEMENT_L1]).toBe(5);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.MANAGEMENT_L2]).toBe(4);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.MANAGEMENT_L3]).toBe(3);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.MEMBERS]).toBe(2);
      expect(ROLE_HIERARCHY[ALLIANCE_ROLES.RECRUITS]).toBe(1);
    });
    
    test('should have leader with most permissions', () => {
      const leaderPermissions = ROLE_PERMISSIONS[ALLIANCE_ROLES.LEADER];
      const viceLeaderPermissions = ROLE_PERMISSIONS[ALLIANCE_ROLES.VICE_LEADER];
      
      expect(leaderPermissions.length).toBeGreaterThan(viceLeaderPermissions.length);
      expect(leaderPermissions).toContain('leadership.transfer');
      expect(leaderPermissions).toContain('leadership.disband-alliance');
      expect(viceLeaderPermissions).not.toContain('leadership.transfer');
    });
    
    test('should implement role inheritance correctly', () => {
      // Leader should have all permissions from lower roles
      const leaderPermissions = inheritanceManager.getAllPermissions(ALLIANCE_ROLES.LEADER);
      const memberPermissions = inheritanceManager.getAllPermissions(ALLIANCE_ROLES.MEMBERS);
      
      memberPermissions.forEach(permission => {
        expect(leaderPermissions).toContain(permission);
      });
      
      // Officer should have member permissions
      const officerPermissions = inheritanceManager.getAllPermissions(ALLIANCE_ROLES.OFFICERS);
      memberPermissions.forEach(permission => {
        expect(officerPermissions).toContain(permission);
      });
    });
    
    test('should validate permission checks correctly', () => {
      // Leader can do everything
      expect(inheritanceManager.hasPermission(ALLIANCE_ROLES.LEADER, 'member.kick')).toBe(true);
      expect(inheritanceManager.hasPermission(ALLIANCE_ROLES.LEADER, 'resource.view')).toBe(true);
      expect(inheritanceManager.hasPermission(ALLIANCE_ROLES.LEADER, 'leadership.transfer')).toBe(true);
      
      // Member cannot kick other members
      expect(inheritanceManager.hasPermission(ALLIANCE_ROLES.MEMBERS, 'member.kick')).toBe(false);
      
      // Recruit has very limited permissions
      expect(inheritanceManager.hasPermission(ALLIANCE_ROLES.RECRUITS, 'member.kick')).toBe(false);
      expect(inheritanceManager.hasPermission(ALLIANCE_ROLES.RECRUITS, 'basic.view-alliance-info')).toBe(true);
    });
  });
  
  describe('Role Transitions and Promotions', () => {
    
    test('should allow leader to promote anyone (except to leader)', () => {
      const result = inheritanceManager.canPromote(
        testPlayers.leader,
        testPlayers.member,
        ALLIANCE_ROLES.OFFICERS,
        testAlliance
      );
      
      expect(result.allowed).toBe(true);
    });
    
    test('should prevent promoting above your own level', () => {
      const result = inheritanceManager.canPromote(
        testPlayers.officer,
        testPlayers.member,
        ALLIANCE_ROLES.VICE_LEADER,
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Cannot promote above your own authority level');
    });
    
    test('should enforce minimum role duration', () => {
      // Try to promote a fresh recruit
      const freshRecruit = {
        ...testPlayers.recruit,
        roleAssignedAt: Date.now() - 30 * 60 * 1000 // 30 minutes ago
      };
      
      const result = inheritanceManager.canPromote(
        testPlayers.officer,
        freshRecruit,
        ALLIANCE_ROLES.MEMBERS,
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('must remain in');
    });
    
    test('should enforce promotion cooldown', () => {
      // Player who was recently promoted
      const recentlyPromoted = {
        ...testPlayers.member,
        lastRoleChange: Date.now() - 2 * 60 * 60 * 1000 // 2 hours ago
      };
      
      const result = inheritanceManager.canPromote(
        testPlayers.officer,
        recentlyPromoted,
        ALLIANCE_ROLES.MANAGEMENT_L3,
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Promotion cooldown');
    });
    
    test('should prevent role changes during combat', () => {
      testAlliance.isInActiveCombat = true;
      
      const result = inheritanceManager.canPromote(
        testPlayers.leader,
        testPlayers.member,
        ALLIANCE_ROLES.OFFICERS,
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('during active combat');
    });
    
    test('should allow demotions with proper authority', () => {
      const result = inheritanceManager.canDemote(
        testPlayers.leader,
        testPlayers.managementL1,
        ALLIANCE_ROLES.MEMBERS,
        testAlliance
      );
      
      expect(result.allowed).toBe(true);
    });
    
    test('should prevent unauthorized demotions', () => {
      const result = inheritanceManager.canDemote(
        testPlayers.member,
        testPlayers.officer,
        ALLIANCE_ROLES.MEMBERS,
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient authority');
    });
  });
  
  describe('Quorum Requirements', () => {
    
    test('should identify actions requiring quorum', () => {
      expect(inheritanceManager.requiresQuorum('DECLARE_WAR')).toBe(true);
      expect(inheritanceManager.requiresQuorum('LEADERSHIP_TRANSFER')).toBe(true);
      expect(inheritanceManager.requiresQuorum('DISBAND_ALLIANCE')).toBe(true);
      expect(inheritanceManager.requiresQuorum('member.kick')).toBe(false);
    });
    
    test('should validate quorum voting requirements', () => {
      const warDeclarationVote: QuorumVote = {
        voteId: 'vote123',
        allianceId: 'alliance123',
        action: 'DECLARE_WAR',
        initiatedBy: 'player001',
        initiatedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        votingEndsAt: Date.now() - 60 * 60 * 1000, // 1 hour ago (ended)
        requiredVoters: 2,
        requiredRoles: [ALLIANCE_ROLES.LEADER, ALLIANCE_ROLES.VICE_LEADER, ALLIANCE_ROLES.OFFICERS],
        approvalThreshold: 0.6,
        votes: [
          {
            voterId: 'player001',
            voterRole: ALLIANCE_ROLES.LEADER,
            vote: 'approve',
            votedAt: Date.now() - 90 * 60 * 1000
          },
          {
            voterId: 'player002',
            voterRole: ALLIANCE_ROLES.VICE_LEADER,
            vote: 'approve',
            votedAt: Date.now() - 80 * 60 * 1000
          },
          {
            voterId: 'player003',
            voterRole: ALLIANCE_ROLES.OFFICERS,
            vote: 'deny',
            votedAt: Date.now() - 70 * 60 * 1000
          }
        ],
        status: 'active'
      };
      
      const result = inheritanceManager.validateQuorumDecision(
        'DECLARE_WAR',
        warDeclarationVote,
        testAlliance
      );
      
      expect(result.valid).toBe(true);
      expect(result.canExecute).toBe(true); // 2/3 approve = 66% > 60% threshold
    });
    
    test('should reject insufficient quorum approval', () => {
      const insufficientVote: QuorumVote = {
        voteId: 'vote124',
        allianceId: 'alliance123',
        action: 'LEADERSHIP_TRANSFER',
        initiatedBy: 'player002',
        initiatedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, // 4 days ago
        votingEndsAt: Date.now() - 60 * 60 * 1000, // Ended 1 hour ago
        requiredVoters: 3,
        requiredRoles: [ALLIANCE_ROLES.VICE_LEADER, ALLIANCE_ROLES.OFFICERS],
        approvalThreshold: 0.66,
        votes: [
          {
            voterId: 'player002',
            voterRole: ALLIANCE_ROLES.VICE_LEADER,
            vote: 'approve',
            votedAt: Date.now() - 2 * 24 * 60 * 60 * 1000
          },
          {
            voterId: 'player003',
            voterRole: ALLIANCE_ROLES.OFFICERS,
            vote: 'deny',
            votedAt: Date.now() - 2 * 24 * 60 * 60 * 1000
          }
        ],
        status: 'active'
      };
      
      const result = inheritanceManager.validateQuorumDecision(
        'LEADERSHIP_TRANSFER',
        insufficientVote,
        testAlliance
      );
      
      expect(result.valid).toBe(false);
      expect(result.canExecute).toBe(false);
      expect(result.reason).toContain('Insufficient voters');
    });
  });
  
  describe('Temporal Restrictions and Emergency Controls', () => {
    
    test('should prevent critical actions during combat', () => {
      testAlliance.isInActiveCombat = true;
      
      const result = inheritanceManager.checkTemporalRestrictions(
        'leadership.transfer',
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('during active combat');
    });
    
    test('should apply enhanced approval during peak hours', () => {
      // Mock current time to be 20:00 UTC (peak hours)
      const originalDate = Date;
      global.Date = class extends originalDate {
        static now() {
          return new originalDate('2024-01-01T20:00:00Z').getTime();
        }
        getUTCHours() {
          return 20; // Peak hour
        }
      } as any;
      
      const result = inheritanceManager.checkTemporalRestrictions(
        'operation.declare-war',
        testAlliance
      );
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('enhanced approval during peak hours');
      
      // Restore original Date
      global.Date = originalDate;
    });
    
    test('should calculate effective permissions with context', () => {
      // Normal context
      const normalPermissions = inheritanceManager.getEffectivePermissions(
        testPlayers.leader,
        testAlliance
      );
      
      // Combat context
      testAlliance.isInActiveCombat = true;
      const combatPermissions = inheritanceManager.getEffectivePermissions(
        testPlayers.leader,
        testAlliance
      );
      
      expect(normalPermissions.length).toBeGreaterThan(combatPermissions.length);
      expect(combatPermissions).not.toContain('leadership.transfer');
      expect(combatPermissions).toContain('military.emergency-command');
    });
  });
  
  describe('Separation of Duties', () => {
    
    test('should identify dual control requirements', () => {
      expect(inheritanceManager.requiresDualControl('resource.treasury.withdraw-large')).toBe(true);
      expect(inheritanceManager.requiresDualControl('member.kick.officer-or-above')).toBe(true);
      expect(inheritanceManager.requiresDualControl('leadership.emergency-override')).toBe(true);
      expect(inheritanceManager.requiresDualControl('member.invite')).toBe(false);
    });
  });
  
  describe('Audit Trail System', () => {
    
    test('should log role assignment events', async () => {
      const logSpy = jest.spyOn(auditManager as any, 'storeAuditEvent')
        .mockImplementation(() => Promise.resolve());
      
      await auditManager.logRoleAssignment(
        testAlliance.allianceId,
        testPlayers.leader,
        testPlayers.member,
        ALLIANCE_ROLES.MANAGEMENT_L1,
        ALLIANCE_ROLES.MEMBERS,
        'Performance improvement'
      );
      
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.ROLE_PROMOTED,
          allianceId: testAlliance.allianceId,
          actor: expect.objectContaining({
            playerId: testPlayers.leader.playerId,
            role: testPlayers.leader.role
          }),
          target: expect.objectContaining({
            playerId: testPlayers.member.playerId
          })
        })
      );
      
      logSpy.mockRestore();
    });
    
    test('should log permission usage', async () => {
      const logSpy = jest.spyOn(auditManager as any, 'storeAuditEvent')
        .mockImplementation(() => Promise.resolve());
      
      await auditManager.logPermissionUsage(
        testAlliance.allianceId,
        testPlayers.officer,
        'member.kick',
        { id: 'player999', type: 'player' },
        true
      );
      
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.PERMISSION_USED,
          allianceId: testAlliance.allianceId,
          success: true,
          details: expect.objectContaining({
            action: 'member.kick'
          })
        })
      );
      
      logSpy.mockRestore();
    });
    
    test('should log emergency overrides with critical risk', async () => {
      const logSpy = jest.spyOn(auditManager as any, 'storeAuditEvent')
        .mockImplementation(() => Promise.resolve());
      const alertSpy = jest.spyOn(auditManager as any, 'sendCriticalAlert')
        .mockImplementation(() => Promise.resolve());
      
      await auditManager.logEmergencyOverride(
        testAlliance.allianceId,
        testPlayers.leader,
        'member.kick.protected',
        'Alliance under attack, immediate action required'
      );
      
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: AuditEventType.EMERGENCY_OVERRIDE,
          riskLevel: RiskLevel.CRITICAL,
          context: expect.objectContaining({
            isEmergency: true
          })
        })
      );
      
      expect(alertSpy).toHaveBeenCalled();
      
      logSpy.mockRestore();
      alertSpy.mockRestore();
    });
  });
  
  describe('Cedar Policy Validation', () => {
    
    test('should have valid Cedar policy syntax', () => {
      Object.values(ALLIANCE_ROLE_CEDAR_POLICIES).forEach(policy => {
        expect(policy).toContain('permit');
        expect(policy).toMatch(/principal[\s\S]*action[\s\S]*resource/);
        expect(policy).toContain('when');
      });
    });
    
    test('should have leader full access policy', () => {
      const leaderPolicy = ALLIANCE_ROLE_CEDAR_POLICIES.ALLIANCE_LEADER_FULL_MEMBER_MANAGEMENT;
      expect(leaderPolicy).toContain('principal.role == "leader"');
      expect(leaderPolicy).toContain('Action::"inviteMember"');
      expect(leaderPolicy).toContain('Action::"kickMember"');
      expect(leaderPolicy).toContain('Action::"promoteMember"');
    });
    
    test('should have hierarchy-respecting officer kick policy', () => {
      const officerKickPolicy = ALLIANCE_ROLE_CEDAR_POLICIES.ALLIANCE_OFFICER_KICK_LOWER_ROLES;
      expect(officerKickPolicy).toContain('principal.role == "officer"');
      expect(officerKickPolicy).toContain('resource.role in ["member", "recruit"');
      expect(officerKickPolicy).toContain('Action::"kickMember"');
    });
    
    test('should have combat lockdown forbid policy', () => {
      const combatLockdown = ALLIANCE_ROLE_CEDAR_POLICIES.ALLIANCE_COMBAT_LOCKDOWN;
      expect(combatLockdown).toContain('forbid');
      expect(combatLockdown).toContain('resource.isInActiveCombat == true');
      expect(combatLockdown).toContain('Action::"transferLeadership"');
    });
    
    test('should have dual control policies', () => {
      const dualControlTreasury = ALLIANCE_ROLE_CEDAR_POLICIES.ALLIANCE_DUAL_CONTROL_TREASURY;
      expect(dualControlTreasury).toContain('forbid');
      expect(dualControlTreasury).toContain('unless');
      expect(dualControlTreasury).toContain('resource.approvalCount >= 2');
    });
  });
  
  describe('Performance and Scalability', () => {
    
    test('should handle role hierarchy calculations efficiently', () => {
      const startTime = Date.now();
      
      // Test 100 permission checks
      for (let i = 0; i < 100; i++) {
        inheritanceManager.hasPermission(ALLIANCE_ROLES.LEADER, 'member.kick');
        inheritanceManager.hasPermission(ALLIANCE_ROLES.OFFICERS, 'resource.view');
        inheritanceManager.hasPermission(ALLIANCE_ROLES.MEMBERS, 'communication.chat');
      }
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(50); // Should complete in under 50ms
    });
    
    test('should efficiently calculate all permissions for roles', () => {
      const startTime = Date.now();
      
      // Calculate permissions for all roles
      Object.values(ALLIANCE_ROLES).forEach(role => {
        const permissions = inheritanceManager.getAllPermissions(role);
        expect(Array.isArray(permissions)).toBe(true);
        expect(permissions.length).toBeGreaterThan(0);
      });
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(20); // Very fast permission calculation
    });
    
    test('should handle complex promotion validation quickly', () => {
      const startTime = Date.now();
      
      // Test 50 promotion validations
      for (let i = 0; i < 50; i++) {
        inheritanceManager.canPromote(
          testPlayers.leader,
          testPlayers.member,
          ALLIANCE_ROLES.OFFICERS,
          testAlliance
        );
      }
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100); // Complex validation under 100ms
    });
  });
  
  afterAll(async () => {
    console.log('Alliance role-based authorization system test suite completed');
  });
});