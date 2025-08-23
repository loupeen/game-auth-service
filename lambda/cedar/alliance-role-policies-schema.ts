/**
 * Alliance Role-Based Authorization System
 * Issue #18: Alliance Role-Based Authorization System
 * 
 * This module defines the hierarchical alliance role system with Cedar policies
 * for member management, resource operations, and critical alliance decisions.
 */

// Alliance Role Hierarchy (from highest to lowest authority)
export const ALLIANCE_ROLES = {
  // Supreme authority - can do anything in the alliance
  LEADER: 'leader',
  
  // Second in command - most leader privileges except leadership transfer
  VICE_LEADER: 'vice-leader',
  
  // Senior management - tactical and operational authority
  OFFICERS: 'officer',
  
  // Management tiers with specific responsibilities
  MANAGEMENT_L1: 'management-l1', // Resource and recruitment management
  MANAGEMENT_L2: 'management-l2', // Basic member management
  MANAGEMENT_L3: 'management-l3', // Limited operational permissions
  
  // Standard members with basic permissions
  MEMBERS: 'member',
  
  // New recruits with restricted permissions
  RECRUITS: 'recruit'
} as const;

export type AllianceRole = typeof ALLIANCE_ROLES[keyof typeof ALLIANCE_ROLES];

// Role hierarchy levels (higher number = higher authority)
export const ROLE_HIERARCHY: Record<AllianceRole, number> = {
  [ALLIANCE_ROLES.LEADER]: 8,
  [ALLIANCE_ROLES.VICE_LEADER]: 7,
  [ALLIANCE_ROLES.OFFICERS]: 6,
  [ALLIANCE_ROLES.MANAGEMENT_L1]: 5,
  [ALLIANCE_ROLES.MANAGEMENT_L2]: 4,
  [ALLIANCE_ROLES.MANAGEMENT_L3]: 3,
  [ALLIANCE_ROLES.MEMBERS]: 2,
  [ALLIANCE_ROLES.RECRUITS]: 1
};

// Permission categories for alliance operations
export const PERMISSION_CATEGORIES = {
  // Member Management Permissions
  MEMBER_MANAGEMENT: {
    INVITE_MEMBERS: 'member.invite',
    KICK_MEMBERS: 'member.kick',
    PROMOTE_MEMBERS: 'member.promote',
    DEMOTE_MEMBERS: 'member.demote',
    VIEW_MEMBER_DETAILS: 'member.view-details',
    MANAGE_MEMBER_NOTES: 'member.manage-notes'
  },
  
  // Resource Management Permissions
  RESOURCE_MANAGEMENT: {
    VIEW_ALLIANCE_RESOURCES: 'resource.view',
    DISTRIBUTE_RESOURCES: 'resource.distribute',
    MANAGE_RESOURCE_REQUESTS: 'resource.manage-requests',
    ACCESS_TREASURY: 'resource.treasury',
    APPROVE_DONATIONS: 'resource.approve-donations'
  },
  
  // Alliance Operations Permissions
  ALLIANCE_OPERATIONS: {
    DECLARE_WAR: 'operation.declare-war',
    ACCEPT_PEACE: 'operation.accept-peace',
    FORM_ALLIANCES: 'operation.form-alliances',
    BREAK_ALLIANCES: 'operation.break-alliances',
    CHANGE_ALLIANCE_SETTINGS: 'operation.change-settings',
    MANAGE_ALLIANCE_DESCRIPTION: 'operation.manage-description',
    SET_ALLIANCE_GOALS: 'operation.set-goals'
  },
  
  // Communication and Social Permissions
  COMMUNICATION: {
    MODERATE_CHAT: 'communication.moderate-chat',
    SEND_ANNOUNCEMENTS: 'communication.send-announcements',
    MANAGE_ALLIANCE_MAIL: 'communication.manage-mail',
    REPRESENT_ALLIANCE: 'communication.represent'
  },
  
  // Strategic and Military Permissions
  MILITARY: {
    COORDINATE_ATTACKS: 'military.coordinate-attacks',
    PLAN_DEFENSES: 'military.plan-defenses',
    ASSIGN_MILITARY_ROLES: 'military.assign-roles',
    ACCESS_BATTLE_PLANS: 'military.access-plans',
    REMOTE_CONTROL_MEMBERS: 'military.remote-control'
  }
} as const;

// Role permission mappings
export const ROLE_PERMISSIONS: Record<AllianceRole, string[]> = {
  [ALLIANCE_ROLES.LEADER]: [
    // Full access to everything
    ...Object.values(PERMISSION_CATEGORIES.MEMBER_MANAGEMENT),
    ...Object.values(PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT),
    ...Object.values(PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS),
    ...Object.values(PERMISSION_CATEGORIES.COMMUNICATION),
    ...Object.values(PERMISSION_CATEGORIES.MILITARY),
    // Leader-only permissions
    'leadership.transfer',
    'leadership.disband-alliance',
    'leadership.emergency-override'
  ],
  
  [ALLIANCE_ROLES.VICE_LEADER]: [
    // Most leader permissions except leadership transfer
    ...Object.values(PERMISSION_CATEGORIES.MEMBER_MANAGEMENT),
    ...Object.values(PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT),
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.DECLARE_WAR,
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.ACCEPT_PEACE,
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.CHANGE_ALLIANCE_SETTINGS,
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.MANAGE_ALLIANCE_DESCRIPTION,
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.SET_ALLIANCE_GOALS,
    ...Object.values(PERMISSION_CATEGORIES.COMMUNICATION),
    ...Object.values(PERMISSION_CATEGORIES.MILITARY)
  ],
  
  [ALLIANCE_ROLES.OFFICERS]: [
    // Senior management permissions
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.INVITE_MEMBERS,
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.KICK_MEMBERS,
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.VIEW_MEMBER_DETAILS,
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.MANAGE_MEMBER_NOTES,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.VIEW_ALLIANCE_RESOURCES,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.DISTRIBUTE_RESOURCES,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.MANAGE_RESOURCE_REQUESTS,
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.CHANGE_ALLIANCE_SETTINGS,
    PERMISSION_CATEGORIES.ALLIANCE_OPERATIONS.MANAGE_ALLIANCE_DESCRIPTION,
    ...Object.values(PERMISSION_CATEGORIES.COMMUNICATION),
    ...Object.values(PERMISSION_CATEGORIES.MILITARY)
  ],
  
  [ALLIANCE_ROLES.MANAGEMENT_L1]: [
    // Resource and recruitment focus
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.INVITE_MEMBERS,
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.VIEW_MEMBER_DETAILS,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.VIEW_ALLIANCE_RESOURCES,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.MANAGE_RESOURCE_REQUESTS,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.APPROVE_DONATIONS,
    PERMISSION_CATEGORIES.COMMUNICATION.MODERATE_CHAT,
    PERMISSION_CATEGORIES.COMMUNICATION.SEND_ANNOUNCEMENTS,
    PERMISSION_CATEGORIES.MILITARY.COORDINATE_ATTACKS,
    PERMISSION_CATEGORIES.MILITARY.PLAN_DEFENSES
  ],
  
  [ALLIANCE_ROLES.MANAGEMENT_L2]: [
    // Basic member management
    PERMISSION_CATEGORIES.MEMBER_MANAGEMENT.VIEW_MEMBER_DETAILS,
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.VIEW_ALLIANCE_RESOURCES,
    PERMISSION_CATEGORIES.COMMUNICATION.MODERATE_CHAT,
    PERMISSION_CATEGORIES.MILITARY.COORDINATE_ATTACKS,
    PERMISSION_CATEGORIES.MILITARY.ACCESS_BATTLE_PLANS
  ],
  
  [ALLIANCE_ROLES.MANAGEMENT_L3]: [
    // Limited operational permissions
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.VIEW_ALLIANCE_RESOURCES,
    PERMISSION_CATEGORIES.COMMUNICATION.MODERATE_CHAT,
    PERMISSION_CATEGORIES.MILITARY.ACCESS_BATTLE_PLANS
  ],
  
  [ALLIANCE_ROLES.MEMBERS]: [
    // Standard member permissions
    PERMISSION_CATEGORIES.RESOURCE_MANAGEMENT.VIEW_ALLIANCE_RESOURCES,
    PERMISSION_CATEGORIES.MILITARY.ACCESS_BATTLE_PLANS
  ],
  
  [ALLIANCE_ROLES.RECRUITS]: [
    // Minimal permissions for new members
    'basic.view-alliance-info',
    'basic.participate-in-chat'
  ]
};

// Role transition constraints and rules
export const ROLE_TRANSITION_RULES = {
  // Maximum role changes per time period
  MAX_PROMOTIONS_PER_DAY: {
    [ALLIANCE_ROLES.LEADER]: 3,
    [ALLIANCE_ROLES.VICE_LEADER]: 5,
    [ALLIANCE_ROLES.OFFICERS]: 10,
    [ALLIANCE_ROLES.MANAGEMENT_L1]: 15,
    [ALLIANCE_ROLES.MANAGEMENT_L2]: 20,
    [ALLIANCE_ROLES.MANAGEMENT_L3]: 25
  },
  
  // Cooldown periods between role changes (in hours)
  ROLE_CHANGE_COOLDOWNS: {
    PROMOTION: 24, // 24 hours between promotions for same player
    DEMOTION: 48,  // 48 hours between demotions for same player
    LEADERSHIP_TRANSFER: 168 // 1 week cooldown for leadership changes
  },
  
  // Minimum time in current role before next change (in hours)
  MINIMUM_ROLE_DURATION: {
    [ALLIANCE_ROLES.RECRUITS]: 24,      // 1 day minimum as recruit
    [ALLIANCE_ROLES.MEMBERS]: 72,       // 3 days minimum as member
    [ALLIANCE_ROLES.MANAGEMENT_L3]: 120, // 5 days minimum as L3
    [ALLIANCE_ROLES.MANAGEMENT_L2]: 168, // 1 week minimum as L2
    [ALLIANCE_ROLES.MANAGEMENT_L1]: 240, // 10 days minimum as L1
    [ALLIANCE_ROLES.OFFICERS]: 336,     // 2 weeks minimum as officer
    [ALLIANCE_ROLES.VICE_LEADER]: 504,  // 3 weeks minimum as vice leader
    [ALLIANCE_ROLES.LEADER]: 0          // No minimum (can transfer immediately if needed)
  }
};

// Quorum requirements for critical decisions
export const QUORUM_REQUIREMENTS = {
  // War declarations require multiple high-level approvals
  DECLARE_WAR: {
    minimumVoters: 2,
    requiredRoles: [ALLIANCE_ROLES.LEADER, ALLIANCE_ROLES.VICE_LEADER, ALLIANCE_ROLES.OFFICERS],
    votingPeriodHours: 24,
    approvalThreshold: 0.6 // 60% approval required
  },
  
  // Peace agreements
  ACCEPT_PEACE: {
    minimumVoters: 2,
    requiredRoles: [ALLIANCE_ROLES.LEADER, ALLIANCE_ROLES.VICE_LEADER],
    votingPeriodHours: 12,
    approvalThreshold: 0.5 // Simple majority
  },
  
  // Leadership transfers require broad support
  LEADERSHIP_TRANSFER: {
    minimumVoters: 3,
    requiredRoles: [ALLIANCE_ROLES.VICE_LEADER, ALLIANCE_ROLES.OFFICERS],
    votingPeriodHours: 72, // 3 days to vote
    approvalThreshold: 0.66 // 2/3 majority required
  },
  
  // Alliance disbanding requires unanimous leadership approval
  DISBAND_ALLIANCE: {
    minimumVoters: 5,
    requiredRoles: [ALLIANCE_ROLES.LEADER, ALLIANCE_ROLES.VICE_LEADER, ALLIANCE_ROLES.OFFICERS],
    votingPeriodHours: 168, // 1 week to vote
    approvalThreshold: 1.0 // Unanimous
  }
};

// Separation of duties controls
export const SEPARATION_OF_DUTIES = {
  // Actions that cannot be performed by a single person
  DUAL_CONTROL_REQUIRED: [
    'resource.treasury.withdraw-large', // Large treasury withdrawals
    'member.kick.officer-or-above',     // Kicking officers or above
    'operation.disband-alliance',       // Alliance disbanding
    'leadership.emergency-override'     // Emergency overrides
  ],
  
  // Time-based restrictions
  TEMPORAL_RESTRICTIONS: {
    // No major changes during active combat
    COMBAT_LOCKDOWN_ACTIONS: [
      'leadership.transfer',
      'operation.disband-alliance',
      'member.kick.mass' // Mass member kicks
    ],
    
    // Enhanced approval during peak hours
    PEAK_HOURS_ENHANCED_APPROVAL: {
      startHour: 18, // 6 PM
      endHour: 23,   // 11 PM
      timezone: 'UTC',
      enhancedActions: [
        'operation.declare-war',
        'leadership.transfer'
      ]
    }
  }
};

// Alliance context for authorization decisions
export interface AllianceContext {
  allianceId: string;
  isAtWar: boolean;
  isInActiveCombat: boolean;
  memberCount: number;
  createdAt: number;
  lastLeadershipChange?: number;
  currentLeader: string;
  viceLeaders: string[];
  officers: string[];
  recentActions: Array<{
    action: string;
    actor: string;
    timestamp: number;
    target?: string;
  }>;
}

// Enhanced player entity with role information
export interface AlliancePlayerEntity {
  playerId: string;
  allianceId: string;
  role: AllianceRole;
  roleAssignedAt: number;
  roleAssignedBy: string;
  permissions: string[];
  lastRoleChange?: number;
  roleHistory: Array<{
    role: AllianceRole;
    assignedAt: number;
    assignedBy: string;
    reason?: string;
  }>;
}

// Vote tracking for quorum decisions
export interface QuorumVote {
  voteId: string;
  allianceId: string;
  action: string;
  initiatedBy: string;
  initiatedAt: number;
  votingEndsAt: number;
  requiredVoters: number;
  requiredRoles: AllianceRole[];
  approvalThreshold: number;
  votes: Array<{
    voterId: string;
    voterRole: AllianceRole;
    vote: 'approve' | 'deny' | 'abstain';
    votedAt: number;
    reason?: string;
  }>;
  status: 'active' | 'passed' | 'failed' | 'expired';
  finalizedAt?: number;
}

export default {
  ALLIANCE_ROLES,
  ROLE_HIERARCHY,
  PERMISSION_CATEGORIES,
  ROLE_PERMISSIONS,
  ROLE_TRANSITION_RULES,
  QUORUM_REQUIREMENTS,
  SEPARATION_OF_DUTIES
};