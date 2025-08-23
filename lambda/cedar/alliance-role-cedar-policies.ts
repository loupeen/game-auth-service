/**
 * Alliance Role Cedar Policies
 * Issue #18: Alliance Role-Based Authorization System
 * 
 * This module contains the actual Cedar policy definitions for the alliance role system.
 * These policies implement hierarchical roles, inheritance, and complex authorization rules.
 */

import { ALLIANCE_ROLES, ROLE_HIERARCHY, PERMISSION_CATEGORIES } from './alliance-role-policies-schema';

// Alliance role inheritance policies
export const ALLIANCE_ROLE_CEDAR_POLICIES = {
  
  // ========================================
  // MEMBER MANAGEMENT POLICIES
  // ========================================
  
  ALLIANCE_LEADER_FULL_MEMBER_MANAGEMENT: `
permit (
  principal,
  action in [
    Action::"inviteMember",
    Action::"kickMember", 
    Action::"promoteMember",
    Action::"demoteMember",
    Action::"viewMemberDetails",
    Action::"manageMemberNotes"
  ],
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role == "leader"
};`,

  ALLIANCE_VICE_LEADER_MEMBER_MANAGEMENT: `
permit (
  principal,
  action in [
    Action::"inviteMember",
    Action::"kickMember",
    Action::"promoteMember", 
    Action::"demoteMember",
    Action::"viewMemberDetails",
    Action::"manageMemberNotes"
  ],
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role == "vice-leader"
};`,

  ALLIANCE_OFFICER_LIMITED_MEMBER_MANAGEMENT: `
permit (
  principal,
  action in [
    Action::"inviteMember",
    Action::"viewMemberDetails",
    Action::"manageMemberNotes"
  ],
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role == "officer"
};`,

  // Officers can kick members and recruits, but not other officers or higher
  ALLIANCE_OFFICER_KICK_LOWER_ROLES: `
permit (
  principal,
  action == Action::"kickMember",
  resource in Player
) when {
  principal has allianceId &&
  principal has role &&
  resource has allianceId &&
  resource has role &&
  principal.allianceId == resource.allianceId &&
  principal.role == "officer" &&
  resource.role in ["member", "recruit", "management-l3", "management-l2", "management-l1"]
};`,

  // Management L1 can invite and view member details
  ALLIANCE_MANAGEMENT_L1_PERMISSIONS: `
permit (
  principal,
  action in [
    Action::"inviteMember",
    Action::"viewMemberDetails"
  ],
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role == "management-l1"
};`,

  // ========================================
  // RESOURCE MANAGEMENT POLICIES  
  // ========================================

  ALLIANCE_TREASURY_ACCESS: `
permit (
  principal,
  action == Action::"accessTreasury",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader", "officer"]
};`,

  ALLIANCE_RESOURCE_DISTRIBUTION: `
permit (
  principal,
  action == Action::"distributeResources",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader", "officer", "management-l1"]
};`,

  ALLIANCE_RESOURCE_VIEWING: `
permit (
  principal,
  action == Action::"viewAllianceResources",
  resource in Alliance
) when {
  principal has allianceId &&
  resource has id &&
  principal.allianceId == resource.id
  // All alliance members can view resources
};`,

  // ========================================
  // ALLIANCE OPERATIONS POLICIES
  // ========================================

  ALLIANCE_WAR_DECLARATION: `
permit (
  principal,
  action == Action::"declareWar",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader"] &&
  // Additional context checks would go here for quorum requirements
  resource has isAtWar &&
  !resource.isAtWar // Cannot declare war if already at war
};`,

  ALLIANCE_PEACE_ACCEPTANCE: `
permit (
  principal,
  action == Action::"acceptPeace",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader"] &&
  resource has isAtWar &&
  resource.isAtWar // Can only accept peace if at war
};`,

  ALLIANCE_SETTINGS_MANAGEMENT: `
permit (
  principal,
  action == Action::"changeAllianceSettings",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader", "officer"]
};`,

  // ========================================
  // COMMUNICATION POLICIES
  // ========================================

  ALLIANCE_CHAT_MODERATION: `
permit (
  principal,
  action == Action::"moderateChat",
  resource in ChatChannel
) when {
  principal has allianceId &&
  principal has role &&
  resource has allianceId &&
  principal.allianceId == resource.allianceId &&
  principal.role in ["leader", "vice-leader", "officer", "management-l1", "management-l2", "management-l3"]
};`,

  ALLIANCE_ANNOUNCEMENTS: `
permit (
  principal,
  action == Action::"sendAnnouncement",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader", "officer", "management-l1"]
};`,

  // ========================================
  // MILITARY AND STRATEGIC POLICIES
  // ========================================

  ALLIANCE_MILITARY_COORDINATION: `
permit (
  principal,
  action in [
    Action::"coordinateAttacks",
    Action::"planDefenses"
  ],
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader", "officer", "management-l1", "management-l2"]
};`,

  ALLIANCE_BATTLE_PLANS_ACCESS: `
permit (
  principal,
  action == Action::"accessBattlePlans",
  resource in Alliance
) when {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  principal.allianceId == resource.id &&
  principal.role in ["leader", "vice-leader", "officer", "management-l1", "management-l2", "management-l3", "member"]
  // Recruits cannot access battle plans
};`,

  // Remote control is highly restricted
  ALLIANCE_REMOTE_CONTROL: `
permit (
  principal,
  action == Action::"remoteControlMember",
  resource in Player
) when {
  principal has allianceId &&
  principal has role &&
  resource has allianceId &&
  resource has role &&
  resource has consentGiven &&
  principal.allianceId == resource.allianceId &&
  principal.role in ["leader", "vice-leader"] &&
  resource.consentGiven == true &&
  // Additional temporal and context restrictions would be enforced here
  resource.role in ["member", "recruit", "management-l3", "management-l2"] // Cannot remote control high-ranking members
};`,

  // ========================================
  // ROLE TRANSITION POLICIES
  // ========================================

  ALLIANCE_ROLE_PROMOTION_LEADER: `
permit (
  principal,
  action == Action::"promoteMember",
  resource in Player
) when {
  principal has allianceId &&
  principal has role &&
  resource has allianceId &&
  resource has role &&
  resource has targetRole &&
  principal.allianceId == resource.allianceId &&
  principal.role == "leader"
  // Leaders can promote anyone to any role (except leader)
  // Additional validation for role hierarchy and cooldowns would be in business logic
};`,

  ALLIANCE_ROLE_PROMOTION_HIERARCHY: `
permit (
  principal,
  action == Action::"promoteMember", 
  resource in Player
) when {
  principal has allianceId &&
  principal has role &&
  principal has roleLevel &&
  resource has allianceId &&
  resource has role &&
  resource has targetRole &&
  resource has targetRoleLevel &&
  principal.allianceId == resource.allianceId &&
  principal.roleLevel > resource.targetRoleLevel &&
  principal.roleLevel > 5 // Only officer level and above can promote
  // Can only promote to roles below your own level
};`,

  // ========================================
  // LEADERSHIP TRANSFER POLICIES
  // ========================================

  ALLIANCE_LEADERSHIP_TRANSFER: `
forbid (
  principal,
  action == Action::"transferLeadership",
  resource in Alliance
) unless {
  principal has allianceId &&
  principal has role &&
  resource has id &&
  resource has quorumApproval &&
  principal.allianceId == resource.id &&
  principal.role == "leader" &&
  resource.quorumApproval == true
  // Leadership transfer requires quorum approval from officers
};`,

  // ========================================
  // EMERGENCY AND TEMPORAL POLICIES
  // ========================================

  ALLIANCE_COMBAT_LOCKDOWN: `
forbid (
  principal,
  action in [
    Action::"transferLeadership",
    Action::"disbandAlliance", 
    Action::"massKickMembers"
  ],
  resource
) when {
  resource has allianceId &&
  resource has isInActiveCombat &&
  resource.isInActiveCombat == true
  // Critical actions forbidden during active combat
};`,

  ALLIANCE_EMERGENCY_OVERRIDE: `
permit (
  principal,
  action == Action::"emergencyOverride",
  resource
) when {
  principal has allianceId &&
  principal has role &&
  principal has emergencyCode &&
  resource has allianceId &&
  principal.allianceId == resource.allianceId &&
  principal.role == "leader" &&
  principal.emergencyCode != "" // Emergency code must be provided
  // Emergency overrides have separate audit and time restrictions
};`,

  // ========================================
  // SEPARATION OF DUTIES POLICIES
  // ========================================

  ALLIANCE_DUAL_CONTROL_TREASURY: `
forbid (
  principal,
  action == Action::"withdrawLargeTreasury",
  resource
) unless {
  resource has approvedBy &&
  resource has approvalCount &&
  resource.approvalCount >= 2 &&
  // Must have approval from at least 2 high-ranking members
  resource has approverRoles &&
  resource.approverRoles contains "leader" ||
  resource.approverRoles contains "vice-leader"
};`,

  ALLIANCE_DUAL_CONTROL_OFFICER_KICK: `
forbid (
  principal,
  action == Action::"kickMember",
  resource in Player
) when {
  resource has role &&
  resource has approvalCount &&
  resource.role in ["officer", "vice-leader"] &&
  (resource.approvalCount == null || resource.approvalCount < 2)
  // Kicking officers or vice leaders requires dual approval
};`

};

// Policy categories for organization
export const ALLIANCE_POLICY_CATEGORIES = {
  MEMBER_MANAGEMENT: [
    'ALLIANCE_LEADER_FULL_MEMBER_MANAGEMENT',
    'ALLIANCE_VICE_LEADER_MEMBER_MANAGEMENT', 
    'ALLIANCE_OFFICER_LIMITED_MEMBER_MANAGEMENT',
    'ALLIANCE_OFFICER_KICK_LOWER_ROLES',
    'ALLIANCE_MANAGEMENT_L1_PERMISSIONS'
  ],
  
  RESOURCE_MANAGEMENT: [
    'ALLIANCE_TREASURY_ACCESS',
    'ALLIANCE_RESOURCE_DISTRIBUTION',
    'ALLIANCE_RESOURCE_VIEWING'
  ],
  
  ALLIANCE_OPERATIONS: [
    'ALLIANCE_WAR_DECLARATION',
    'ALLIANCE_PEACE_ACCEPTANCE', 
    'ALLIANCE_SETTINGS_MANAGEMENT'
  ],
  
  COMMUNICATION: [
    'ALLIANCE_CHAT_MODERATION',
    'ALLIANCE_ANNOUNCEMENTS'
  ],
  
  MILITARY: [
    'ALLIANCE_MILITARY_COORDINATION',
    'ALLIANCE_BATTLE_PLANS_ACCESS',
    'ALLIANCE_REMOTE_CONTROL'
  ],
  
  ROLE_TRANSITIONS: [
    'ALLIANCE_ROLE_PROMOTION_LEADER',
    'ALLIANCE_ROLE_PROMOTION_HIERARCHY',
    'ALLIANCE_LEADERSHIP_TRANSFER'
  ],
  
  EMERGENCY_CONTROLS: [
    'ALLIANCE_COMBAT_LOCKDOWN',
    'ALLIANCE_EMERGENCY_OVERRIDE'
  ],
  
  SEPARATION_OF_DUTIES: [
    'ALLIANCE_DUAL_CONTROL_TREASURY',
    'ALLIANCE_DUAL_CONTROL_OFFICER_KICK'
  ]
};

// Priority levels for policy evaluation (higher = evaluated first)
export const ALLIANCE_POLICY_PRIORITIES: Record<string, number> = {
  // Emergency controls have highest priority
  'ALLIANCE_COMBAT_LOCKDOWN': 100,
  'ALLIANCE_EMERGENCY_OVERRIDE': 95,
  
  // Separation of duties
  'ALLIANCE_DUAL_CONTROL_TREASURY': 90,
  'ALLIANCE_DUAL_CONTROL_OFFICER_KICK': 85,
  
  // Leadership and critical operations
  'ALLIANCE_LEADERSHIP_TRANSFER': 80,
  'ALLIANCE_WAR_DECLARATION': 75,
  'ALLIANCE_PEACE_ACCEPTANCE': 75,
  
  // Member management (varies by role)
  'ALLIANCE_LEADER_FULL_MEMBER_MANAGEMENT': 70,
  'ALLIANCE_VICE_LEADER_MEMBER_MANAGEMENT': 65,
  'ALLIANCE_OFFICER_LIMITED_MEMBER_MANAGEMENT': 60,
  'ALLIANCE_OFFICER_KICK_LOWER_ROLES': 60,
  
  // Role transitions
  'ALLIANCE_ROLE_PROMOTION_LEADER': 55,
  'ALLIANCE_ROLE_PROMOTION_HIERARCHY': 50,
  
  // Military operations
  'ALLIANCE_MILITARY_COORDINATION': 45,
  'ALLIANCE_REMOTE_CONTROL': 45,
  'ALLIANCE_BATTLE_PLANS_ACCESS': 40,
  
  // Resource management
  'ALLIANCE_TREASURY_ACCESS': 35,
  'ALLIANCE_RESOURCE_DISTRIBUTION': 30,
  'ALLIANCE_RESOURCE_VIEWING': 25,
  
  // Communications and settings
  'ALLIANCE_CHAT_MODERATION': 20,
  'ALLIANCE_ANNOUNCEMENTS': 15,
  'ALLIANCE_SETTINGS_MANAGEMENT': 15,
  
  // Basic permissions
  'ALLIANCE_MANAGEMENT_L1_PERMISSIONS': 10
};

export default {
  ALLIANCE_ROLE_CEDAR_POLICIES,
  ALLIANCE_POLICY_CATEGORIES,
  ALLIANCE_POLICY_PRIORITIES
};