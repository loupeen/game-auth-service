import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import jwt from 'jsonwebtoken';

interface JWTValidationRequest {
  token: string;
  action?: string;
  resource?: string;
  context?: Record<string, any>;
}

interface EnhancedValidationResult {
  valid: boolean;
  authorized?: boolean;
  userId?: string;
  sessionId?: string;
  userType?: string;
  roles?: string[];
  allianceId?: string;
  level?: number;
  cedarDecision?: 'ALLOW' | 'DENY';
  determiningPolicies?: string[];
  latency?: number;
  error?: string;
}

interface CedarAuthorizationRequest {
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

interface CedarAuthorizationResult {
  decision: 'ALLOW' | 'DENY';
  determiningPolicies: string[];
  errors: string[];
  latency: number;
  cached: boolean;
}

class JWTCedarIntegrationService {
  private lambda: LambdaClient;
  private dynamodb: DynamoDBClient;
  private cedarAuthFunctionArn: string;
  private entityStoreTableName: string;
  
  constructor() {
    this.lambda = new LambdaClient({ region: process.env.REGION });
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cedarAuthFunctionArn = process.env.CEDAR_AUTH_FUNCTION_ARN!;
    this.entityStoreTableName = process.env.ENTITY_STORE_TABLE!;
  }

  async validateTokenWithAuthorization(request: JWTValidationRequest): Promise<EnhancedValidationResult> {
    const startTime = Date.now();
    
    try {
      // Step 1: Validate JWT token
      const jwtValidation = await this.validateJWT(request.token);
      if (!jwtValidation.valid) {
        return jwtValidation;
      }

      // Step 2: Sync user entity to Cedar entity store
      await this.syncUserEntity(jwtValidation);

      // Step 3: If action and resource provided, perform Cedar authorization
      if (request.action && request.resource) {
        const authResult = await this.performCedarAuthorization(jwtValidation, request);
        
        return {
          ...jwtValidation,
          authorized: authResult.decision === 'ALLOW',
          cedarDecision: authResult.decision,
          determiningPolicies: authResult.determiningPolicies,
          latency: Date.now() - startTime
        };
      }

      // Step 4: Return JWT validation result only
      return {
        ...jwtValidation,
        latency: Date.now() - startTime
      };

    } catch (error) {
      console.error('Enhanced validation failed:', error);
      return {
        valid: false,
        authorized: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency: Date.now() - startTime
      };
    }
  }

  private async validateJWT(token: string): Promise<EnhancedValidationResult> {
    try {
      // Use existing JWT validation logic
      const secret = process.env.JWT_SECRET || 'your-secret-key';
      const decoded = jwt.verify(token, secret) as any;

      // Extract user information
      return {
        valid: true,
        userId: decoded.sub,
        sessionId: decoded.sessionId,
        userType: decoded.userType,
        roles: decoded.roles || [],
        allianceId: decoded.allianceId,
        level: decoded.level || 1
      };

    } catch (error) {
      return {
        valid: false,
        error: `JWT validation failed: ${error}`
      };
    }
  }

  private async syncUserEntity(userInfo: EnhancedValidationResult): Promise<void> {
    try {
      // Check if user entity exists in Cedar entity store
      const existingEntity = await this.getUserEntity(userInfo.userId!);
      
      const entityData = {
        entityType: 'GameUser',
        entityId: userInfo.userId!,
        attributes: {
          userId: userInfo.userId,
          userType: userInfo.userType,
          level: userInfo.level || 1,
          isActive: true,
          lastLogin: new Date().toISOString()
        },
        relationships: {
          roles: userInfo.roles || [],
          groups: this.determineUserGroups(userInfo),
          ...(userInfo.allianceId && { alliance: userInfo.allianceId })
        }
      };

      if (existingEntity) {
        // Update existing entity
        await this.updateUserEntity(entityData);
      } else {
        // Create new entity
        await this.createUserEntity(entityData);
      }

    } catch (error) {
      console.error('Failed to sync user entity:', error);
      // Don't fail the validation for entity sync issues
    }
  }

  private determineUserGroups(userInfo: EnhancedValidationResult): string[] {
    const groups = ['Players']; // All users are players

    if (userInfo.roles?.includes('admin')) {
      groups.push('Admins');
    }

    if (userInfo.allianceId) {
      groups.push('AllianceMembers');
      
      if (userInfo.roles?.includes('alliance-leader')) {
        groups.push('AllianceLeaders');
      } else if (userInfo.roles?.includes('alliance-officer')) {
        groups.push('AllianceOfficers');
      }
    }

    return groups;
  }

  private async getUserEntity(userId: string): Promise<any> {
    try {
      const command = new GetItemCommand({
        TableName: this.entityStoreTableName,
        Key: {
          entityType: { S: 'GameUser' },
          entityId: { S: userId }
        }
      });

      const result = await this.dynamodb.send(command);
      return result.Item ? unmarshall(result.Item) : null;
    } catch (error) {
      console.error('Failed to get user entity:', error);
      return null;
    }
  }

  private async createUserEntity(entityData: any): Promise<void> {
    try {
      const command = new InvokeCommand({
        FunctionName: process.env.ENTITY_MANAGEMENT_FUNCTION_ARN!,
        Payload: JSON.stringify({
          action: 'create',
          ...entityData
        })
      });

      await this.lambda.send(command);
    } catch (error) {
      console.error('Failed to create user entity:', error);
    }
  }

  private async updateUserEntity(entityData: any): Promise<void> {
    try {
      const command = new InvokeCommand({
        FunctionName: process.env.ENTITY_MANAGEMENT_FUNCTION_ARN!,
        Payload: JSON.stringify({
          action: 'update',
          ...entityData
        })
      });

      await this.lambda.send(command);
    } catch (error) {
      console.error('Failed to update user entity:', error);
    }
  }

  private async performCedarAuthorization(
    userInfo: EnhancedValidationResult,
    request: JWTValidationRequest
  ): Promise<CedarAuthorizationResult> {
    try {
      const authRequest: CedarAuthorizationRequest = {
        principal: {
          entityType: 'GameUser',
          entityId: userInfo.userId!
        },
        action: {
          actionType: 'GameAction',
          actionId: request.action!
        },
        resource: {
          entityType: 'GameResource',
          entityId: request.resource!
        },
        context: {
          userType: userInfo.userType,
          roles: userInfo.roles,
          allianceId: userInfo.allianceId,
          level: userInfo.level,
          sessionId: userInfo.sessionId,
          currentTime: Math.floor(Date.now() / 1000),
          ...request.context
        }
      };

      const command = new InvokeCommand({
        FunctionName: this.cedarAuthFunctionArn,
        Payload: JSON.stringify(authRequest)
      });

      const response = await this.lambda.send(command);
      
      if (!response.Payload) {
        throw new Error('No response from Cedar authorization function');
      }

      const result = JSON.parse(Buffer.from(response.Payload).toString());
      
      if (result.errorMessage) {
        throw new Error(`Cedar authorization failed: ${result.errorMessage}`);
      }

      return JSON.parse(result.body) as CedarAuthorizationResult;

    } catch (error) {
      console.error('Cedar authorization failed:', error);
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Authorization error: ${error}`],
        latency: 0,
        cached: false
      };
    }
  }
}

// Global service instance
let jwtCedarService: JWTCedarIntegrationService;

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  console.log('JWT-Cedar Integration Request:', JSON.stringify(event, null, 2));

  if (!jwtCedarService) {
    jwtCedarService = new JWTCedarIntegrationService();
  }

  try {
    const request: JWTValidationRequest = JSON.parse(event.body || '{}');

    if (!request.token) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          error: 'Missing token',
          message: 'Token is required for validation'
        })
      };
    }

    const result = await jwtCedarService.validateTokenWithAuthorization(request);

    return {
      statusCode: 200,
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