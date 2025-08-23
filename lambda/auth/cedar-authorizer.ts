import { 
  APIGatewayAuthorizerResult, 
  APIGatewayTokenAuthorizerEvent, 
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResultContext,
  Context
} from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import jwt from 'jsonwebtoken';

interface JWTPayload {
  sub: string;
  sessionId: string;
  deviceId: string;
  userType: 'player' | 'admin';
  roles: string[];
  allianceId?: string;
  level?: number;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
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

class CedarAPIGatewayAuthorizer {
  private lambda: LambdaClient;
  private dynamodb: DynamoDBClient;
  private cedarAuthFunctionArn: string;
  private sessionsTableName: string;
  
  constructor() {
    this.lambda = new LambdaClient({ region: process.env.AWS_REGION });
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
    this.cedarAuthFunctionArn = process.env.CEDAR_AUTH_FUNCTION_ARN!;
    this.sessionsTableName = process.env.SESSIONS_TABLE_NAME!;
  }

  async authorize(event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent): Promise<APIGatewayAuthorizerResult> {
    try {
      // Debug logging for development environments only
      if (process.env.NODE_ENV !== 'production') {
        console.log('Cedar Authorizer Event:', JSON.stringify(event, null, 2));
      }

      // Extract token from event
      const token = this.extractToken(event);
      if (!token) {
        throw new Error('No authorization token found');
      }

      // Validate JWT and extract user information
      const jwtPayload = await this.validateJWT(token);
      
      // Verify session is still active
      await this.verifySession(jwtPayload.sessionId);

      // Extract action and resource from the request
      const { action, resource } = this.extractActionAndResource(event);

      // Build Cedar authorization request
      const authRequest: CedarAuthorizationRequest = {
        principal: {
          entityType: 'GameUser',
          entityId: jwtPayload.sub
        },
        action: {
          actionType: 'GameAction',
          actionId: action
        },
        resource: {
          entityType: 'GameResource',
          entityId: resource
        },
        context: {
          userType: jwtPayload.userType,
          roles: jwtPayload.roles,
          allianceId: jwtPayload.allianceId,
          level: jwtPayload.level,
          sessionId: jwtPayload.sessionId,
          currentTime: Math.floor(Date.now() / 1000),
          requestTime: new Date().toISOString(),
          sourceIp: this.getSourceIp(event),
          userAgent: this.getUserAgent(event)
        }
      };

      // Call Cedar authorization function
      const authResult = await this.callCedarAuthorization(authRequest);

      // Generate IAM policy based on Cedar decision
      const policy = this.generatePolicy(
        jwtPayload.sub,
        authResult.decision === 'ALLOW' ? 'Allow' : 'Deny',
        this.getMethodArn(event),
        {
          userId: jwtPayload.sub,
          userType: jwtPayload.userType,
          roles: jwtPayload.roles.join(','),
          sessionId: jwtPayload.sessionId,
          allianceId: jwtPayload.allianceId || '',
          authLatency: authResult.latency.toString(),
          cedarDecision: authResult.decision,
          determiningPolicies: authResult.determiningPolicies.join(',')
        }
      );

      return policy;

    } catch (error) {
      console.error('Authorization failed:', error);
      
      // Return deny policy for any errors
      return this.generatePolicy(
        'unknown',
        'Deny',
        this.getMethodArn(event),
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        }
      );
    }
  }

  private extractToken(event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent): string | null {
    if ('authorizationToken' in event) {
      // Token authorizer
      return event.authorizationToken?.replace('Bearer ', '') || null;
    } else {
      // Request authorizer
      const authHeader = event.headers?.Authorization || event.headers?.authorization;
      return authHeader?.replace('Bearer ', '') || null;
    }
  }

  private async validateJWT(token: string): Promise<JWTPayload> {
    try {
      // In production, you would fetch the public key from your JWT issuer
      // For now, we'll use a shared secret (not recommended for production)
      const secret = process.env.JWT_SECRET || 'your-secret-key';
      
      const decoded = jwt.verify(token, secret) as JWTPayload;
      
      // Validate required fields
      if (!decoded.sub || !decoded.sessionId || !decoded.userType) {
        throw new Error('Invalid JWT payload: missing required fields');
      }

      // Check if token is expired
      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp && decoded.exp < now) {
        throw new Error('JWT token has expired');
      }

      return decoded;
    } catch (error) {
      throw new Error(`JWT validation failed: ${error}`);
    }
  }

  private async verifySession(sessionId: string): Promise<void> {
    try {
      const command = new GetItemCommand({
        TableName: this.sessionsTableName,
        Key: {
          sessionId: { S: sessionId }
        }
      });

      const result = await this.dynamodb.send(command);
      
      if (!result.Item) {
        throw new Error('Session not found');
      }

      const session = unmarshall(result.Item);
      
      // Check if session is still valid
      if (session.expiresAt && session.expiresAt < Date.now()) {
        throw new Error('Session has expired');
      }

      if (session.status !== 'active') {
        throw new Error('Session is not active');
      }

    } catch (error) {
      throw new Error(`Session verification failed: ${error}`);
    }
  }

  private extractActionAndResource(event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent): { action: string; resource: string } {
    const methodArn = this.getMethodArn(event);
    const arnParts = methodArn.split('/');
    
    // Extract HTTP method and resource path
    const httpMethod = arnParts[2]?.split(':')[2]; // GET, POST, etc.
    const resourcePath = arnParts.slice(3).join('/'); // api/path/resource
    
    // Map HTTP method and path to Cedar actions
    const action = this.mapToGameAction(httpMethod, resourcePath);
    const resource = this.mapToGameResource(resourcePath);
    
    return { action, resource };
  }

  private mapToGameAction(httpMethod: string, resourcePath: string): string {
    // Map HTTP methods and paths to game actions
    const actionMap: Record<string, string> = {
      'GET:/auth/profile': 'viewProfile',
      'PUT:/auth/profile': 'updateProfile',
      'POST:/jwt/generate': 'login',
      'POST:/jwt/validate': 'validateToken',
      'POST:/jwt/refresh': 'refreshToken',
      'POST:/jwt/revoke': 'logout',
      'POST:/authz': 'authorize',
      'GET:/policies': 'viewPolicies',
      'POST:/policies': 'createPolicy',
      'PUT:/policies': 'updatePolicy',
      'DELETE:/policies': 'deletePolicy',
      'GET:/game/alliance': 'viewAllianceInfo',
      'POST:/game/alliance/invite': 'inviteMember',
      'POST:/game/alliance/kick': 'kickMember',
      'POST:/game/battle/attack': 'attack',
      'POST:/game/battle/defend': 'defend',
      'GET:/admin/users': 'viewAllUsers',
      'POST:/admin/ban': 'banUser'
    };

    const key = `${httpMethod}:/${resourcePath}`;
    return actionMap[key] || 'unknownAction';
  }

  private mapToGameResource(resourcePath: string): string {
    // Extract resource identifier from path
    if (resourcePath.includes('/admin/')) {
      return 'adminResource';
    } else if (resourcePath.includes('/alliance/')) {
      return 'allianceResource';
    } else if (resourcePath.includes('/battle/')) {
      return 'battleResource';
    } else if (resourcePath.includes('/policies')) {
      return 'policyResource';
    } else if (resourcePath.includes('/auth/')) {
      return 'authResource';
    } else {
      return 'generalResource';
    }
  }

  private async callCedarAuthorization(request: CedarAuthorizationRequest): Promise<CedarAuthorizationResult> {
    try {
      const command = new InvokeCommand({
        FunctionName: this.cedarAuthFunctionArn,
        Payload: JSON.stringify(request)
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
      console.error('Cedar authorization call failed:', error);
      // Default to DENY on any errors
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Authorization service error: ${error}`],
        latency: 0,
        cached: false
      };
    }
  }

  private generatePolicy(
    principalId: string,
    effect: 'Allow' | 'Deny',
    resource: string,
    context?: APIGatewayAuthorizerResultContext
  ): APIGatewayAuthorizerResult {
    return {
      principalId,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: effect,
            Resource: resource
          }
        ]
      },
      context: context || {}
    };
  }

  private getMethodArn(event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent): string {
    if ('methodArn' in event) {
      return event.methodArn;
    } else {
      // For request authorizer, construct ARN from request context
      const requestEvent = event as APIGatewayRequestAuthorizerEvent;
      const { accountId, apiId, stage, httpMethod, resourcePath } = requestEvent.requestContext;
      return `arn:aws:execute-api:${process.env.AWS_REGION}:${accountId}:${apiId}/${stage}/${httpMethod}${resourcePath}`;
    }
  }

  private getSourceIp(event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent): string {
    if ('requestContext' in event && event.requestContext?.identity?.sourceIp) {
      return event.requestContext.identity.sourceIp;
    }
    return 'unknown';
  }

  private getUserAgent(event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent): string {
    if ('requestContext' in event && event.requestContext?.identity?.userAgent) {
      return event.requestContext.identity.userAgent;
    }
    return 'unknown';
  }
}

// Global instance
let authorizer: CedarAPIGatewayAuthorizer;

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent | APIGatewayRequestAuthorizerEvent,
  _context: Context
): Promise<APIGatewayAuthorizerResult> => {
  if (!authorizer) {
    authorizer = new CedarAPIGatewayAuthorizer();
  }

  return await authorizer.authorize(event);
};