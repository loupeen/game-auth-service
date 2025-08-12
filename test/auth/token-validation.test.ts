import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../lambda/auth/token-validation';

// Mock AWS SDK
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@loupeen/shared-js-utils');

describe('Token Validation Lambda', () => {
  const mockEvent: Partial<APIGatewayProxyEvent> = {
    body: JSON.stringify({
      token: 'valid-jwt-token',
      requiredRoles: []
    }),
    headers: {},
    path: '/auth/validate-token'
  };

  beforeEach(() => {
    process.env.SESSIONS_TABLE_NAME = 'test-sessions-table';
    process.env.AWS_REGION = 'eu-north-1';
  });

  it('should return 400 when token is missing', async () => {
    const event = {
      ...mockEvent,
      body: JSON.stringify({})
    } as APIGatewayProxyEvent;

    const result = await handler(event);
    
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.valid).toBe(false);
    expect(body.error).toBe('Token is required');
  });

  it('should return 401 for invalid token format', async () => {
    const event = {
      ...mockEvent,
      body: JSON.stringify({ token: 'invalid-token' })
    } as APIGatewayProxyEvent;

    const result = await handler(event);
    
    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.valid).toBe(false);
  });

  it('should handle malformed JSON in request body', async () => {
    const event = {
      ...mockEvent,
      body: 'invalid-json'
    } as APIGatewayProxyEvent;

    const result = await handler(event);
    
    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.valid).toBe(false);
  });
});
