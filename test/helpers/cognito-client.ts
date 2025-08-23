/**
 * Cognito Test Client for User Management
 * 
 * This replaces the AWS CLI commands in bash scripts with programmatic
 * Cognito operations for creating, managing, and cleaning up test users.
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  ListUsersCommand,
  AdminUpdateUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AuthFlowType,
  ChallengeNameType,
  AttributeType
} from '@aws-sdk/client-cognito-identity-provider';
import type { TestUser } from '../types/test-types';
import type { EnvironmentConfig } from '../config/environments';

export interface CognitoConfig {
  userPoolId: string;
  clientId?: string;
  region: string;
  profile?: string;
}

export interface CreateUserOptions {
  username: string;
  email: string;
  password: string;
  userType: 'player' | 'admin' | 'moderator';
  level?: number;
  allianceId?: string;
  isPremium?: boolean;
  temporary?: boolean;
}

export interface AuthenticateOptions {
  username: string;
  password: string;
}

export class CognitoTestClient {
  private client: CognitoIdentityProviderClient;
  private config: CognitoConfig;

  constructor(config: CognitoConfig) {
    this.config = config;
    
    // Initialize Cognito client with appropriate credentials
    const clientConfig: any = {
      region: config.region
    };

    // If profile is specified, use it for credentials
    if (config.profile) {
      // The profile will be handled by the AWS SDK credential chain
      process.env.AWS_PROFILE = config.profile;
    }

    this.client = new CognitoIdentityProviderClient(clientConfig);
  }

  /**
   * Create a test user in Cognito User Pool
   */
  async createUser(options: CreateUserOptions): Promise<TestUser> {
    const {
      username,
      email,
      password,
      userType,
      level = 1,
      allianceId,
      isPremium = false,
      temporary = false
    } = options;

    try {
      // Define user attributes (using available custom attributes)
      const userAttributes: AttributeType[] = [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:playerId', Value: `player-${Date.now()}` },
        { Name: 'custom:roleId', Value: userType }
      ];

      if (allianceId) {
        userAttributes.push({ Name: 'custom:allianceId', Value: allianceId });
      }

      // Create user command
      const createUserCommand = new AdminCreateUserCommand({
        UserPoolId: this.config.userPoolId,
        Username: username,
        UserAttributes: userAttributes,
        TemporaryPassword: temporary ? password : undefined,
        MessageAction: 'SUPPRESS', // Don't send welcome email during testing
        ForceAliasCreation: false
      });

      const createResult = await this.client.send(createUserCommand);

      if (!temporary) {
        // Set permanent password
        const setPasswordCommand = new AdminSetUserPasswordCommand({
          UserPoolId: this.config.userPoolId,
          Username: username,
          Password: password,
          Permanent: true
        });

        await this.client.send(setPasswordCommand);
      }

      // Create TestUser object
      const testUser: TestUser = {
        id: createResult.User?.Attributes?.find(attr => attr.Name === 'sub')?.Value || username,
        username,
        password,
        email,
        userType,
        level,
        allianceId,
        isPremium,
        deviceId: `test-device-${Date.now()}`,
        createdAt: new Date()
      };

      return testUser;
    } catch (error: any) {
      throw new Error(`Failed to create test user ${username}: ${error.message}`);
    }
  }

  /**
   * Authenticate user and get tokens
   */
  async authenticate(options: AuthenticateOptions): Promise<{
    accessToken: string;
    idToken: string;
    refreshToken: string;
  }> {
    const { username, password } = options;

    try {
      // Initiate auth flow
      const authCommand = new AdminInitiateAuthCommand({
        UserPoolId: this.config.userPoolId,
        ClientId: await this.getClientId(),
        AuthFlow: AuthFlowType.ADMIN_NO_SRP_AUTH,
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password
        }
      });

      const authResult = await this.client.send(authCommand);

      if (authResult.ChallengeName) {
        // Handle challenges (e.g., NEW_PASSWORD_REQUIRED)
        if (authResult.ChallengeName === ChallengeNameType.NEW_PASSWORD_REQUIRED) {
          const challengeCommand = new AdminRespondToAuthChallengeCommand({
            UserPoolId: this.config.userPoolId,
            ClientId: await this.getClientId(),
            ChallengeName: authResult.ChallengeName,
            ChallengeResponses: {
              USERNAME: username,
              NEW_PASSWORD: password
            },
            Session: authResult.Session
          });

          const challengeResult = await this.client.send(challengeCommand);
          
          if (!challengeResult.AuthenticationResult) {
            throw new Error('Authentication failed after password challenge');
          }

          return {
            accessToken: challengeResult.AuthenticationResult.AccessToken!,
            idToken: challengeResult.AuthenticationResult.IdToken!,
            refreshToken: challengeResult.AuthenticationResult.RefreshToken!
          };
        } else {
          throw new Error(`Unhandled challenge: ${authResult.ChallengeName}`);
        }
      }

      if (!authResult.AuthenticationResult) {
        throw new Error('Authentication failed - no result');
      }

      return {
        accessToken: authResult.AuthenticationResult.AccessToken!,
        idToken: authResult.AuthenticationResult.IdToken!,
        refreshToken: authResult.AuthenticationResult.RefreshToken!
      };
    } catch (error: any) {
      throw new Error(`Authentication failed for ${username}: ${error.message}`);
    }
  }

  /**
   * Get user details from Cognito
   */
  async getUser(username: string): Promise<any> {
    try {
      const command = new AdminGetUserCommand({
        UserPoolId: this.config.userPoolId,
        Username: username
      });

      const result = await this.client.send(command);
      return result;
    } catch (error: any) {
      if (error.name === 'UserNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Update user attributes
   */
  async updateUserAttributes(username: string, attributes: Record<string, string>): Promise<void> {
    try {
      const userAttributes: AttributeType[] = Object.entries(attributes).map(([name, value]) => ({
        Name: name,
        Value: value
      }));

      const command = new AdminUpdateUserAttributesCommand({
        UserPoolId: this.config.userPoolId,
        Username: username,
        UserAttributes: userAttributes
      });

      await this.client.send(command);
    } catch (error: any) {
      throw new Error(`Failed to update user attributes for ${username}: ${error.message}`);
    }
  }

  /**
   * Delete test user (cleanup)
   */
  async deleteUser(username: string): Promise<void> {
    try {
      const command = new AdminDeleteUserCommand({
        UserPoolId: this.config.userPoolId,
        Username: username
      });

      await this.client.send(command);
    } catch (error: any) {
      // Don't throw error if user doesn't exist
      if (error.name !== 'UserNotFoundException') {
        throw new Error(`Failed to delete user ${username}: ${error.message}`);
      }
    }
  }

  /**
   * List all test users (for cleanup)
   */
  async listTestUsers(prefix: string = 'test-'): Promise<string[]> {
    try {
      const command = new ListUsersCommand({
        UserPoolId: this.config.userPoolId,
        AttributesToGet: ['username'],
        Limit: 60
      });

      const result = await this.client.send(command);
      
      return result.Users
        ?.filter(user => user.Username?.startsWith(prefix))
        ?.map(user => user.Username!)
        ?.filter(Boolean) || [];
    } catch (error: any) {
      throw new Error(`Failed to list test users: ${error.message}`);
    }
  }

  /**
   * Cleanup all test users
   */
  async cleanupTestUsers(prefix: string = 'test-'): Promise<number> {
    try {
      const testUsers = await this.listTestUsers(prefix);
      
      let deletedCount = 0;
      for (const username of testUsers) {
        try {
          await this.deleteUser(username);
          deletedCount++;
        } catch (error) {
          console.warn(`Failed to delete test user ${username}:`, error);
        }
      }

      return deletedCount;
    } catch (error: any) {
      throw new Error(`Failed to cleanup test users: ${error.message}`);
    }
  }

  /**
   * Disable user (for testing account lockout)
   */
  async disableUser(username: string): Promise<void> {
    try {
      const command = new AdminDisableUserCommand({
        UserPoolId: this.config.userPoolId,
        Username: username
      });

      await this.client.send(command);
    } catch (error: any) {
      throw new Error(`Failed to disable user ${username}: ${error.message}`);
    }
  }

  /**
   * Enable user
   */
  async enableUser(username: string): Promise<void> {
    try {
      const command = new AdminEnableUserCommand({
        UserPoolId: this.config.userPoolId,
        Username: username
      });

      await this.client.send(command);
    } catch (error: any) {
      throw new Error(`Failed to enable user ${username}: ${error.message}`);
    }
  }

  /**
   * Get User Pool Client ID (needed for auth operations)
   * For now, we'll need to configure this or derive it
   */
  private async getClientId(): Promise<string> {
    // Use clientId from config if available, otherwise from environment
    const clientId = this.config.clientId || process.env.COGNITO_CLIENT_ID || 'placeholder-client-id';
    
    if (clientId === 'placeholder-client-id') {
      throw new Error('COGNITO_CLIENT_ID not configured. Please configure the User Pool App Client ID.');
    }
    
    return clientId;
  }

  /**
   * Create CognitoTestClient from environment config
   */
  static fromEnvironment(env: EnvironmentConfig): CognitoTestClient {
    return new CognitoTestClient({
      userPoolId: env.cognito.userPoolId,
      clientId: env.cognito.clientId,
      region: env.region,
      profile: env.awsProfile
    });
  }
}