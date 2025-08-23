/**
 * Alliance Role Assignment Audit Trail
 * Issue #18: Alliance Role-Based Authorization System
 * 
 * This module provides comprehensive audit logging for all alliance role changes,
 * permissions usage, and critical decision tracking with full history.
 */

import { DynamoDBClient, PutItemCommand, QueryCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { AllianceRole, AlliancePlayerEntity, QuorumVote } from './alliance-role-policies-schema';

// Audit event types
export enum AuditEventType {
  ROLE_ASSIGNED = 'ROLE_ASSIGNED',
  ROLE_PROMOTED = 'ROLE_PROMOTED', 
  ROLE_DEMOTED = 'ROLE_DEMOTED',
  PERMISSION_USED = 'PERMISSION_USED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  QUORUM_INITIATED = 'QUORUM_INITIATED',
  QUORUM_VOTED = 'QUORUM_VOTED',
  QUORUM_EXECUTED = 'QUORUM_EXECUTED',
  LEADERSHIP_TRANSFERRED = 'LEADERSHIP_TRANSFERRED',
  EMERGENCY_OVERRIDE = 'EMERGENCY_OVERRIDE',
  DUAL_CONTROL_APPROVED = 'DUAL_CONTROL_APPROVED',
  AUDIT_LOG_ACCESSED = 'AUDIT_LOG_ACCESSED'
}

// Risk levels for audit events
export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM', 
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL'
}

// Audit event interface
export interface AllianceAuditEvent {
  eventId: string;
  allianceId: string;
  eventType: AuditEventType;
  timestamp: number;
  actor: {
    playerId: string;
    role: AllianceRole;
    ipAddress?: string;
    sessionId?: string;
  };
  target?: {
    playerId?: string;
    resourceId?: string;
    targetType: 'player' | 'alliance' | 'resource' | 'vote' | 'system';
  };
  details: {
    action: string;
    previousState?: any;
    newState?: any;
    reason?: string;
    metadata?: Record<string, any>;
  };
  riskLevel: RiskLevel;
  success: boolean;
  errorMessage?: string;
  context: {
    isInCombat: boolean;
    isEmergency: boolean;
    requiresDualApproval: boolean;
    quorumVoteId?: string;
  };
}

// Audit query interface
export interface AuditQuery {
  allianceId: string;
  startTime?: number;
  endTime?: number;
  eventTypes?: AuditEventType[];
  actorId?: string;
  targetId?: string;
  riskLevels?: RiskLevel[];
  limit?: number;
  lastEvaluatedKey?: Record<string, any>;
}

// Audit statistics interface  
export interface AuditStatistics {
  allianceId: string;
  timeRange: {
    startTime: number;
    endTime: number;
  };
  eventCounts: Record<AuditEventType, number>;
  riskLevelCounts: Record<RiskLevel, number>;
  topActors: Array<{ playerId: string; eventCount: number; riskScore: number }>;
  suspiciousPatterns: Array<{
    pattern: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    description: string;
    affectedPlayers: string[];
  }>;
}

export class AllianceRoleAuditManager {
  private dynamodb: DynamoDBClient;
  private cloudwatch: CloudWatchClient;
  private auditTableName: string;
  
  constructor() {
    this.dynamodb = new DynamoDBClient({
      region: process.env.REGION || 'eu-north-1'
    });
    this.cloudwatch = new CloudWatchClient({
      region: process.env.REGION || 'eu-north-1'
    });
    this.auditTableName = process.env.ALLIANCE_AUDIT_TABLE || 'alliance-role-audit';
  }
  
  /**
   * Log role assignment event
   */
  async logRoleAssignment(
    allianceId: string,
    actor: AlliancePlayerEntity,
    target: AlliancePlayerEntity,
    newRole: AllianceRole,
    oldRole: AllianceRole,
    reason?: string,
    context?: any
  ): Promise<void> {
    
    const auditEvent: AllianceAuditEvent = {
      eventId: this.generateEventId(),
      allianceId,
      eventType: this.determineRoleEventType(oldRole, newRole),
      timestamp: Date.now(),
      actor: {
        playerId: actor.playerId,
        role: actor.role,
        ipAddress: context?.ipAddress,
        sessionId: context?.sessionId
      },
      target: {
        playerId: target.playerId,
        targetType: 'player'
      },
      details: {
        action: 'role_change',
        previousState: { role: oldRole, assignedAt: target.roleAssignedAt },
        newState: { role: newRole, assignedAt: Date.now() },
        reason,
        metadata: {
          promoterLevel: actor.role,
          targetPreviousLevel: oldRole,
          targetNewLevel: newRole
        }
      },
      riskLevel: this.calculateRiskLevel(newRole, oldRole, context),
      success: true,
      context: {
        isInCombat: context?.isInCombat || false,
        isEmergency: context?.isEmergency || false,
        requiresDualApproval: context?.requiresDualApproval || false,
        quorumVoteId: context?.quorumVoteId
      }
    };
    
    await this.storeAuditEvent(auditEvent);
    await this.sendMetrics(auditEvent);
  }
  
  /**
   * Log permission usage
   */
  async logPermissionUsage(
    allianceId: string,
    actor: AlliancePlayerEntity,
    permission: string,
    resource: any,
    success: boolean,
    errorMessage?: string,
    context?: any
  ): Promise<void> {
    
    const auditEvent: AllianceAuditEvent = {
      eventId: this.generateEventId(),
      allianceId,
      eventType: success ? AuditEventType.PERMISSION_USED : AuditEventType.PERMISSION_DENIED,
      timestamp: Date.now(),
      actor: {
        playerId: actor.playerId,
        role: actor.role,
        ipAddress: context?.ipAddress,
        sessionId: context?.sessionId
      },
      target: {
        resourceId: resource?.id,
        targetType: resource?.type || 'resource'
      },
      details: {
        action: permission,
        metadata: {
          resourceType: resource?.type,
          permissionCategory: this.categorizePermission(permission)
        }
      },
      riskLevel: this.calculatePermissionRiskLevel(permission, success),
      success,
      errorMessage,
      context: {
        isInCombat: context?.isInCombat || false,
        isEmergency: context?.isEmergency || false,
        requiresDualApproval: context?.requiresDualApproval || false
      }
    };
    
    await this.storeAuditEvent(auditEvent);
    await this.sendMetrics(auditEvent);
  }
  
  /**
   * Log quorum decision events
   */
  async logQuorumEvent(
    allianceId: string,
    vote: QuorumVote,
    actor: AlliancePlayerEntity,
    eventType: AuditEventType.QUORUM_INITIATED | AuditEventType.QUORUM_VOTED | AuditEventType.QUORUM_EXECUTED,
    voteDetails?: any,
    context?: any
  ): Promise<void> {
    
    const auditEvent: AllianceAuditEvent = {
      eventId: this.generateEventId(),
      allianceId,
      eventType,
      timestamp: Date.now(),
      actor: {
        playerId: actor.playerId,
        role: actor.role,
        ipAddress: context?.ipAddress,
        sessionId: context?.sessionId
      },
      target: {
        resourceId: vote.voteId,
        targetType: 'vote'
      },
      details: {
        action: vote.action,
        previousState: eventType === AuditEventType.QUORUM_EXECUTED ? {
          status: 'active',
          voteCount: vote.votes.length
        } : undefined,
        newState: eventType === AuditEventType.QUORUM_EXECUTED ? {
          status: vote.status,
          finalizedAt: vote.finalizedAt
        } : voteDetails,
        metadata: {
          voteId: vote.voteId,
          requiredVoters: vote.requiredVoters,
          approvalThreshold: vote.approvalThreshold,
          votingEndsAt: vote.votingEndsAt
        }
      },
      riskLevel: this.calculateQuorumRiskLevel(vote.action, eventType),
      success: true,
      context: {
        isInCombat: context?.isInCombat || false,
        isEmergency: context?.isEmergency || false,
        requiresDualApproval: true,
        quorumVoteId: vote.voteId
      }
    };
    
    await this.storeAuditEvent(auditEvent);
    await this.sendMetrics(auditEvent);
  }
  
  /**
   * Log emergency override
   */
  async logEmergencyOverride(
    allianceId: string,
    actor: AlliancePlayerEntity,
    overriddenPermission: string,
    justification: string,
    context?: any
  ): Promise<void> {
    
    const auditEvent: AllianceAuditEvent = {
      eventId: this.generateEventId(),
      allianceId,
      eventType: AuditEventType.EMERGENCY_OVERRIDE,
      timestamp: Date.now(),
      actor: {
        playerId: actor.playerId,
        role: actor.role,
        ipAddress: context?.ipAddress,
        sessionId: context?.sessionId
      },
      details: {
        action: 'emergency_override',
        metadata: {
          overriddenPermission,
          justification,
          emergencyCode: context?.emergencyCode ? '***REDACTED***' : undefined
        }
      },
      riskLevel: RiskLevel.CRITICAL,
      success: true,
      context: {
        isInCombat: context?.isInCombat || false,
        isEmergency: true,
        requiresDualApproval: false
      }
    };
    
    await this.storeAuditEvent(auditEvent);
    await this.sendMetrics(auditEvent);
    
    // Emergency overrides trigger immediate alerts
    await this.sendCriticalAlert(auditEvent);
  }
  
  /**
   * Query audit events
   */
  async queryAuditEvents(query: AuditQuery): Promise<{
    events: AllianceAuditEvent[];
    lastEvaluatedKey?: Record<string, any>;
  }> {
    
    const queryParams: any = {
      TableName: this.auditTableName,
      KeyConditionExpression: 'allianceId = :allianceId',
      ExpressionAttributeValues: marshall({
        ':allianceId': query.allianceId
      }),
      Limit: query.limit || 50,
      ScanIndexForward: false // Most recent first
    };
    
    // Add time range filter
    if (query.startTime || query.endTime) {
      let timeFilter = '';
      if (query.startTime && query.endTime) {
        timeFilter = '#timestamp BETWEEN :startTime AND :endTime';
        queryParams.ExpressionAttributeValues = marshall({
          ...unmarshall(queryParams.ExpressionAttributeValues),
          ':startTime': query.startTime,
          ':endTime': query.endTime
        });
      } else if (query.startTime) {
        timeFilter = '#timestamp >= :startTime';
        queryParams.ExpressionAttributeValues = marshall({
          ...unmarshall(queryParams.ExpressionAttributeValues),
          ':startTime': query.startTime
        });
      } else if (query.endTime) {
        timeFilter = '#timestamp <= :endTime';
        queryParams.ExpressionAttributeValues = marshall({
          ...unmarshall(queryParams.ExpressionAttributeValues),
          ':endTime': query.endTime
        });
      }
      
      queryParams.FilterExpression = timeFilter;
      queryParams.ExpressionAttributeNames = { '#timestamp': 'timestamp' };
    }
    
    if (query.lastEvaluatedKey) {
      queryParams.ExclusiveStartKey = query.lastEvaluatedKey;
    }
    
    const result = await this.dynamodb.send(new QueryCommand(queryParams));
    
    let events = result.Items?.map(item => unmarshall(item) as AllianceAuditEvent) || [];
    
    // Apply additional filters
    if (query.eventTypes && query.eventTypes.length > 0) {
      events = events.filter(event => query.eventTypes!.includes(event.eventType));
    }
    
    if (query.actorId) {
      events = events.filter(event => event.actor.playerId === query.actorId);
    }
    
    if (query.targetId) {
      events = events.filter(event => 
        event.target?.playerId === query.targetId || 
        event.target?.resourceId === query.targetId
      );
    }
    
    if (query.riskLevels && query.riskLevels.length > 0) {
      events = events.filter(event => query.riskLevels!.includes(event.riskLevel));
    }
    
    return {
      events,
      lastEvaluatedKey: result.LastEvaluatedKey
    };
  }
  
  /**
   * Generate audit statistics and suspicious pattern detection
   */
  async generateAuditStatistics(
    allianceId: string,
    startTime: number,
    endTime: number
  ): Promise<AuditStatistics> {
    
    const { events } = await this.queryAuditEvents({
      allianceId,
      startTime,
      endTime,
      limit: 1000 // Large sample for statistics
    });
    
    // Count events by type
    const eventCounts = {} as Record<AuditEventType, number>;
    Object.values(AuditEventType).forEach(type => {
      eventCounts[type] = events.filter(e => e.eventType === type).length;
    });
    
    // Count events by risk level
    const riskLevelCounts = {} as Record<RiskLevel, number>;
    Object.values(RiskLevel).forEach(level => {
      riskLevelCounts[level] = events.filter(e => e.riskLevel === level).length;
    });
    
    // Calculate top actors
    const actorStats = new Map<string, { eventCount: number; riskScore: number }>();
    events.forEach(event => {
      const actorId = event.actor.playerId;
      const current = actorStats.get(actorId) || { eventCount: 0, riskScore: 0 };
      current.eventCount++;
      current.riskScore += this.getRiskScore(event.riskLevel);
      actorStats.set(actorId, current);
    });
    
    const topActors = Array.from(actorStats.entries())
      .map(([playerId, stats]) => ({ playerId, ...stats }))
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 10);
    
    // Detect suspicious patterns
    const suspiciousPatterns = this.detectSuspiciousPatterns(events);
    
    return {
      allianceId,
      timeRange: { startTime, endTime },
      eventCounts,
      riskLevelCounts,
      topActors,
      suspiciousPatterns
    };
  }
  
  /**
   * Store audit event in DynamoDB
   */
  private async storeAuditEvent(event: AllianceAuditEvent): Promise<void> {
    const putParams = {
      TableName: this.auditTableName,
      Item: marshall({
        ...event,
        // Add GSI keys for efficient querying
        actorId: event.actor.playerId,
        eventType_timestamp: `${event.eventType}#${event.timestamp}`,
        riskLevel_timestamp: `${event.riskLevel}#${event.timestamp}`
      })
    };
    
    await this.dynamodb.send(new PutItemCommand(putParams));
  }
  
  /**
   * Send CloudWatch metrics
   */
  private async sendMetrics(event: AllianceAuditEvent): Promise<void> {
    const metrics = [
      {
        MetricName: 'AuditEvents',
        Value: 1,
        Unit: 'Count',
        Dimensions: [
          { Name: 'AllianceId', Value: event.allianceId },
          { Name: 'EventType', Value: event.eventType },
          { Name: 'RiskLevel', Value: event.riskLevel }
        ]
      }
    ];
    
    if (!event.success) {
      metrics.push({
        MetricName: 'AuditEventErrors',
        Value: 1,
        Unit: 'Count',
        Dimensions: [
          { Name: 'AllianceId', Value: event.allianceId },
          { Name: 'EventType', Value: event.eventType }
        ]
      });
    }
    
    try {
      await this.cloudwatch.send(new PutMetricDataCommand({
        Namespace: 'GameAuth/AllianceRoles',
        MetricData: metrics.map(metric => ({
          ...metric,
          Unit: metric.Unit as any,
          Dimensions: metric.Dimensions?.map(dim => ({
            Name: dim.Name,
            Value: dim.Value
          }))
        }))
      }));
    } catch (error) {
      console.warn('Failed to send audit metrics:', error instanceof Error ? error.message : 'Unknown error');
    }
  }
  
  /**
   * Send critical alert for emergency overrides
   */
  private async sendCriticalAlert(event: AllianceAuditEvent): Promise<void> {
    // This would integrate with SNS or other alerting systems
    console.warn(`🚨 CRITICAL AUDIT EVENT: ${event.eventType} by ${event.actor.playerId} in alliance ${event.allianceId}`);
    
    // TODO: Implement SNS notification, Slack webhook, etc.
  }
  
  /**
   * Helper methods
   */
  private generateEventId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }
  
  private determineRoleEventType(oldRole: AllianceRole, newRole: AllianceRole): AuditEventType {
    const oldLevel = this.getRoleLevel(oldRole);
    const newLevel = this.getRoleLevel(newRole);
    
    if (newLevel > oldLevel) {
      return AuditEventType.ROLE_PROMOTED;
    } else if (newLevel < oldLevel) {
      return AuditEventType.ROLE_DEMOTED;
    } else {
      return AuditEventType.ROLE_ASSIGNED;
    }
  }
  
  private getRoleLevel(role: AllianceRole): number {
    const levels: Record<string, number> = {
      'leader': 8,
      'vice-leader': 7,
      'officer': 6,
      'management-l1': 5,
      'management-l2': 4,
      'management-l3': 3,
      'member': 2,
      'recruit': 1
    };
    return levels[role] || 0;
  }
  
  private calculateRiskLevel(newRole: AllianceRole, oldRole: AllianceRole, context?: any): RiskLevel {
    const newLevel = this.getRoleLevel(newRole);
    const oldLevel = this.getRoleLevel(oldRole);
    
    if (newRole === 'leader' || oldRole === 'leader') {
      return RiskLevel.CRITICAL;
    }
    
    if (newLevel >= 6 || oldLevel >= 6) { // Officer level and above
      return RiskLevel.HIGH;
    }
    
    if (Math.abs(newLevel - oldLevel) >= 3) { // Large role jumps
      return RiskLevel.MEDIUM;
    }
    
    return RiskLevel.LOW;
  }
  
  private calculatePermissionRiskLevel(permission: string, success: boolean): RiskLevel {
    if (!success) {
      return RiskLevel.MEDIUM; // Failed permission attempts are suspicious
    }
    
    if (permission.includes('emergency') || permission.includes('override')) {
      return RiskLevel.CRITICAL;
    }
    
    if (permission.includes('treasury') || permission.includes('war') || permission.includes('leadership')) {
      return RiskLevel.HIGH;
    }
    
    if (permission.includes('kick') || permission.includes('promote') || permission.includes('demote')) {
      return RiskLevel.MEDIUM;
    }
    
    return RiskLevel.LOW;
  }
  
  private calculateQuorumRiskLevel(action: string, eventType: AuditEventType): RiskLevel {
    if (action.includes('leadership') || action.includes('disband')) {
      return RiskLevel.CRITICAL;
    }
    
    if (action.includes('war') || action.includes('peace')) {
      return RiskLevel.HIGH;
    }
    
    return RiskLevel.MEDIUM;
  }
  
  private categorizePermission(permission: string): string {
    if (permission.includes('member')) return 'member_management';
    if (permission.includes('resource')) return 'resource_management';
    if (permission.includes('military')) return 'military';
    if (permission.includes('communication')) return 'communication';
    if (permission.includes('operation')) return 'alliance_operations';
    return 'other';
  }
  
  private getRiskScore(riskLevel: RiskLevel): number {
    const scores = {
      [RiskLevel.LOW]: 1,
      [RiskLevel.MEDIUM]: 3,
      [RiskLevel.HIGH]: 7,
      [RiskLevel.CRITICAL]: 15
    };
    return scores[riskLevel];
  }
  
  private detectSuspiciousPatterns(events: AllianceAuditEvent[]): Array<{
    pattern: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    description: string;
    affectedPlayers: string[];
  }> {
    
    const patterns: Array<{
      pattern: string;
      severity: 'LOW' | 'MEDIUM' | 'HIGH';
      description: string;
      affectedPlayers: string[];
    }> = [];
    
    // Pattern 1: Rapid role changes
    const roleChanges = events.filter(e => 
      [AuditEventType.ROLE_PROMOTED, AuditEventType.ROLE_DEMOTED].includes(e.eventType)
    );
    
    if (roleChanges.length > 10) {
      const rapidChanges = new Map<string, number>();
      roleChanges.forEach(event => {
        const playerId = event.target?.playerId;
        if (playerId) {
          rapidChanges.set(playerId, (rapidChanges.get(playerId) || 0) + 1);
        }
      });
      
      const suspiciousPlayers = Array.from(rapidChanges.entries())
        .filter(([_, count]) => count >= 3)
        .map(([playerId, _]) => playerId);
      
      if (suspiciousPlayers.length > 0) {
        patterns.push({
          pattern: 'rapid_role_changes',
          severity: 'HIGH',
          description: 'Unusual number of rapid role changes detected',
          affectedPlayers: suspiciousPlayers
        });
      }
    }
    
    // Pattern 2: Failed permission attempts
    const failedPermissions = events.filter(e => e.eventType === AuditEventType.PERMISSION_DENIED);
    const failuresByActor = new Map<string, number>();
    
    failedPermissions.forEach(event => {
      const actorId = event.actor.playerId;
      failuresByActor.set(actorId, (failuresByActor.get(actorId) || 0) + 1);
    });
    
    const suspiciousFailures = Array.from(failuresByActor.entries())
      .filter(([_, count]) => count >= 10)
      .map(([playerId, _]) => playerId);
    
    if (suspiciousFailures.length > 0) {
      patterns.push({
        pattern: 'excessive_permission_failures',
        severity: 'MEDIUM',
        description: 'Unusual number of permission failures indicating possible privilege escalation attempts',
        affectedPlayers: suspiciousFailures
      });
    }
    
    // Pattern 3: Emergency overrides
    const emergencyOverrides = events.filter(e => e.eventType === AuditEventType.EMERGENCY_OVERRIDE);
    if (emergencyOverrides.length > 2) {
      patterns.push({
        pattern: 'multiple_emergency_overrides',
        severity: 'HIGH',
        description: 'Multiple emergency overrides used in short timeframe',
        affectedPlayers: emergencyOverrides.map(e => e.actor.playerId)
      });
    }
    
    return patterns;
  }
}

export default AllianceRoleAuditManager;