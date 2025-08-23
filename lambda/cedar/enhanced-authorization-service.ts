/**
 * Enhanced Cedar Authorization Service with Redis Caching
 * Issue #17: Cedar Authorization Policies for Basic Game Actions
 * 
 * High-performance authorization service with:
 * - <10ms policy evaluation
 * - Redis caching with >95% hit rate
 * - Dynamic policy loading
 * - Comprehensive game action support
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import Redis from 'ioredis';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { DEFAULT_CONTEXT } from './game-policies-schema';

interface AuthorizationRequest {
  principal: {
    entityType: string;
    entityId: string;
    attributes?: Record<string, any>;
  };
  action: {
    actionType: string;
    actionId: string;
    context?: Record<string, any>;
  };
  resource: {
    entityType: string;
    entityId: string;
    attributes?: Record<string, any>;
  };
  context?: Record<string, any>;
}

interface AuthorizationResult {
  decision: 'ALLOW' | 'DENY';
  determiningPolicies: string[];
  errors: string[];
  latency: number;
  cached: boolean;
  cacheKey?: string;
  evaluationContext: Record<string, any>;
}

interface PolicyRecord {
  policyId: string;
  policyContent: string;
  policyType: string;
  category: string;
  priority: number;
  isActive: boolean;
  version: string;
  updatedAt: number;
}

interface EntityAttributes {
  [key: string]: any;
}

interface CacheEntry {
  decision: 'ALLOW' | 'DENY';
  determiningPolicies: string[];
  timestamp: number;
  ttl: number;
}

export class EnhancedAuthorizationService {
  private dynamodb: DynamoDBClient;
  private cloudwatch: CloudWatchClient;
  private redis?: Redis;
  private policyStoreTable: string;
  private entityStoreTable: string;
  
  // In-memory caches for ultra-fast access
  private policyCache: Map<string, PolicyRecord[]> = new Map();
  private entityCache: Map<string, EntityAttributes> = new Map();
  
  // Cache configuration
  private readonly CACHE_TTL = {
    AUTHORIZATION: 300, // 5 minutes for authorization decisions
    POLICIES: 3600,     // 1 hour for policies
    ENTITIES: 1800      // 30 minutes for entities
  };

  private readonly PERFORMANCE_TARGETS = {
    MAX_LATENCY: 10,    // <10ms target
    CACHE_HIT_RATE: 95  // >95% cache hit rate target
  };

  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.cloudwatch = new CloudWatchClient({ region: process.env.REGION });
    this.policyStoreTable = process.env.POLICY_STORE_TABLE!;
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
    
    // Initialize Redis if endpoint is provided
    if (process.env.REDIS_ENDPOINT) {
      this.redis = new Redis(process.env.REDIS_ENDPOINT, {
        enableAutoPipelining: true,
        maxRetriesPerRequest: 2,
        retryDelayOnFailover: 100,
        lazyConnect: true
      });
    }
  }

  /**
   * Main authorization method with caching
   */
  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    const startTime = process.hrtime.bigint();
    
    try {
      // Generate cache key for this authorization request
      const cacheKey = this.generateCacheKey(request);
      
      // Try to get cached result first
      const cachedResult = await this.getCachedResult(cacheKey);
      if (cachedResult) {
        const latency = Number(process.hrtime.bigint() - startTime) / 1_000_000; // Convert to ms
        
        await this.recordMetrics('CACHE_HIT', latency);
        
        return {
          decision: cachedResult.decision,
          determiningPolicies: cachedResult.determiningPolicies,
          errors: [],
          latency,
          cached: true,
          cacheKey,
          evaluationContext: this.buildEvaluationContext(request)
        };
      }

      // Cache miss - perform full authorization
      const result = await this.performAuthorization(request);
      const latency = Number(process.hrtime.bigint() - startTime) / 1_000_000;

      // Cache the result for future requests
      await this.cacheResult(cacheKey, result, latency);
      
      await this.recordMetrics('CACHE_MISS', latency);

      return {
        ...result,
        latency,
        cached: false,
        cacheKey,
        evaluationContext: this.buildEvaluationContext(request)
      };

    } catch (error) {
      const latency = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      console.error('Authorization error:', error);
      
      await this.recordMetrics('ERROR', latency);
      
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Authorization error: ${error.message}`],
        latency,
        cached: false,
        evaluationContext: this.buildEvaluationContext(request)
      };
    }
  }

  /**
   * Perform the actual Cedar authorization
   */
  private async performAuthorization(request: AuthorizationRequest): Promise<Omit<AuthorizationResult, 'latency' | 'cached' | 'cacheKey' | 'evaluationContext'>> {
    // Get active policies (with local caching)
    const policies = await this.getActivePolicies();
    
    // Get entity information (with local caching)
    const principalEntity = await this.getEntityAttributes(request.principal.entityType, request.principal.entityId);
    const resourceEntity = await this.getEntityAttributes(request.resource.entityType, request.resource.entityId);
    
    // Build Cedar entities
    const entities = this.buildCedarEntities(principalEntity, resourceEntity, request);
    
    // Build complete context
    const context = { ...DEFAULT_CONTEXT, ...request.context };
    
    // Evaluate policies using Cedar WASM
    const decision = await this.evaluatePoliciesWithCedar(policies, entities, request, context);
    
    return {
      decision: decision.decision,
      determiningPolicies: decision.determiningPolicies,
      errors: decision.errors || []
    };
  }

  /**
   * Evaluate policies using Cedar WASM engine
   */
  private async evaluatePoliciesWithCedar(
    policies: PolicyRecord[],
    entities: Record<string, any>,
    request: AuthorizationRequest,
    context: Record<string, any>
  ): Promise<{ decision: 'ALLOW' | 'DENY'; determiningPolicies: string[]; errors?: string[] }> {
    try {
      // Convert policies to Cedar format
      const policySet = policies
        .filter(p => p.isActive)
        .sort((a, b) => b.priority - a.priority) // Higher priority first
        .map(p => p.policyContent)
        .join('\n\n');

      // Build Cedar request
      const cedarRequest = {
        principal: `${request.principal.entityType}::"${request.principal.entityId}"`,
        action: `${request.action.actionType}::"${request.action.actionId}"`,
        resource: `${request.resource.entityType}::"${request.resource.entityId}"`,
        context
      };

      // Evaluate with Cedar WASM
      const result = cedar.isAuthorized(cedarRequest, policySet, entities);
      
      return {
        decision: result.decision === 'Allow' ? 'ALLOW' : 'DENY',
        determiningPolicies: result.diagnostics?.reason || [],
        errors: result.diagnostics?.errors || []
      };

    } catch (error) {
      console.error('Cedar evaluation error:', error);
      return {
        decision: 'DENY',
        determiningPolicies: [],
        errors: [`Cedar evaluation failed: ${error.message}`]
      };
    }
  }

  /**
   * Get active policies with local caching
   */
  private async getActivePolicies(): Promise<PolicyRecord[]> {
    const cacheKey = 'active-policies';
    
    // Check local cache first
    if (this.policyCache.has(cacheKey)) {
      return this.policyCache.get(cacheKey)!;
    }

    // Check Redis cache
    if (this.redis) {
      try {
        const cached = await this.redis.get(`policies:${cacheKey}`);
        if (cached) {
          const policies = JSON.parse(cached);
          this.policyCache.set(cacheKey, policies);
          return policies;
        }
      } catch (error) {
        console.warn('Redis policy cache miss:', error.message);
      }
    }

    // Fetch from DynamoDB
    const command = new QueryCommand({
      TableName: this.policyStoreTable,
      IndexName: 'StatusIndex',
      KeyConditionExpression: 'statusIndex = :status',
      ExpressionAttributeValues: {
        ':status': { S: 'active' }
      }
    });

    const result = await this.dynamodb.send(command);
    const policies = result.Items?.map(item => unmarshall(item) as PolicyRecord) || [];

    // Cache locally and in Redis
    this.policyCache.set(cacheKey, policies);
    if (this.redis) {
      await this.redis.setex(`policies:${cacheKey}`, this.CACHE_TTL.POLICIES, JSON.stringify(policies));
    }

    return policies;
  }

  /**
   * Get entity attributes with caching
   */
  private async getEntityAttributes(entityType: string, entityId: string): Promise<EntityAttributes> {
    const cacheKey = `${entityType}:${entityId}`;
    
    // Check local cache first
    if (this.entityCache.has(cacheKey)) {
      return this.entityCache.get(cacheKey)!;
    }

    // Check Redis cache
    if (this.redis) {
      try {
        const cached = await this.redis.get(`entity:${cacheKey}`);
        if (cached) {
          const attributes = JSON.parse(cached);
          this.entityCache.set(cacheKey, attributes);
          return attributes;
        }
      } catch (error) {
        console.warn('Redis entity cache miss:', error.message);
      }
    }

    // Fetch from DynamoDB
    const command = new GetItemCommand({
      TableName: this.entityStoreTable,
      Key: {
        entityType: { S: entityType },
        entityId: { S: entityId }
      }
    });

    const result = await this.dynamodb.send(command);
    const attributes = result.Item ? unmarshall(result.Item) : { entityType, entityId };

    // Cache locally and in Redis
    this.entityCache.set(cacheKey, attributes);
    if (this.redis) {
      await this.redis.setex(`entity:${cacheKey}`, this.CACHE_TTL.ENTITIES, JSON.stringify(attributes));
    }

    return attributes;
  }

  /**
   * Generate cache key for authorization request
   */
  private generateCacheKey(request: AuthorizationRequest): string {
    const key = [
      request.principal.entityType,
      request.principal.entityId,
      request.action.actionType,
      request.action.actionId,
      request.resource.entityType,
      request.resource.entityId,
      JSON.stringify(request.context || {})
    ].join(':');
    
    // Hash for consistent key length
    return `auth:${this.simpleHash(key)}`;
  }

  /**
   * Simple hash function for cache keys
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get cached authorization result
   */
  private async getCachedResult(cacheKey: string): Promise<CacheEntry | null> {
    if (!this.redis) return null;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const entry: CacheEntry = JSON.parse(cached);
        
        // Check if cache entry is still valid
        if (Date.now() - entry.timestamp < entry.ttl * 1000) {
          return entry;
        }
        
        // Remove expired entry
        await this.redis.del(cacheKey);
      }
    } catch (error) {
      console.warn('Redis cache get error:', error.message);
    }

    return null;
  }

  /**
   * Cache authorization result
   */
  private async cacheResult(cacheKey: string, result: any, latency: number): Promise<void> {
    if (!this.redis) return;

    try {
      const entry: CacheEntry = {
        decision: result.decision,
        determiningPolicies: result.determiningPolicies,
        timestamp: Date.now(),
        ttl: this.CACHE_TTL.AUTHORIZATION
      };

      await this.redis.setex(cacheKey, this.CACHE_TTL.AUTHORIZATION, JSON.stringify(entry));
    } catch (error) {
      console.warn('Redis cache set error:', error.message);
    }
  }

  /**
   * Build Cedar entities format
   */
  private buildCedarEntities(principalEntity: EntityAttributes, resourceEntity: EntityAttributes, request: AuthorizationRequest): Record<string, any> {
    return {
      [`${request.principal.entityType}::"${request.principal.entityId}"`]: {
        attrs: { ...principalEntity, ...request.principal.attributes },
        parents: []
      },
      [`${request.resource.entityType}::"${request.resource.entityId}"`]: {
        attrs: { ...resourceEntity, ...request.resource.attributes },
        parents: []
      }
    };
  }

  /**
   * Build evaluation context
   */
  private buildEvaluationContext(request: AuthorizationRequest): Record<string, any> {
    return {
      ...DEFAULT_CONTEXT,
      ...request.context,
      requestId: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    };
  }

  /**
   * Record performance metrics
   */
  private async recordMetrics(type: 'CACHE_HIT' | 'CACHE_MISS' | 'ERROR', latency: number): Promise<void> {
    if (process.env.ENABLE_DETAILED_METRICS !== 'true') return;

    try {
      const metrics = [
        {
          MetricName: 'AuthorizationLatency',
          Value: latency,
          Unit: 'Milliseconds',
          Dimensions: [
            { Name: 'CacheType', Value: type },
            { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
          ]
        },
        {
          MetricName: 'AuthorizationRequests',
          Value: 1,
          Unit: 'Count',
          Dimensions: [
            { Name: 'CacheType', Value: type },
            { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
          ]
        }
      ];

      // Add performance alarm metrics
      if (latency > this.PERFORMANCE_TARGETS.MAX_LATENCY) {
        metrics.push({
          MetricName: 'SlowAuthorizations',
          Value: 1,
          Unit: 'Count',
          Dimensions: [
            { Name: 'Environment', Value: process.env.ENVIRONMENT || 'unknown' }
          ]
        });
      }

      await this.cloudwatch.send(new PutMetricDataCommand({
        Namespace: 'Loupeen/GameAuth',
        MetricData: metrics
      }));

    } catch (error) {
      console.warn('Failed to send metrics:', error.message);
    }
  }

  /**
   * Health check for the authorization service
   */
  async healthCheck(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    checks: Record<string, boolean>;
    latency: number;
  }> {
    const startTime = process.hrtime.bigint();
    const checks: Record<string, boolean> = {};

    // Check DynamoDB connectivity
    try {
      await this.dynamodb.send(new QueryCommand({
        TableName: this.policyStoreTable,
        KeyConditionExpression: 'policyId = :id',
        ExpressionAttributeValues: { ':id': { S: 'health-check' } },
        Limit: 1
      }));
      checks.dynamodb = true;
    } catch {
      checks.dynamodb = false;
    }

    // Check Redis connectivity
    if (this.redis) {
      try {
        await this.redis.ping();
        checks.redis = true;
      } catch {
        checks.redis = false;
      }
    } else {
      checks.redis = true; // Redis is optional
    }

    const latency = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    const allHealthy = Object.values(checks).every(check => check);
    
    return {
      status: allHealthy ? 'healthy' : 'degraded',
      checks,
      latency
    };
  }
}

// Lambda handler
export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
  const authService = new EnhancedAuthorizationService();
  
  try {
    // Parse request body
    const requestBody = JSON.parse(event.body || '{}');
    
    // Handle different actions
    switch (event.path) {
      case '/authorize':
        const result = await authService.authorize(requestBody);
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            success: true,
            result
          })
        };

      case '/health':
        const health = await authService.healthCheck();
        return {
          statusCode: health.status === 'healthy' ? 200 : 503,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            success: health.status === 'healthy',
            health
          })
        };

      default:
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            success: false,
            message: 'Endpoint not found'
          })
        };
    }

  } catch (error) {
    console.error('Enhanced authorization service error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        message: 'Internal server error',
        error: error.message
      })
    };
  }
};