/**
 * Simplified Alliance Role Test
 * For debugging the alliance role system
 */

import { describe, test, expect } from '@jest/globals';
import {
  ALLIANCE_ROLES,
  ROLE_HIERARCHY,
  AlliancePlayerEntity,
  AllianceContext
} from '../../lambda/cedar/alliance-role-policies-schema';
import AllianceRoleInheritanceManager from '../../lambda/cedar/alliance-role-inheritance';

describe('Alliance Role Simple Tests', () => {
  const inheritanceManager = new AllianceRoleInheritanceManager();
  
  const testAlliance: AllianceContext = {
    allianceId: 'alliance123',
    isAtWar: false,
    isInActiveCombat: false,
    memberCount: 50,
    createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    currentLeader: 'player001',
    viceLeaders: ['player002'],
    officers: ['player003'],
    recentActions: []
  };
  
  const leader: AlliancePlayerEntity = {
    playerId: 'player001',
    allianceId: 'alliance123',
    role: ALLIANCE_ROLES.LEADER,
    roleAssignedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    roleAssignedBy: 'system',
    permissions: [],
    roleHistory: []
  };
  
  const member: AlliancePlayerEntity = {
    playerId: 'player005',
    allianceId: 'alliance123',
    role: ALLIANCE_ROLES.MEMBERS,
    roleAssignedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
    roleAssignedBy: 'player001',
    permissions: [],
    roleHistory: []
  };
  
  test('should allow simple leader promotion', () => {
    const result = inheritanceManager.canPromote(
      leader,
      member,
      ALLIANCE_ROLES.OFFICERS,
      testAlliance
    );
    
    console.log('Promotion result:', result);
    expect(result.allowed).toBe(true);
  });
  
  test('should check role hierarchy levels', () => {
    console.log('Leader level:', ROLE_HIERARCHY[ALLIANCE_ROLES.LEADER]);
    console.log('Officer level:', ROLE_HIERARCHY[ALLIANCE_ROLES.OFFICERS]);
    console.log('Member level:', ROLE_HIERARCHY[ALLIANCE_ROLES.MEMBERS]);
    
    expect(ROLE_HIERARCHY[ALLIANCE_ROLES.LEADER]).toBeGreaterThan(ROLE_HIERARCHY[ALLIANCE_ROLES.OFFICERS]);
    expect(ROLE_HIERARCHY[ALLIANCE_ROLES.OFFICERS]).toBeGreaterThan(ROLE_HIERARCHY[ALLIANCE_ROLES.MEMBERS]);
  });
});