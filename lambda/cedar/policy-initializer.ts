import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse, Context } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import * as https from 'https';
import * as url from 'url';

interface PolicyRecord {
  policyId: string;
  policyContent: string;
  policyType: string;
  version: string;
  priority: number;
  isActive: string; // GSI requires string for index key
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

class PolicyInitializerService {
  private dynamodb: DynamoDBClient;
  private policyStoreTable: string;
  private entityStoreTable: string;
  
  constructor() {
    this.dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION });
    this.policyStoreTable = process.env.POLICY_STORE_TABLE!;
    this.entityStoreTable = process.env.ENTITY_STORE_TABLE!;
  }

  async initializeDefaultPolicies(): Promise<PolicyRecord[]> {
    const defaultPolicies = [
      {
        policyId: 'player-base-permissions',
        policyType: 'player',
        priority: 100,
        policyContent: `
// Basic player permissions - self-management
permit (
  principal in Group::"Players",
  action in [
    Action::"login",
    Action::"logout",
    Action::"viewProfile", 
    Action::"updateProfile",
    Action::"buildStructure",
    Action::"collectResources"
  ],
  resource
);`
      },
      {
        policyId: 'alliance-member-permissions',
        policyType: 'alliance',
        priority: 200,
        policyContent: `
// Alliance member permissions
permit (
  principal in Group::"AllianceMembers",
  action in [
    Action::"viewAllianceInfo",
    Action::"sendMessage",
    Action::"requestSupport",
    Action::"participateInBattle",
    Action::"shareResources"
  ],
  resource
);`
      },
      {
        policyId: 'alliance-leader-permissions',
        policyType: 'alliance-leader',
        priority: 300,
        policyContent: `
// Alliance leader permissions
permit (
  principal in Group::"AllianceLeaders",
  action in [
    Action::"inviteMember",
    Action::"kickMember",
    Action::"promoteMember", 
    Action::"setAlliancePolicy",
    Action::"manageResources",
    Action::"declareWar",
    Action::"proposePeace"
  ],
  resource
);`
      },
      {
        policyId: 'admin-permissions',
        policyType: 'admin',
        priority: 1000,
        policyContent: `
// System administrator permissions
permit (
  principal in Group::"Administrators",
  action in [
    Action::"banUser",
    Action::"unbanUser",
    Action::"resetGameState",
    Action::"modifyGameConfig",
    Action::"viewSystemLogs",
    Action::"manageEvents"
  ],
  resource
);`
      },
      {
        policyId: 'combat-permissions',
        policyType: 'combat',
        priority: 400,
        policyContent: `
// Player vs Player combat with level restrictions
permit (
  principal in Group::"Players",
  action == Action::"attackBase",
  resource
);`
      }
    ];

    const createdPolicies: PolicyRecord[] = [];
    const timestamp = Date.now();

    for (const policyData of defaultPolicies) {
      try {
        const policy: PolicyRecord = {
          policyId: policyData.policyId,
          policyContent: policyData.policyContent.trim(),
          policyType: policyData.policyType,
          version: '1.0.0',
          priority: policyData.priority,
          isActive: 'true' as any, // DynamoDB GSI expects string
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: 'system-initializer'
        };

        const command = new PutItemCommand({
          TableName: this.policyStoreTable,
          Item: marshall(policy),
          ConditionExpression: 'attribute_not_exists(policyId)'
        });

        await this.dynamodb.send(command);
        createdPolicies.push(policy);
        console.log(`✅ Created default policy: ${policy.policyId}`);
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
          console.log(`ℹ️  Policy ${policyData.policyId} already exists, skipping`);
        } else {
          console.error(`❌ Failed to create policy ${policyData.policyId}:`, error);
        }
      }
    }

    return createdPolicies;
  }

  async initializeDefaultEntities(): Promise<void> {
    // Initialize basic role entities that policies reference
    const roleEntities = [
      {
        entityType: 'Role',
        entityId: 'Player',
        attributes: {
          name: 'Player',
          description: 'Basic game player',
          hierarchy: 1
        }
      },
      {
        entityType: 'Role', 
        entityId: 'AllianceMember',
        attributes: {
          name: 'Alliance Member',
          description: 'Member of an alliance',
          hierarchy: 2
        }
      },
      {
        entityType: 'Role',
        entityId: 'AllianceOfficer',
        attributes: {
          name: 'Alliance Officer',
          description: 'Alliance officer with management permissions',
          hierarchy: 3
        }
      },
      {
        entityType: 'Role',
        entityId: 'AllianceLeader',
        attributes: {
          name: 'Alliance Leader',
          description: 'Leader of an alliance',
          hierarchy: 4
        }
      },
      {
        entityType: 'Role',
        entityId: 'Admin',
        attributes: {
          name: 'Administrator',
          description: 'System administrator',
          hierarchy: 10
        }
      }
    ];

    const timestamp = Date.now();

    for (const entityData of roleEntities) {
      try {
        const entity = {
          ...entityData,
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1
        };

        const command = new PutItemCommand({
          TableName: this.entityStoreTable,
          Item: marshall(entity),
          ConditionExpression: 'attribute_not_exists(entityType) AND attribute_not_exists(entityId)'
        });

        await this.dynamodb.send(command);
        console.log(`✅ Created role entity: ${entityData.entityId}`);
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
          console.log(`ℹ️  Role entity ${entityData.entityId} already exists, skipping`);
        } else {
          console.error(`❌ Failed to create role entity ${entityData.entityId}:`, error);
        }
      }
    }
  }
}

// Send response to CloudFormation
function sendResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  responseStatus: 'SUCCESS' | 'FAILED',
  responseData?: any,
  physicalResourceId?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const responseBody = JSON.stringify({
      Status: responseStatus,
      Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
      PhysicalResourceId: physicalResourceId || context.logStreamName,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: responseData
    });

    console.log('Response body:', responseBody);

    const parsedUrl = url.parse(event.ResponseURL);
    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.path,
      method: 'PUT',
      headers: {
        'content-type': '',
        'content-length': responseBody.length
      }
    };

    const request = https.request(options, (response) => {
      console.log('Status code:', response.statusCode);
      console.log('Status message:', response.statusMessage);
      resolve();
    });

    request.on('error', (error) => {
      console.log('send(..) failed executing https.request(..):', error);
      reject(error);
    });

    request.write(responseBody);
    request.end();
  });
}

export const handler = async (
  event: CloudFormationCustomResourceEvent,
  context: Context
): Promise<void> => {
  console.log('Policy Initializer Event:', JSON.stringify(event, null, 2));

  const policyInitializer = new PolicyInitializerService();

  try {
    if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      console.log('🚀 Initializing Cedar authorization system...');
      
      // Initialize default policies
      const policies = await policyInitializer.initializeDefaultPolicies();
      console.log(`✅ Initialized ${policies.length} default policies`);
      
      // Initialize default entities
      await policyInitializer.initializeDefaultEntities();
      console.log('✅ Initialized default role entities');

      await sendResponse(event, context, 'SUCCESS', {
        Message: 'Cedar authorization system initialized successfully',
        PoliciesCreated: policies.length,
        Environment: process.env.ENVIRONMENT
      });

    } else if (event.RequestType === 'Delete') {
      console.log('🗑️  Delete request - no action needed for policies');
      
      await sendResponse(event, context, 'SUCCESS', {
        Message: 'Delete completed - policies retained for audit'
      });
    }

  } catch (error) {
    console.error('❌ Policy initialization failed:', error);
    
    await sendResponse(event, context, 'FAILED', {
      Error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};