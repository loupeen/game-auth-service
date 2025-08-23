import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand, StandardUnit } from '@aws-sdk/client-cloudwatch';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

interface EnhancedValidationRequest {
  token: string;
  action?: {
    actionType: string;
    actionId: string;
  };
  resource?: {
    entityType: string;
    entityId: string;
  };
  context?: Record<string, any>;
}

interface UserEntity {
  userId: string;
  userType: 'player' | 'admin';
  level: number;
  allianceId?: string;
  allianceRole?: 'member' | 'leader' | 'co-leader';
  isActive: boolean;
  lastLoginAt: string;
  createdAt: string;
  attributes: Record<string, any>;
}

interface EnhancedValidationResult {
  valid: boolean;
  user?: UserEntity;
  authorizationResult?: {
    decision: 'ALLOW' | 'DENY';
    determiningPolicies: string[];
    errors: string[];
  };
  permissions?: string[];
  sessionInfo?: {
    tokenValid: boolean;
    expiresAt: number;
    issuedAt: number;
  };
  error?: string;
  latency: number;
}

class EnhancedJWTCedarValidator {
  private dynamodb: DynamoDBClient;
  private cloudwatch: CloudWatchClient;
  private jwksClientInstance: jwksClient.JwksClient;
  private sessionsTable: string;
  private entityStoreTable: string;
  private policyStoreTable: string;
  private userPoolId: string;
  private region: string;

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cloudwatch = new CloudWatchClient({ region: process.env.REGION });
    this.sessionsTable = process.env.SESSIONS_TABLE_NAME!;
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    this.policyStoreTable = process.env.POLICY_STORE_TABLE!;
    this.userPoolId = process.env.PLAYER_USER_POOL_ID!;
    this.region = process.env.REGION!;
    
    // JWKS client for Cognito token validation
    const jwksUri = `https://cognito-idp.${this.region}.amazonaws.com/${this.userPoolId}/.well-known/jwks.json`;
    this.jwksClientInstance = jwksClient({
      jwksUri,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 10
    });
  }

  async validateEnhanced(request: EnhancedValidationRequest): Promise<EnhancedValidationResult> {
    const startTime = Date.now();

    try {
      // Step 1: Validate JWT token
      const tokenValidation = await this.validateJWTToken(request.token);
      if (!tokenValidation.valid) {
        return {
          valid: false,
          error: tokenValidation.error || 'Invalid token',
          latency: Date.now() - startTime
        };
      }

      const userId = tokenValidation.userId!;
      const userPoolType = tokenValidation.userPoolType!;

      // Step 2: Get or create user entity in Cedar
      const userEntity = await this.getOrCreateUserEntity(userId, userPoolType, tokenValidation.claims);

      // Step 3: Perform Cedar authorization if action/resource specified
      let authorizationResult: any = undefined;
      if (request.action && request.resource) {
        authorizationResult = await this.performCedarAuthorization({
          principal: {
            entityType: 'GameUser',
            entityId: userId
          },
          action: request.action,
          resource: request.resource,
          context: request.context || {}
        });
      }

      // Step 4: Get user permissions
      const permissions = await this.getUserPermissions(userId, userEntity);

      // Step 5: Update session tracking
      await this.updateSessionTracking(userId, tokenValidation.claims);

      const result: EnhancedValidationResult = {
        valid: true,
        user: userEntity,
        authorizationResult,
        permissions,
        sessionInfo: {
          tokenValid: true,
          expiresAt: tokenValidation.claims.exp,
          issuedAt: tokenValidation.claims.iat
        },
        latency: Date.now() - startTime
      };

      // Send metrics
      await this.sendMetrics('Success', result.latency, authorizationResult?.decision);

      return result;

    } catch (error) {
      console.error('Enhanced validation error:', error);
      
      const latency = Date.now() - startTime;
      await this.sendMetrics('Error', latency);

      return {
        valid: false,
        error: `Enhanced validation failed: ${error}`,
        latency
      };
    }
  }

  private async validateJWTToken(token: string): Promise<{
    valid: boolean;
    userId?: string;
    userPoolType?: 'player' | 'admin';
    claims?: any;
    error?: string;
  }> {
    try {
      // Decode token header to get key ID
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header.kid) {
        return { valid: false, error: 'Invalid token format' };
      }

      // Get signing key from JWKS
      const key = await this.jwksClientInstance.getSigningKey(decoded.header.kid);
      const signingKey = key.getPublicKey();

      // Verify token signature and claims
      const claims = jwt.verify(token, signingKey, {
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPoolId}`,
        algorithms: ['RS256']
      }) as any;

      // Determine user pool type based on claims or token use
      const userPoolType = claims.aud === process.env.ADMIN_USER_POOL_CLIENT_ID ? 'admin' : 'player';

      return {
        valid: true,
        userId: claims.sub,
        userPoolType,
        claims
      };

    } catch (error) {
      console.error('JWT validation error:', error);
      return {
        valid: false,
        error: `Token validation failed: ${error}`
      };
    }
  }

  private async getOrCreateUserEntity(
    userId: string, 
    userType: 'player' | 'admin',
    claims: any
  ): Promise<UserEntity> {
    try {
      // Try to get existing entity
      const getCommand = new GetItemCommand({
        TableName: this.entityStoreTable,
        Key: {
          entityType: { S: 'GameUser' },
          entityId: { S: userId }
        }
      });

      const result = await this.dynamodb.send(getCommand);
      
      if (result.Item) {
        const entity = unmarshall(result.Item);
        return {
          userId: entity.entityId,
          userType: entity.attributes.userType,
          level: entity.attributes.level || 1,
          allianceId: entity.attributes.allianceId,
          allianceRole: entity.attributes.allianceRole,
          isActive: entity.attributes.isActive !== false,
          lastLoginAt: new Date().toISOString(),
          createdAt: entity.attributes.createdAt,
          attributes: entity.attributes
        };
      }

      // Create new entity if doesn't exist
      const newEntity: UserEntity = {
        userId,
        userType,
        level: 1,
        isActive: true,
        lastLoginAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        attributes: {
          email: claims.email,
          username: claims.username || claims.email,
          playerType: userType,
          joinedAt: new Date().toISOString()
        }
      };

      // Store in Cedar entity store
      await this.createCedarEntity(newEntity);

      return newEntity;

    } catch (error) {
      console.error('Error getting/creating user entity:', error);
      throw error;
    }
  }

  private async createCedarEntity(userEntity: UserEntity): Promise<void> {
    const cedarEntity = {
      entityType: 'GameUser',
      entityId: userEntity.userId,
      attributes: {
        userId: userEntity.userId,
        userType: userEntity.userType,
        level: userEntity.level,
        isActive: userEntity.isActive,
        allianceId: userEntity.allianceId,
        allianceRole: userEntity.allianceRole,
        ...userEntity.attributes
      },
      relationships: {
        groups: this.determineUserGroups(userEntity),
        alliance: userEntity.allianceId,
        roles: this.determineUserRoles(userEntity)
      },
      createdAt: userEntity.createdAt,
      updatedAt: new Date().toISOString()
    };

    const putCommand = new PutItemCommand({
      TableName: this.entityStoreTable,
      Item: marshall(cedarEntity, { removeUndefinedValues: true })
    });

    await this.dynamodb.send(putCommand);
  }

  private determineUserGroups(userEntity: UserEntity): string[] {
    const groups = ['Players'];
    
    if (userEntity.userType === 'admin') {
      groups.push('Admins');
    }
    
    if (userEntity.allianceId) {
      groups.push('AllianceMembers');
      
      if (userEntity.allianceRole === 'leader' || userEntity.allianceRole === 'co-leader') {
        groups.push('AllianceLeaders');
      }
    }
    
    if (userEntity.level >= 10) {
      groups.push('ExperiencedPlayers');
    }
    
    return groups;
  }

  private determineUserRoles(userEntity: UserEntity): string[] {
    const roles = ['Player'];
    
    if (userEntity.userType === 'admin') {
      roles.push('Administrator');
    }
    
    if (userEntity.allianceRole) {
      roles.push(`Alliance${userEntity.allianceRole.charAt(0).toUpperCase() + userEntity.allianceRole.slice(1)}`);
    }
    
    return roles;
  }

  private async performCedarAuthorization(request: {
    principal: { entityType: string; entityId: string };
    action: { actionType: string; actionId: string };
    resource: { entityType: string; entityId: string };
    context: Record<string, any>;
  }): Promise<{
    decision: 'ALLOW' | 'DENY';
    determiningPolicies: string[];
    errors: string[];
  }> {
    try {
      // Get active policies
      const policies = await this.getActivePolicies();
      
      // Get entities
      const entities = await this.buildEntitiesForAuthorization(request);
      
      // Build Cedar authorization call
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
        context: request.context,
        policies: {
          staticPolicies: policies.map(p => p.policyContent).join('\n\n')
        },
        entities
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
      console.error('Cedar authorization error:', error);
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Authorization evaluation failed: ${error}`]
      };
    }
  }

  private async getActivePolicies(): Promise<Array<{ policyId: string; policyContent: string }>> {
    try {
      const queryCommand = new QueryCommand({
        TableName: this.policyStoreTable,
        IndexName: 'ActivePoliciesIndex',
        KeyConditionExpression: 'isActive = :active',
        ExpressionAttributeValues: {
          ':active': { S: 'true' }
        }
      });

      const result = await this.dynamodb.send(queryCommand);
      return result.Items?.map(item => {
        const policy = unmarshall(item);
        return {
          policyId: policy.policyId,
          policyContent: policy.policyContent
        };
      }) || [];

    } catch (error) {
      console.error('Error getting active policies:', error);
      return [];
    }
  }

  private async buildEntitiesForAuthorization(_request: any): Promise<any[]> {
    // This would build the full entity structure for Cedar
    // For now, return empty array - will be enhanced as we build out entities
    return [];
  }

  private async getUserPermissions(userId: string, userEntity: UserEntity): Promise<string[]> {
    const permissions: string[] = [];
    
    // Base player permissions
    permissions.push('login', 'viewProfile', 'updateProfile', 'collectResources');
    
    // Alliance permissions
    if (userEntity.allianceId) {
      permissions.push('viewAllianceInfo', 'sendMessage', 'participateInBattle');
      
      if (userEntity.allianceRole === 'leader' || userEntity.allianceRole === 'co-leader') {
        permissions.push('inviteMember', 'kickMember', 'promoteMember', 'declareWar');
      }
    }
    
    // Admin permissions
    if (userEntity.userType === 'admin') {
      permissions.push('banUser', 'resetGameState', 'viewSystemLogs', 'manageAlliances');
    }
    
    // Level-based permissions
    if (userEntity.level >= 10) {
      permissions.push('attack', 'defendBase');
    }
    
    return permissions;
  }

  private async updateSessionTracking(userId: string, claims: any): Promise<void> {
    try {
      const sessionData = {
        sessionId: `enhanced-session-${userId}-${Date.now()}`,
        userId: userId,
        userType: claims.token_use === 'access' ? 'player' : 'admin',
        loginAt: new Date().toISOString(),
        expiresAt: claims.exp,
        ipAddress: 'unknown', // Would get from API Gateway event
        userAgent: 'unknown', // Would get from headers
        ttl: claims.exp + 3600 // Expire 1 hour after token
      };

      const putCommand = new PutItemCommand({
        TableName: this.sessionsTable,
        Item: marshall(sessionData, { removeUndefinedValues: true })
      });

      await this.dynamodb.send(putCommand);
    } catch (error) {
      console.error('Error updating session tracking:', error);
      // Don't fail the entire request for session tracking errors
    }
  }

  private async sendMetrics(status: string, latency: number, decision?: string): Promise<void> {
    try {
      const metricData = [
        {
          MetricName: 'EnhancedJWTValidation',
          Value: 1,
          Unit: StandardUnit.Count,
          Dimensions: [
            { Name: 'Environment', Value: process.env.ENVIRONMENT! },
            { Name: 'Status', Value: status }
          ]
        },
        {
          MetricName: 'EnhancedValidationLatency',
          Value: latency,
          Unit: StandardUnit.Milliseconds,
          Dimensions: [
            { Name: 'Environment', Value: process.env.ENVIRONMENT! },
            { Name: 'Status', Value: status }
          ]
        }
      ];

      if (decision) {
        metricData.push({
          MetricName: 'AuthorizationDecisions',
          Value: 1,
          Unit: StandardUnit.Count,
          Dimensions: [
            { Name: 'Environment', Value: process.env.ENVIRONMENT! },
            { Name: 'Decision', Value: decision }
          ]
        });
      }

      const command = new PutMetricDataCommand({
        Namespace: 'Loupeen/EnhancedAuth',
        MetricData: metricData
      });

      await this.cloudwatch.send(command);
    } catch (error) {
      console.error('Failed to send metrics:', error);
    }
  }
}

// Global instance to reuse across Lambda invocations
let validatorService: EnhancedJWTCedarValidator;

export const handler = async (
  event: APIGatewayProxyEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  console.log('Enhanced JWT-Cedar validation request:', JSON.stringify(event, null, 2));

  if (!validatorService) {
    validatorService = new EnhancedJWTCedarValidator();
  }

  try {
    // Parse request body
    const request: EnhancedValidationRequest = JSON.parse(event.body || '{}');

    // Validate required fields
    if (!request.token) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: 'Invalid request',
          message: 'Token is required'
        })
      };
    }

    // Perform enhanced validation
    const result = await validatorService.validateEnhanced(request);

    return {
      statusCode: result.valid ? 200 : 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Handler error:', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        message: 'Enhanced validation failed'
      })
    };
  }
};