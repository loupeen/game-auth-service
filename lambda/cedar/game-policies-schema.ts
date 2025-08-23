/**
 * Cedar Policy Schema for Basic Game Actions
 * Issue #17: Cedar Authorization Policies for Basic Game Actions
 * 
 * This file defines the core policy schema for:
 * - Players, Alliances, Resources, Actions
 * - Basic player permissions (profile access, resource viewing, alliance chat)
 * - Resource access policies (public vs alliance-only resources)
 * - Action authorization (combat, trading, building)
 */

// Entity type definitions for Cedar schema
export interface GameEntityTypes {
  Player: {
    playerId: string;
    allianceId?: string;
    status: 'active' | 'inactive' | 'suspended';
    role: 'member' | 'officer' | 'leader' | 'vice-leader';
    level: number;
    joinedAt: number;
    lastActiveAt: number;
  };
  
  Alliance: {
    allianceId: string;
    name: string;
    leaderId: string;
    status: 'active' | 'inactive';
    memberCount: number;
    maxMembers: number;
    createdAt: number;
    isPublic: boolean;
  };
  
  Resource: {
    resourceId: string;
    resourceType: 'gold' | 'oil' | 'steel' | 'food' | 'ammunition';
    ownerId: string;
    ownerType: 'player' | 'alliance';
    visibility: 'public' | 'alliance' | 'private';
    amount: number;
    location?: string;
  };
  
  Base: {
    baseId: string;
    playerId: string;
    allianceId?: string;
    level: number;
    coordinates: string;
    isHeadquarters: boolean;
    defenseRating: number;
    status: 'active' | 'under-attack' | 'destroyed';
  };
  
  ChatChannel: {
    channelId: string;
    channelType: 'alliance' | 'global' | 'private';
    allianceId?: string;
    participants?: string[];
    isModerated: boolean;
  };
}

// Action type definitions
export interface GameActionTypes {
  // Profile and basic access
  'Action::"viewProfile"': { targetPlayerId: string };
  'Action::"editProfile"': { targetPlayerId: string };
  'Action::"viewResources"': { targetPlayerId: string };
  
  // Alliance chat
  'Action::"sendAllianceMessage"': { allianceId: string; channelId: string };
  'Action::"viewAllianceChat"': { allianceId: string; channelId: string };
  'Action::"moderateChat"': { allianceId: string; channelId: string };
  
  // Resource management
  'Action::"viewAllianceResources"': { allianceId: string };
  'Action::"donateResources"': { allianceId: string; resourceType: string };
  'Action::"requestResources"': { allianceId: string; resourceType: string };
  
  // Combat actions
  'Action::"attackBase"': { targetBaseId: string; attackerBaseId: string };
  'Action::"defendBase"': { baseId: string };
  'Action::"scout"': { targetBaseId: string };
  
  // Trading actions
  'Action::"createTrade"': { resourceType: string; amount: number };
  'Action::"acceptTrade"': { tradeId: string };
  'Action::"cancelTrade"': { tradeId: string };
  
  // Building actions
  'Action::"upgradeBase"': { baseId: string };
  'Action::"buildStructure"': { baseId: string; structureType: string };
  'Action::"demolishStructure"': { baseId: string; structureId: string };
}

// Cedar policy templates for basic game actions
export const BASIC_GAME_POLICIES = {
  // Basic player permissions - players can always access their own profile
  PLAYER_OWN_PROFILE: `
    permit (
      principal == Player::"{{ playerId }}",
      action in [Action::"viewProfile", Action::"editProfile"],
      resource == Player::"{{ playerId }}"
    );
  `,
  
  // Players can view their own resources
  PLAYER_OWN_RESOURCES: `
    permit (
      principal == Player::"{{ playerId }}",
      action == Action::"viewResources",
      resource == Player::"{{ playerId }}"
    ) when {
      principal.status == "active"
    };
  `,
  
  // Alliance member basic permissions
  ALLIANCE_MEMBER_CHAT: `
    permit (
      principal in Player,
      action in [Action::"sendAllianceMessage", Action::"viewAllianceChat"],
      resource in ChatChannel
    ) when {
      principal.allianceId == resource.allianceId &&
      principal.status == "active" &&
      resource.channelType == "alliance"
    };
  `,
  
  // Alliance officers can moderate chat
  ALLIANCE_OFFICER_MODERATE: `
    permit (
      principal in Player,
      action == Action::"moderateChat",
      resource in ChatChannel
    ) when {
      principal.allianceId == resource.allianceId &&
      principal.role in ["officer", "leader", "vice-leader"] &&
      resource.channelType == "alliance"
    };
  `,
  
  // Alliance members can view alliance resources
  ALLIANCE_RESOURCE_VIEW: `
    permit (
      principal in Player,
      action == Action::"viewAllianceResources",
      resource in Alliance
    ) when {
      principal.allianceId == resource.allianceId &&
      principal.status == "active"
    };
  `,
  
  // Players can donate resources to their alliance
  ALLIANCE_RESOURCE_DONATE: `
    permit (
      principal in Player,
      action == Action::"donateResources",
      resource in Alliance
    ) when {
      principal.allianceId == resource.allianceId &&
      principal.status == "active" &&
      principal.level >= 5
    };
  `,
  
  // Combat permissions - players can attack if they meet requirements
  COMBAT_ATTACK_BASE: `
    permit (
      principal in Player,
      action == Action::"attackBase",
      resource in Base
    ) when {
      principal.status == "active" &&
      principal.level >= 10 &&
      resource.status == "active" &&
      principal.allianceId != resource.allianceId
    };
  `,
  
  // Players can always defend their own bases
  COMBAT_DEFEND_BASE: `
    permit (
      principal in Player,
      action == Action::"defendBase",
      resource in Base
    ) when {
      principal.playerId == resource.playerId &&
      principal.status == "active"
    };
  `,
  
  // Alliance members can defend alliance bases
  COMBAT_DEFEND_ALLIANCE_BASE: `
    permit (
      principal in Player,
      action == Action::"defendBase",
      resource in Base
    ) when {
      principal.allianceId == resource.allianceId &&
      principal.status == "active" &&
      resource.status != "destroyed"
    };
  `,
  
  // Trading permissions - active players can create trades
  TRADE_CREATE: `
    permit (
      principal in Player,
      action == Action::"createTrade",
      resource in Resource
    ) when {
      principal.status == "active" &&
      principal.level >= 3 &&
      resource.ownerId == principal.playerId
    };
  `,
  
  // Players can accept public trades
  TRADE_ACCEPT_PUBLIC: `
    permit (
      principal in Player,
      action == Action::"acceptTrade",
      resource in Resource
    ) when {
      principal.status == "active" &&
      resource.visibility == "public" &&
      resource.ownerId != principal.playerId
    };
  `,
  
  // Building permissions - players can upgrade their own bases
  BUILD_UPGRADE_OWN: `
    permit (
      principal in Player,
      action in [Action::"upgradeBase", Action::"buildStructure"],
      resource in Base
    ) when {
      principal.playerId == resource.playerId &&
      principal.status == "active" &&
      resource.status == "active"
    };
  `,
  
  // Public resource access - anyone can view public resources
  PUBLIC_RESOURCE_VIEW: `
    permit (
      principal in Player,
      action == Action::"viewResources",
      resource in Resource
    ) when {
      principal.status == "active" &&
      resource.visibility == "public"
    };
  `,
  
  // Alliance-only resource access
  ALLIANCE_RESOURCE_ACCESS: `
    permit (
      principal in Player,
      action == Action::"viewResources",
      resource in Resource
    ) when {
      principal.status == "active" &&
      resource.visibility == "alliance" &&
      principal.allianceId == resource.ownerId
    };
  `
};

// Policy categories for organization
export const POLICY_CATEGORIES = {
  PLAYER_BASIC: ['PLAYER_OWN_PROFILE', 'PLAYER_OWN_RESOURCES'],
  ALLIANCE_SOCIAL: ['ALLIANCE_MEMBER_CHAT', 'ALLIANCE_OFFICER_MODERATE'],
  ALLIANCE_RESOURCES: ['ALLIANCE_RESOURCE_VIEW', 'ALLIANCE_RESOURCE_DONATE'],
  COMBAT: ['COMBAT_ATTACK_BASE', 'COMBAT_DEFEND_BASE', 'COMBAT_DEFEND_ALLIANCE_BASE'],
  TRADING: ['TRADE_CREATE', 'TRADE_ACCEPT_PUBLIC'],
  BUILDING: ['BUILD_UPGRADE_OWN'],
  RESOURCE_ACCESS: ['PUBLIC_RESOURCE_VIEW', 'ALLIANCE_RESOURCE_ACCESS']
};

// Policy priorities for evaluation order
export const POLICY_PRIORITIES = {
  PLAYER_OWN_PROFILE: 100,
  PLAYER_OWN_RESOURCES: 100,
  ALLIANCE_MEMBER_CHAT: 90,
  ALLIANCE_OFFICER_MODERATE: 95,
  ALLIANCE_RESOURCE_VIEW: 80,
  ALLIANCE_RESOURCE_DONATE: 70,
  COMBAT_ATTACK_BASE: 60,
  COMBAT_DEFEND_BASE: 100,
  COMBAT_DEFEND_ALLIANCE_BASE: 90,
  TRADE_CREATE: 50,
  TRADE_ACCEPT_PUBLIC: 50,
  BUILD_UPGRADE_OWN: 80,
  PUBLIC_RESOURCE_VIEW: 30,
  ALLIANCE_RESOURCE_ACCESS: 40
};

// Default context attributes for policy evaluation
export const DEFAULT_CONTEXT = {
  serverTime: Date.now(),
  gameVersion: '1.0.0',
  maintenanceMode: false,
  eventActive: false
};