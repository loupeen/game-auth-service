import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

interface PolicyRequest {
  action: 'create' | 'update' | 'delete' | 'list' | 'validate';
  policyId?: string;
  policyContent?: string;
  policyType?: string;
  version?: string;
  priority?: number;
}

interface PolicyRecord {
  policyId: string;
  policyContent: string;
  policyType: string;
  version: string;
  priority: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

class CedarPolicyManagementService {
  private dynamodb: DynamoDBClient;
  private policyStoreTable: string;
  
  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.REGION });
    this.policyStoreTable = process.env.POLICY_STORE_TABLE!;
  }

  async createPolicy(policyData: Partial<PolicyRecord>, userId: string): Promise<PolicyRecord> {
    // Validate policy content
    if (!policyData.policyContent) {
      throw new Error('Policy content is required');
    }

    // Validate Cedar syntax
    await this.validatePolicyContent(policyData.policyContent);

    const policyId = policyData.policyId || this.generatePolicyId(policyData.policyType || 'custom');
    const version = policyData.version || '1.0.0';
    const timestamp = Date.now();

    const policy: PolicyRecord = {
      policyId,
      policyContent: policyData.policyContent,
      policyType: policyData.policyType || 'custom',
      version,
      priority: policyData.priority || 100,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: userId
    };

    const command = new PutItemCommand({
      TableName: this.policyStoreTable,
      Item: marshall(policy),
      ConditionExpression: 'attribute_not_exists(policyId) AND attribute_not_exists(version)'
    });

    await this.dynamodb.send(command);
    return policy;
  }

  async updatePolicy(policyId: string, version: string, updates: Partial<PolicyRecord>, userId: string): Promise<PolicyRecord> {
    // If updating policy content, validate it
    if (updates.policyContent) {
      await this.validatePolicyContent(updates.policyContent);
    }

    const updateExpression: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    // Build update expression
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'policyId' && key !== 'version' && key !== 'createdAt' && key !== 'createdBy') {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    });

    // Always update the updatedAt timestamp
    updateExpression.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = Date.now();

    const command = new UpdateItemCommand({
      TableName: this.policyStoreTable,
      Key: {
        policyId: { S: policyId },
        version: { S: version }
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
      ConditionExpression: 'attribute_exists(policyId) AND attribute_exists(version)',
      ReturnValues: 'ALL_NEW'
    });

    const result = await this.dynamodb.send(command);
    return unmarshall(result.Attributes!) as PolicyRecord;
  }

  async deletePolicy(policyId: string, version: string): Promise<void> {
    const command = new DeleteItemCommand({
      TableName: this.policyStoreTable,
      Key: {
        policyId: { S: policyId },
        version: { S: version }
      },
      ConditionExpression: 'attribute_exists(policyId) AND attribute_exists(version)'
    });

    await this.dynamodb.send(command);
  }

  async listPolicies(policyType?: string, activeOnly: boolean = true): Promise<PolicyRecord[]> {
    let command;

    if (policyType) {
      command = new QueryCommand({
        TableName: this.policyStoreTable,
        IndexName: 'PolicyTypeIndex',
        KeyConditionExpression: 'policyType = :policyType',
        FilterExpression: activeOnly ? 'isActive = :active' : undefined,
        ExpressionAttributeValues: marshall({
          ':policyType': policyType,
          ...(activeOnly && { ':active': true })
        })
      });
    } else {
      command = new QueryCommand({
        TableName: this.policyStoreTable,
        IndexName: 'ActivePoliciesIndex',
        KeyConditionExpression: 'isActive = :active',
        ExpressionAttributeValues: marshall({
          ':active': activeOnly ? 'true' : 'false'
        })
      });
    }

    const result = await this.dynamodb.send(command);
    return result.Items?.map(item => unmarshall(item) as PolicyRecord) || [];
  }

  private async validatePolicyContent(policyContent: string): Promise<void> {
    try {
      // Use Cedar WASM to validate policy syntax
      const result = cedar.checkParsePolicySet({ staticPolicies: policyContent });
      if (result.type === 'failure') {
        throw new Error(`Invalid Cedar policy syntax: ${result.errors?.map(e => e.message).join(', ')}`);
      }
    } catch (error) {
      throw new Error(`Invalid Cedar policy syntax: ${error}`);
    }
  }

  private generatePolicyId(policyType: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${policyType}-${timestamp}-${random}`;
  }

  async initializeDefaultPolicies(): Promise<PolicyRecord[]> {
    const defaultPolicies = [
      {
        policyId: 'player-base-permissions',
        policyType: 'player',
        priority: 100,
        policyContent: `
// Basic player permissions
permit (
  principal in GameUser::Players,
  action in [
    GameAction::"login",
    GameAction::"logout", 
    GameAction::"viewProfile",
    GameAction::"updateProfile"
  ],
  resource
) when {
  principal.isActive == true &&
  (resource.owner == principal || resource.resourceType == "public")
};

// Player can collect their own resources
permit (
  principal in GameUser::Players,
  action == GameAction::"collectResources",
  resource
) when {
  principal.isActive == true &&
  resource.owner == principal &&
  context.lastCollection + 3600 <= context.currentTime
};`
      },
      {
        policyId: 'alliance-member-permissions',
        policyType: 'alliance',
        priority: 200,
        policyContent: `
// Alliance member permissions
permit (
  principal in GameUser::AllianceMembers,
  action in [
    GameAction::"viewAllianceInfo",
    GameAction::"sendMessage",
    GameAction::"requestSupport",
    GameAction::"participateInBattle"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance
};

// Alliance member voting
permit (
  principal in GameUser::AllianceMembers,
  action == GameAction::"voteOnDecisions",
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  context.votingOpen == true &&
  !context.alreadyVoted.contains(principal.userId)
};`
      },
      {
        policyId: 'alliance-leader-permissions',
        policyType: 'alliance-leader',
        priority: 300,
        policyContent: `
// Alliance leader permissions
permit (
  principal in GameUser::AllianceLeaders,
  action in [
    GameAction::"inviteMember",
    GameAction::"kickMember", 
    GameAction::"promoteMember",
    GameAction::"setAlliancePolicy",
    GameAction::"manageResources"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance == resource.alliance &&
  (resource.targetUser.hierarchy < principal.hierarchy || action == GameAction::"inviteMember")
};

// Alliance leaders can declare war
permit (
  principal in GameUser::AllianceLeaders,
  action in [
    GameAction::"declareWar",
    GameAction::"proposePeace"
  ],
  resource
) when {
  principal.isActive == true &&
  principal.alliance != resource.targetAlliance &&
  context.diplomaticActionsEnabled == true
};`
      },
      {
        policyId: 'admin-permissions',
        policyType: 'admin',
        priority: 1000,
        policyContent: `
// System administrator permissions
permit (
  principal in GameUser::Admins,
  action in [
    GameAction::"banUser",
    GameAction::"unbanUser",
    GameAction::"resetGameState",
    GameAction::"modifyGameConfig",
    GameAction::"viewSystemLogs"
  ],
  resource
);

// Emergency admin actions
permit (
  principal in GameUser::Admins,
  action in [
    GameAction::"emergencyShutdown",
    GameAction::"rollbackGameState"
  ],
  resource
) when {
  context.emergencyLevel >= 3 ||
  context.approvals.contains("senior-admin")
};`
      },
      {
        policyId: 'combat-permissions',
        policyType: 'combat',
        priority: 400,
        policyContent: `
// Player vs Player combat
permit (
  principal in GameUser::Players,
  action == GameAction::"attack",
  resource
) when {
  principal.isActive == true &&
  principal.level >= (resource.target.level - 10) &&
  principal.level <= (resource.target.level + 10) &&
  principal.alliance != resource.target.alliance &&
  context.pvpEnabled == true &&
  !context.protectedNewPlayer.contains(resource.target.userId)
};

// Alliance warfare
permit (
  principal in GameUser::AllianceMembers,
  action in [
    GameAction::"attack",
    GameAction::"reinforce",
    GameAction::"groupAttack"
  ],
  resource
) when {
  principal.isActive == true &&
  (
    (principal.alliance.wars.contains(resource.target.alliance) && 
     context.warActive == true) ||
    (context.battleType == "tournament" && 
     context.tournamentParticipants.contains(principal.alliance))
  )
};`
      }
    ];

    const createdPolicies: PolicyRecord[] = [];

    for (const policyData of defaultPolicies) {
      try {
        const policy = await this.createPolicy(policyData, 'system');
        createdPolicies.push(policy);
        console.log(`Created default policy: ${policy.policyId}`);
      } catch (error) {
        console.error(`Failed to create policy ${policyData.policyId}:`, error);
      }
    }

    return createdPolicies;
  }
}

// Global instance
let policyService: CedarPolicyManagementService;

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  console.log('Cedar Policy Management Request:', JSON.stringify(event, null, 2));
  
  if (!policyService) {
    policyService = new CedarPolicyManagementService();
  }

  try {
    const request: PolicyRequest = JSON.parse(event.body || '{}');
    const userId = event.requestContext?.authorizer?.userId || 'unknown';

    let result: any;

    switch (request.action) {
      case 'create':
        if (!request.policyContent) {
          throw new Error('Policy content is required for create action');
        }
        result = await policyService.createPolicy({
          policyId: request.policyId,
          policyContent: request.policyContent,
          policyType: request.policyType,
          version: request.version,
          priority: request.priority
        }, userId);
        break;

      case 'update':
        if (!request.policyId || !request.version) {
          throw new Error('Policy ID and version are required for update action');
        }
        result = await policyService.updatePolicy(
          request.policyId,
          request.version,
          {
            policyContent: request.policyContent,
            policyType: request.policyType,
            priority: request.priority
          },
          userId
        );
        break;

      case 'delete':
        if (!request.policyId || !request.version) {
          throw new Error('Policy ID and version are required for delete action');
        }
        await policyService.deletePolicy(request.policyId, request.version);
        result = { success: true, message: 'Policy deleted successfully' };
        break;

      case 'list':
        result = await policyService.listPolicies(request.policyType);
        break;

      case 'validate':
        if (!request.policyContent) {
          throw new Error('Policy content is required for validate action');
        }
        await policyService['validatePolicyContent'](request.policyContent);
        result = { valid: true, message: 'Policy syntax is valid' };
        break;

      default:
        throw new Error(`Unknown action: ${request.action}`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Policy management error:', error);
    
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Policy management failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};