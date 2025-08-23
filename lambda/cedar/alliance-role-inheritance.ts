/**
 * Alliance Role Inheritance System
 * Issue #18: Alliance Role-Based Authorization System
 * 
 * This module implements role inheritance logic, validation, and business rules
 * for the alliance role hierarchy system.
 */

import {
  ALLIANCE_ROLES,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS,
  ROLE_TRANSITION_RULES,
  QUORUM_REQUIREMENTS,
  SEPARATION_OF_DUTIES,
  AllianceRole,
  AllianceContext,
  AlliancePlayerEntity,
  QuorumVote
} from './alliance-role-policies-schema';

export class AllianceRoleInheritanceManager {
  
  /**
   * Check if a role has specific permission (with inheritance)
   */
  public hasPermission(role: AllianceRole, permission: string): boolean {
    // Direct permission check
    if (ROLE_PERMISSIONS[role]?.includes(permission)) {
      return true;
    }
    
    // Check inherited permissions from lower roles
    const currentRoleLevel = ROLE_HIERARCHY[role];
    
    for (const [checkRole, checkLevel] of Object.entries(ROLE_HIERARCHY)) {
      if (checkLevel < currentRoleLevel) {
        // This is a lower role, check if it has the permission
        if (ROLE_PERMISSIONS[checkRole as AllianceRole]?.includes(permission)) {
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Get all permissions for a role (including inherited)
   */
  public getAllPermissions(role: AllianceRole): string[] {
    const permissions = new Set<string>();
    const currentRoleLevel = ROLE_HIERARCHY[role];
    
    // Add all permissions from current role and lower roles
    for (const [checkRole, checkLevel] of Object.entries(ROLE_HIERARCHY)) {
      if (checkLevel <= currentRoleLevel) {
        const rolePermissions = ROLE_PERMISSIONS[checkRole as AllianceRole] || [];
        rolePermissions.forEach(permission => permissions.add(permission));
      }
    }
    
    return Array.from(permissions);
  }
  
  /**
   * Validate if a role transition is allowed
   */
  public canPromote(
    promoter: AlliancePlayerEntity,
    target: AlliancePlayerEntity,
    targetRole: AllianceRole,
    context: AllianceContext
  ): { allowed: boolean; reason?: string } {
    
    // Basic hierarchy check
    const promoterLevel = ROLE_HIERARCHY[promoter.role];
    const targetCurrentLevel = ROLE_HIERARCHY[target.role];
    const targetNewLevel = ROLE_HIERARCHY[targetRole];
    
    // Promoter must have higher authority than target's new role
    if (promoterLevel <= targetNewLevel) {
      return {
        allowed: false,
        reason: `Insufficient authority: ${promoter.role} cannot promote to ${targetRole}`
      };
    }
    
    // Cannot promote to same or higher level than promoter (except leader can promote to any role except leader)
    if (promoter.role !== ALLIANCE_ROLES.LEADER && promoterLevel <= targetNewLevel) {
      return {
        allowed: false,
        reason: `Cannot promote above your own authority level`
      };
    }
    
    // Check minimum role duration
    const minimumDuration = ROLE_TRANSITION_RULES.MINIMUM_ROLE_DURATION[target.role] || 0;
    const timeInCurrentRole = Date.now() - target.roleAssignedAt;
    const requiredTime = minimumDuration * 60 * 60 * 1000; // Convert hours to milliseconds
    
    if (timeInCurrentRole < requiredTime) {
      const remainingHours = Math.ceil((requiredTime - timeInCurrentRole) / (60 * 60 * 1000));
      return {
        allowed: false,
        reason: `Player must remain in ${target.role} for ${remainingHours} more hours`
      };
    }
    
    // Check promotion cooldown
    if (target.lastRoleChange) {
      const cooldownPeriod = ROLE_TRANSITION_RULES.ROLE_CHANGE_COOLDOWNS.PROMOTION * 60 * 60 * 1000;
      const timeSinceLastChange = Date.now() - target.lastRoleChange;
      
      if (timeSinceLastChange < cooldownPeriod) {
        const remainingHours = Math.ceil((cooldownPeriod - timeSinceLastChange) / (60 * 60 * 1000));
        return {
          allowed: false,
          reason: `Promotion cooldown: ${remainingHours} hours remaining`
        };
      }
    }
    
    // Check daily promotion limits
    const maxPromotions = ROLE_TRANSITION_RULES.MAX_PROMOTIONS_PER_DAY[promoter.role as keyof typeof ROLE_TRANSITION_RULES.MAX_PROMOTIONS_PER_DAY] || 0;
    const todayPromotions = this.countTodayPromotions(promoter.playerId, context);
    
    if (todayPromotions >= maxPromotions) {
      return {
        allowed: false,
        reason: `Daily promotion limit reached: ${maxPromotions}/${maxPromotions}`
      };
    }
    
    // Special case: Leadership transfer requires quorum
    if (targetRole === ALLIANCE_ROLES.LEADER) {
      return {
        allowed: false,
        reason: 'Leadership transfer requires quorum approval process'
      };
    }
    
    // Combat lockdown check
    if (context.isInActiveCombat) {
      const restrictedRoles: AllianceRole[] = [ALLIANCE_ROLES.LEADER, ALLIANCE_ROLES.VICE_LEADER, ALLIANCE_ROLES.OFFICERS];
      if (restrictedRoles.includes(targetRole)) {
        return {
          allowed: false,
          reason: 'Critical role changes forbidden during active combat'
        };
      }
    }
    
    return { allowed: true };
  }
  
  /**
   * Validate if a role demotion is allowed
   */
  public canDemote(
    demoter: AlliancePlayerEntity,
    target: AlliancePlayerEntity,
    targetRole: AllianceRole,
    context: AllianceContext
  ): { allowed: boolean; reason?: string } {
    
    const demoterLevel = ROLE_HIERARCHY[demoter.role];
    const targetCurrentLevel = ROLE_HIERARCHY[target.role];
    const targetNewLevel = ROLE_HIERARCHY[targetRole];
    
    // Demoter must have higher authority than target's current role
    if (demoterLevel <= targetCurrentLevel) {
      return {
        allowed: false,
        reason: `Insufficient authority: ${demoter.role} cannot demote ${target.role}`
      };
    }
    
    // Cannot demote someone to a role equal or higher than your own
    if (demoterLevel <= targetNewLevel) {
      return {
        allowed: false,
        reason: `Cannot demote to role equal or higher than your own authority`
      };
    }
    
    // Check demotion cooldown
    if (target.lastRoleChange) {
      const cooldownPeriod = ROLE_TRANSITION_RULES.ROLE_CHANGE_COOLDOWNS.DEMOTION * 60 * 60 * 1000;
      const timeSinceLastChange = Date.now() - target.lastRoleChange;
      
      if (timeSinceLastChange < cooldownPeriod) {
        const remainingHours = Math.ceil((cooldownPeriod - timeSinceLastChange) / (60 * 60 * 1000));
        return {
          allowed: false,
          reason: `Demotion cooldown: ${remainingHours} hours remaining`
        };
      }
    }
    
    // Special protection for high-ranking roles - requires multiple approvals
    const protectedRoles: AllianceRole[] = [ALLIANCE_ROLES.OFFICERS, ALLIANCE_ROLES.VICE_LEADER];
    if (protectedRoles.includes(target.role)) {
      return {
        allowed: false,
        reason: 'Demoting officers and vice leaders requires dual approval process'
      };
    }
    
    // Combat lockdown check
    if (context.isInActiveCombat) {
      return {
        allowed: false,
        reason: 'Role changes forbidden during active combat'
      };
    }
    
    return { allowed: true };
  }
  
  /**
   * Check if an action requires quorum approval
   */
  public requiresQuorum(action: string): boolean {
    return Object.keys(QUORUM_REQUIREMENTS).includes(action);
  }
  
  /**
   * Validate quorum requirements for critical decisions
   */
  public validateQuorumDecision(
    action: string,
    vote: QuorumVote,
    context: AllianceContext
  ): { valid: boolean; reason?: string; canExecute: boolean } {
    
    const requirements = QUORUM_REQUIREMENTS[action as keyof typeof QUORUM_REQUIREMENTS];
    if (!requirements) {
      return { valid: false, reason: 'Unknown action for quorum', canExecute: false };
    }
    
    // Check if voting period has ended
    const now = Date.now();
    const votingEnded = now >= vote.votingEndsAt;
    
    if (!votingEnded) {
      return { 
        valid: true, 
        reason: 'Voting still in progress', 
        canExecute: false 
      };
    }
    
    // Count valid votes from required roles
    const validVotes = vote.votes.filter(v => 
      (requirements.requiredRoles as AllianceRole[]).includes(v.voterRole) &&
      v.vote !== 'abstain'
    );
    
    // Check minimum voter requirement
    if (validVotes.length < requirements.minimumVoters) {
      return {
        valid: false,
        reason: `Insufficient voters: ${validVotes.length}/${requirements.minimumVoters}`,
        canExecute: false
      };
    }
    
    // Calculate approval rate
    const approvals = validVotes.filter(v => v.vote === 'approve').length;
    const approvalRate = approvals / validVotes.length;
    
    // Check approval threshold
    if (approvalRate < requirements.approvalThreshold) {
      return {
        valid: true,
        reason: `Insufficient approval rate: ${(approvalRate * 100).toFixed(1)}% < ${(requirements.approvalThreshold * 100).toFixed(1)}%`,
        canExecute: false
      };
    }
    
    return {
      valid: true,
      reason: `Quorum reached: ${approvals}/${validVotes.length} approved`,
      canExecute: true
    };
  }
  
  /**
   * Check if action requires separation of duties (dual control)
   */
  public requiresDualControl(action: string): boolean {
    return SEPARATION_OF_DUTIES.DUAL_CONTROL_REQUIRED.includes(action);
  }
  
  /**
   * Validate temporal restrictions
   */
  public checkTemporalRestrictions(
    action: string,
    context: AllianceContext
  ): { allowed: boolean; reason?: string } {
    
    // Combat lockdown
    if (context.isInActiveCombat) {
      if (SEPARATION_OF_DUTIES.TEMPORAL_RESTRICTIONS.COMBAT_LOCKDOWN_ACTIONS.includes(action)) {
        return {
          allowed: false,
          reason: 'Action forbidden during active combat'
        };
      }
    }
    
    // Peak hours enhanced approval
    const peakHours = SEPARATION_OF_DUTIES.TEMPORAL_RESTRICTIONS.PEAK_HOURS_ENHANCED_APPROVAL;
    const now = new Date();
    const currentHour = now.getUTCHours();
    
    if (currentHour >= peakHours.startHour && currentHour <= peakHours.endHour) {
      if (peakHours.enhancedActions.includes(action)) {
        return {
          allowed: false,
          reason: 'Action requires enhanced approval during peak hours'
        };
      }
    }
    
    return { allowed: true };
  }
  
  /**
   * Helper method to count today's promotions by a player
   */
  private countTodayPromotions(playerId: string, context: AllianceContext): number {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    
    return context.recentActions.filter(action => 
      action.action === 'promoteMember' &&
      action.actor === playerId &&
      action.timestamp >= todayStartMs
    ).length;
  }
  
  /**
   * Generate role hierarchy visualization
   */
  public getRoleHierarchyMap(): Record<string, { level: number; permissions: string[] }> {
    const hierarchyMap: Record<string, { level: number; permissions: string[] }> = {};
    
    for (const [role, level] of Object.entries(ROLE_HIERARCHY)) {
      hierarchyMap[role] = {
        level,
        permissions: this.getAllPermissions(role as AllianceRole)
      };
    }
    
    return hierarchyMap;
  }
  
  /**
   * Calculate effective permissions for a player in context
   */
  public getEffectivePermissions(
    player: AlliancePlayerEntity,
    context: AllianceContext
  ): string[] {
    let permissions = this.getAllPermissions(player.role);
    
    // Apply temporal restrictions
    if (context.isInActiveCombat) {
      // Remove restricted permissions during combat
      permissions = permissions.filter(permission => 
        !permission.includes('leadership') &&
        !permission.includes('disband') &&
        !permission.includes('mass-kick')
      );
    }
    
    // Apply emergency overrides for leaders
    if (player.role === ALLIANCE_ROLES.LEADER && context.isInActiveCombat) {
      permissions.push('military.emergency-command');
      permissions.push('resource.emergency-requisition');
    }
    
    return permissions;
  }
}

export default AllianceRoleInheritanceManager;