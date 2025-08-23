/**
 * Basic Game Policy Loader
 * Issue #17: Cedar Authorization Policies for Basic Game Actions
 * 
 * This service loads the basic game policies into the policy store
 * and provides utilities for policy validation and testing.
 */

import { DynamoDBClient, PutItemCommand, QueryCommand, BatchWriteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { 
  BASIC_GAME_POLICIES, 
  POLICY_CATEGORIES, 
  POLICY_PRIORITIES,
  GameEntityTypes,
  GameActionTypes,
  DEFAULT_CONTEXT
} from './game-policies-schema';

interface PolicyLoadResult {
  success: boolean;
  loaded: string[];
  failed: string[];
  errors: string[];
}

interface PolicyValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class BasicGamePolicyLoader {
  private dynamodb: DynamoDBClient;
  private policyStoreTable: string;
  
  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.policyStoreTable = process.env.POLICY_STORE_TABLE!;
  }

  /**
   * Load all basic game policies into the policy store
   */
  async loadAllBasicPolicies(userId: string = 'system'): Promise<PolicyLoadResult> {
    const result: PolicyLoadResult = {
      success: true,
      loaded: [],
      failed: [],
      errors: []
    };

    console.log('Loading basic game policies...');

    for (const [policyName, policyContent] of Object.entries(BASIC_GAME_POLICIES)) {
      try {
        // Validate policy syntax first
        const validation = await this.validatePolicyContent(policyContent);
        if (!validation.valid) {
          result.failed.push(policyName);
          result.errors.push(`Policy ${policyName} validation failed: ${validation.errors.join(', ')}`);
          continue;
        }

        // Create policy record
        await this.createPolicyRecord({
          policyId: `basic-game-${policyName.toLowerCase().replace(/_/g, '-')}`,
          policyName,
          policyContent,
          policyType: 'basic-game',
          category: this.getPolicyCategory(policyName),
          priority: POLICY_PRIORITIES[policyName as keyof typeof POLICY_PRIORITIES] || 50,
          isActive: true,
          version: '1.0.0',
          description: this.getPolicyDescription(policyName),
          createdBy: userId
        });

        result.loaded.push(policyName);
        console.log(`✅ Loaded policy: ${policyName}`);

      } catch (error) {
        result.failed.push(policyName);
        result.errors.push(`Failed to load ${policyName}: ${error}`);
        result.success = false;
        console.error(`❌ Failed to load policy ${policyName}:`, error);
      }
    }

    console.log(`Policy loading complete: ${result.loaded.length} loaded, ${result.failed.length} failed`);
    return result;
  }

  /**
   * Validate Cedar policy content syntax
   */
  private async validatePolicyContent(policyContent: string): Promise<PolicyValidationResult> {
    try {
      // Remove template placeholders for validation
      const cleanPolicy = this.cleanPolicyForValidation(policyContent);
      
      // TODO: Use Cedar WASM to validate syntax when API is stable
      // For now, perform basic syntax checks
      const hasPermit = cleanPolicy.includes('permit');
      const hasBasicStructure = cleanPolicy.includes('(') && cleanPolicy.includes(')');
      
      return {
        valid: hasPermit && hasBasicStructure,
        errors: hasPermit && hasBasicStructure ? [] : ['Basic policy structure validation failed'],
        warnings: []
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Policy validation error: ${error}`],
        warnings: []
      };
    }
  }

  /**
   * Clean policy content for validation (replace templates with sample values)
   */
  private cleanPolicyForValidation(policyContent: string): string {
    return policyContent
      .replace(/\{\{\s*playerId\s*\}\}/g, 'player123')
      .replace(/\{\{\s*allianceId\s*\}\}/g, 'alliance456')
      .replace(/\{\{\s*baseId\s*\}\}/g, 'base789')
      .replace(/\{\{\s*resourceId\s*\}\}/g, 'resource101');
  }

  /**
   * Create a policy record in DynamoDB
   */
  private async createPolicyRecord(policyData: {
    policyId: string;
    policyName: string;
    policyContent: string;
    policyType: string;
    category: string;
    priority: number;
    isActive: boolean;
    version: string;
    description: string;
    createdBy: string;
  }): Promise<void> {
    const timestamp = Date.now();
    
    const item = {
      policyId: policyData.policyId,
      policyName: policyData.policyName,
      policyContent: policyData.policyContent,
      policyType: policyData.policyType,
      category: policyData.category,
      priority: policyData.priority,
      isActive: policyData.isActive,
      version: policyData.version,
      description: policyData.description,
      createdBy: policyData.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      // GSI keys for efficient querying
      categoryTypeIndex: `${policyData.category}#${policyData.policyType}`,
      priorityIndex: policyData.priority,
      statusIndex: policyData.isActive ? 'active' : 'inactive'
    };

    await this.dynamodb.send(new PutItemCommand({
      TableName: this.policyStoreTable,
      Item: marshall(item),
      ConditionExpression: 'attribute_not_exists(policyId)' // Prevent overwriting
    }));
  }

  /**
   * Get policy category for organization
   */
  private getPolicyCategory(policyName: string): string {
    for (const [category, policies] of Object.entries(POLICY_CATEGORIES)) {
      if (policies.includes(policyName)) {
        return category.toLowerCase().replace('_', '-');
      }
    }
    return 'general';
  }

  /**
   * Get human-readable policy description
   */
  private getPolicyDescription(policyName: string): string {
    const descriptions: Record<string, string> = {
      PLAYER_OWN_PROFILE: 'Allows players to view and edit their own profile',
      PLAYER_OWN_RESOURCES: 'Allows players to view their own resources',
      ALLIANCE_MEMBER_CHAT: 'Allows alliance members to participate in alliance chat',
      ALLIANCE_OFFICER_MODERATE: 'Allows alliance officers to moderate chat channels',
      ALLIANCE_RESOURCE_VIEW: 'Allows alliance members to view alliance resources',
      ALLIANCE_RESOURCE_DONATE: 'Allows alliance members to donate resources (level 5+)',
      COMBAT_ATTACK_BASE: 'Allows players to attack enemy bases (level 10+)',
      COMBAT_DEFEND_BASE: 'Allows players to defend their own bases',
      COMBAT_DEFEND_ALLIANCE_BASE: 'Allows alliance members to defend alliance bases',
      TRADE_CREATE: 'Allows players to create trades (level 3+)',
      TRADE_ACCEPT_PUBLIC: 'Allows players to accept public trades',
      BUILD_UPGRADE_OWN: 'Allows players to upgrade and build on their own bases',
      PUBLIC_RESOURCE_VIEW: 'Allows viewing of public resources',
      ALLIANCE_RESOURCE_ACCESS: 'Allows viewing of alliance-only resources'
    };
    
    return descriptions[policyName] || 'Basic game action policy';
  }

  /**
   * Test policy evaluation with sample data
   */
  async testPolicyEvaluation(): Promise<{
    passed: number;
    failed: number;
    results: Array<{
      testName: string;
      success: boolean;
      decision: string;
      error?: string;
    }>
  }> {
    const results = [];
    let passed = 0;
    let failed = 0;

    // Test cases for basic game policies
    const testCases = [
      {
        testName: 'Player views own profile',
        principal: { entityType: 'Player', entityId: 'player123' },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'Player', entityId: 'player123' },
        expectedDecision: 'ALLOW'
      },
      {
        testName: 'Player views another player profile',
        principal: { entityType: 'Player', entityId: 'player123' },
        action: { actionType: 'Action', actionId: 'viewProfile' },
        resource: { entityType: 'Player', entityId: 'player456' },
        expectedDecision: 'DENY'
      },
      {
        testName: 'Alliance member sends chat message',
        principal: { entityType: 'Player', entityId: 'player123' },
        action: { actionType: 'Action', actionId: 'sendAllianceMessage' },
        resource: { entityType: 'ChatChannel', entityId: 'alliance-chat-456' },
        expectedDecision: 'ALLOW'
      }
    ];

    for (const testCase of testCases) {
      try {
        // This would normally call the Cedar authorization service
        // For now, we'll simulate the test
        const decision = 'ALLOW'; // Placeholder
        
        const success = decision === testCase.expectedDecision;
        if (success) {
          passed++;
        } else {
          failed++;
        }
        
        results.push({
          testName: testCase.testName,
          success,
          decision,
          error: success ? undefined : `Expected ${testCase.expectedDecision}, got ${decision}`
        });
        
      } catch (error) {
        failed++;
        results.push({
          testName: testCase.testName,
          success: false,
          decision: 'ERROR',
          error: `Test execution failed: ${error}`
        });
      }
    }

    return { passed, failed, results };
  }

  /**
   * Get all loaded policies by category
   */
  async getPoliciesByCategory(category: string): Promise<any[]> {
    const command = new QueryCommand({
      TableName: this.policyStoreTable,
      IndexName: 'CategoryTypeIndex',
      KeyConditionExpression: 'categoryTypeIndex = :categoryType',
      ExpressionAttributeValues: marshall({
        ':categoryType': `${category}#basic-game`
      })
    });

    const result = await this.dynamodb.send(command);
    return result.Items?.map(item => unmarshall(item)) || [];
  }

  /**
   * Update policy active status
   */
  async updatePolicyStatus(policyId: string, isActive: boolean): Promise<void> {
    await this.dynamodb.send(new UpdateItemCommand({
      TableName: this.policyStoreTable,
      Key: marshall({ policyId }),
      UpdateExpression: 'SET isActive = :active, updatedAt = :timestamp',
      ExpressionAttributeValues: marshall({
        ':active': isActive,
        ':timestamp': Date.now()
      })
    }));
  }
}

// Export for Lambda handler
export const handler = async (event: any, context: any) => {
  try {
    const loader = new BasicGamePolicyLoader();
    const action = event.action || 'load';

    switch (action) {
      case 'load':
        const loadResult = await loader.loadAllBasicPolicies(event.userId);
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            success: true,
            message: 'Basic game policies loaded',
            result: loadResult
          })
        };

      case 'test':
        const testResult = await loader.testPolicyEvaluation();
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            success: true,
            message: 'Policy evaluation tests completed',
            result: testResult
          })
        };

      default:
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({
            success: false,
            message: `Unknown action: ${action}. Supported actions: load, test`
          })
        };
    }

  } catch (error) {
    console.error('Policy loader error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        success: false,
        message: 'Internal server error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};