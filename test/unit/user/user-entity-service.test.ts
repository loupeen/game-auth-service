import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../lambda/user/user-entity-service';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

// Mock AWS SDK
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/client-cognito-identity-provider');

const mockDynamoDBSend = jest.fn();
const mockCognitoSend = jest.fn();

beforeAll(() => {
  (DynamoDBClient as jest.Mock).mockImplementation(() => ({
    send: mockDynamoDBSend
  }));
  
  (CognitoIdentityProviderClient as jest.Mock).mockImplementation(() => ({
    send: mockCognitoSend
  }));
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENTITY_STORE_TABLE = 'test-entity-store';
  process.env.PLAYER_USER_POOL_ID = 'test-player-pool';
  process.env.ADMIN_USER_POOL_ID = 'test-admin-pool';
  process.env.REGION = 'eu-north-1';
});

describe('User Entity Service', () => {
  const mockEvent: Partial<APIGatewayProxyEvent> = {
    body: '',
    headers: {},
    pathParameters: {}
  };

  describe('Get User Profile', () => {
    it('should return user profile when user exists', async () => {
      // Mock DynamoDB response
      mockDynamoDBSend.mockResolvedValueOnce({
        Item: {
          entityType: { S: 'GameUser' },
          entityId: { S: 'user123' },
          attributes: {
            M: {
              username: { S: 'testuser' },
              level: { N: '10' },
              experience: { N: '5000' },
              resources: {
                M: {
                  food: { N: '1000' },
                  wood: { N: '800' },
                  stone: { N: '600' },
                  iron: { N: '400' },
                  gold: { N: '200' }
                }
              }
            }
          },
          relationships: {
            M: {
              roles: { SS: ['player'] }
            }
          },
          createdAt: { N: '1640995200000' },
          updatedAt: { N: '1640995200000' }
        }
      });

      // Mock Cognito response
      mockCognitoSend.mockResolvedValueOnce({
        Username: 'user123',
        Attributes: [
          { Name: 'email', Value: 'test@example.com' }
        ]
      });

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'get',
          userId: 'user123'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.userId).toBe('user123');
      expect(body.username).toBe('testuser');
      expect(body.level).toBe(10);
      expect(body.resources.food).toBe(1000);
      expect(body.roles).toEqual(['player']);
    });

    it('should return 404 when user does not exist', async () => {
      mockDynamoDBSend.mockResolvedValueOnce({
        Item: undefined
      });

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'get',
          userId: 'nonexistent'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('User profile not found');
    });

    it('should return 400 when user ID is missing', async () => {
      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'get'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('User entity service failed');
      expect(body.message).toBe('User ID is required for get action');
    });
  });

  describe('Update User Profile', () => {
    it('should update user profile successfully', async () => {
      // Mock get existing entity
      mockDynamoDBSend.mockResolvedValueOnce({
        Item: {
          entityType: { S: 'GameUser' },
          entityId: { S: 'user123' },
          attributes: {
            M: {
              level: { N: '10' },
              gameSettings: {
                M: {
                  notifications: { BOOL: true },
                  soundEnabled: { BOOL: true }
                }
              }
            }
          },
          relationships: { M: {} },
          createdAt: { N: '1640995200000' },
          version: { N: '1' }
        }
      });

      // Mock update response
      mockDynamoDBSend.mockResolvedValueOnce({
        Attributes: {
          entityType: { S: 'GameUser' },
          entityId: { S: 'user123' },
          attributes: {
            M: {
              level: { N: '11' },
              gameSettings: {
                M: {
                  notifications: { BOOL: false },
                  soundEnabled: { BOOL: true }
                }
              },
              lastActive: { N: Date.now().toString() }
            }
          },
          updatedAt: { N: Date.now().toString() }
        }
      });

      // Mock final get for return value
      mockDynamoDBSend.mockResolvedValueOnce({
        Item: {
          entityType: { S: 'GameUser' },
          entityId: { S: 'user123' },
          attributes: {
            M: {
              username: { S: 'testuser' },
              level: { N: '11' },
              gameSettings: {
                M: {
                  notifications: { BOOL: false },
                  soundEnabled: { BOOL: true }
                }
              }
            }
          },
          relationships: { M: { roles: { SS: ['player'] } } },
          createdAt: { N: '1640995200000' }
        }
      });

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'update',
          userId: 'user123',
          profileUpdates: {
            level: 11,
            gameSettings: {
              notifications: false,
              soundEnabled: true
            }
          }
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.userId).toBe('user123');
      expect(body.level).toBe(11);
      expect(body.gameSettings.notifications).toBe(false);
    });

    it('should return 400 when updates are missing', async () => {
      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'update',
          userId: 'user123'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('User ID and profile updates are required for update action');
    });
  });

  describe('Alliance Operations', () => {
    it('should allow user to join alliance', async () => {
      // Mock successful update
      mockDynamoDBSend.mockResolvedValueOnce({});

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'join-alliance',
          userId: 'user123',
          allianceId: 'alliance456'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Successfully joined alliance');
    });

    it('should allow user to leave alliance', async () => {
      mockDynamoDBSend.mockResolvedValueOnce({});

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'leave-alliance',
          userId: 'user123'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Successfully left alliance');
    });

    it('should list alliance members', async () => {
      // Mock query for alliance members
      mockDynamoDBSend.mockResolvedValueOnce({
        Items: [
          {
            entityType: { S: 'GameUser' },
            entityId: { S: 'member1' },
            attributes: {
              M: {
                allianceContribution: { N: '500' },
                allianceJoinedDate: { N: '1640995200000' }
              }
            },
            relationships: {
              M: {
                allianceRole: { S: 'leader' }
              }
            }
          }
        ]
      });

      // Mock get user profile for member
      mockDynamoDBSend.mockResolvedValueOnce({
        Item: {
          entityType: { S: 'GameUser' },
          entityId: { S: 'member1' },
          attributes: {
            M: {
              username: { S: 'leader1' },
              level: { N: '15' },
              lastActive: { N: Date.now().toString() }
            }
          },
          relationships: { M: {} }
        }
      });

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'list-alliance-members',
          allianceId: 'alliance456'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].userId).toBe('member1');
      expect(body[0].role).toBe('leader');
      expect(body[0].contribution).toBe(500);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON', async () => {
      const event = {
        ...mockEvent,
        body: 'invalid-json'
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('User entity service failed');
    });

    it('should handle unknown action', async () => {
      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'unknown-action'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Unknown action: unknown-action');
    });

    it('should handle DynamoDB errors gracefully', async () => {
      mockDynamoDBSend.mockRejectedValueOnce(new Error('DynamoDB connection failed'));

      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'get',
          userId: 'user123'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('User entity service failed');
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers in all responses', async () => {
      const event = {
        ...mockEvent,
        body: JSON.stringify({
          action: 'get'
        })
      } as APIGatewayProxyEvent;

      const result = await handler(event);
      
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin', '*');
      expect(result.headers).toHaveProperty('Content-Type', 'application/json');
    });
  });
});