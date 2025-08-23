/**
 * Test Data Factory for Integration Tests
 * 
 * This manages test user creation, reuse, and cleanup, replacing the ad-hoc
 * user creation in bash scripts with a systematic approach.
 */

import { CognitoTestClient } from './cognito-client';
import type { TestUser, CreateUserParams } from '../types/test-types';
import type { EnvironmentConfig } from '../config/environments';

export interface TestDataConfig {
  reuseUsers: boolean;
  cleanupOnExit: boolean;
  userPrefix: string;
  defaultPassword: string;
}

export class TestDataFactory {
  private static instance: TestDataFactory;
  private cognitoClient: CognitoTestClient;
  private config: TestDataConfig;
  private createdUsers: Map<string, TestUser> = new Map();
  private environment: EnvironmentConfig;

  constructor(environment: EnvironmentConfig, config: Partial<TestDataConfig> = {}) {
    this.environment = environment;
    this.cognitoClient = CognitoTestClient.fromEnvironment(environment);
    
    this.config = {
      reuseUsers: true, // Reuse users to avoid Cognito rate limits
      cleanupOnExit: false, // Keep users for debugging unless explicitly requested
      userPrefix: 'integration-test',
      defaultPassword: 'IntegrationTest123!',
      ...config
    };

    // Setup cleanup on process exit
    if (this.config.cleanupOnExit) {
      process.on('exit', this.cleanup.bind(this));
      process.on('SIGINT', this.cleanup.bind(this));
      process.on('SIGTERM', this.cleanup.bind(this));
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(environment?: EnvironmentConfig): TestDataFactory {
    if (!TestDataFactory.instance) {
      if (!environment) {
        throw new Error('TestDataFactory requires environment on first initialization');
      }
      TestDataFactory.instance = new TestDataFactory(environment);
    }
    return TestDataFactory.instance;
  }

  /**
   * Get or create a test user with specified characteristics
   */
  async getOrCreateTestUser(params: CreateUserParams): Promise<TestUser> {
    const userKey = this.generateUserKey(params);
    
    // Check if we already created this user in this test run
    if (this.createdUsers.has(userKey)) {
      const existingUser = this.createdUsers.get(userKey)!;
      
      // Verify the user still exists in Cognito
      const cognitoUser = await this.cognitoClient.getUser(existingUser.username);
      if (cognitoUser) {
        return existingUser;
      } else {
        // User was deleted externally, remove from cache
        this.createdUsers.delete(userKey);
      }
    }

    // Check if user exists in Cognito (for reuse between test runs)
    if (this.config.reuseUsers) {
      const existingUsername = this.generateUsername(params);
      const cognitoUser = await this.cognitoClient.getUser(existingUsername);
      
      if (cognitoUser) {
        const testUser = this.createTestUserFromCognito(cognitoUser, params);
        this.createdUsers.set(userKey, testUser);
        return testUser;
      }
    }

    // Create new user
    return this.createNewTestUser(params);
  }

  /**
   * Create a new test user
   */
  private async createNewTestUser(params: CreateUserParams): Promise<TestUser> {
    const username = this.generateUsername(params);
    const email = this.generateEmail(params);
    const password = this.config.defaultPassword;

    const testUser = await this.cognitoClient.createUser({
      username,
      email,
      password,
      userType: params.userType,
      level: params.level || 1,
      allianceId: params.allianceId,
      isPremium: params.isPremium || false
    });

    const userKey = this.generateUserKey(params);
    this.createdUsers.set(userKey, testUser);

    return testUser;
  }

  /**
   * Create TestUser object from existing Cognito user
   */
  private createTestUserFromCognito(cognitoUser: any, params: CreateUserParams): TestUser {
    const attributes = this.parseUserAttributes(cognitoUser.UserAttributes || []);
    
    return {
      id: attributes.sub || cognitoUser.Username,
      username: cognitoUser.Username,
      password: this.config.defaultPassword, // We assume the password
      email: attributes.email || this.generateEmail(params),
      userType: (attributes['custom:roleId'] || params.userType) as any,
      level: params.level || 1, // Default level since not stored in Cognito
      allianceId: attributes['custom:allianceId'] || params.allianceId,
      isPremium: params.isPremium || false, // Default since not stored in Cognito
      deviceId: `test-device-${Date.now()}`,
      createdAt: new Date(cognitoUser.UserCreateDate || Date.now())
    };
  }

  /**
   * Parse Cognito user attributes into object
   */
  private parseUserAttributes(attributes: Array<{ Name: string; Value: string }>): Record<string, string> {
    const parsed: Record<string, string> = {};
    for (const attr of attributes) {
      parsed[attr.Name] = attr.Value;
    }
    return parsed;
  }

  /**
   * Generate consistent username for test user
   */
  private generateUsername(params: CreateUserParams): string {
    const baseId = `${params.userType}-${params.level || 1}`;
    const hash = this.simpleHash(JSON.stringify(params));
    return `${this.config.userPrefix}-${baseId}-${hash}`;
  }

  /**
   * Generate email for test user
   */
  private generateEmail(params: CreateUserParams): string {
    const username = this.generateUsername(params);
    return `${username}@loupeen.test`;
  }

  /**
   * Generate unique key for caching users
   */
  private generateUserKey(params: CreateUserParams): string {
    return `${params.userType}_${params.level || 1}_${params.allianceId || 'none'}_${params.isPremium || false}`;
  }

  /**
   * Simple hash function for generating consistent IDs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36).substring(0, 8);
  }

  /**
   * Create multiple test users for different scenarios
   */
  async createTestUserSet(): Promise<{
    player: TestUser;
    premiumPlayer: TestUser;
    allianceMember: TestUser;
    admin: TestUser;
    moderator: TestUser;
  }> {
    const [player, premiumPlayer, allianceMember, admin, moderator] = await Promise.all([
      this.getOrCreateTestUser({ username: 'player', userType: 'player', level: 1 }),
      this.getOrCreateTestUser({ username: 'premium-player', userType: 'player', level: 5, isPremium: true }),
      this.getOrCreateTestUser({ username: 'alliance-player', userType: 'player', level: 3, allianceId: 'test-alliance-123' }),
      this.getOrCreateTestUser({ username: 'admin', userType: 'admin', level: 100 }),
      this.getOrCreateTestUser({ username: 'moderator', userType: 'moderator', level: 50 })
    ]);

    return {
      player,
      premiumPlayer,
      allianceMember,
      admin,
      moderator
    };
  }

  /**
   * Update user attributes for testing
   */
  async updateUserAttributes(user: TestUser, attributes: Record<string, string>): Promise<void> {
    await this.cognitoClient.updateUserAttributes(user.username, attributes);
    
    // Update local cache
    const userKey = Object.keys(this.createdUsers).find(key => 
      this.createdUsers.get(key)?.username === user.username
    );
    if (userKey) {
      const cachedUser = this.createdUsers.get(userKey)!;
      // Update relevant fields based on attributes
      if (attributes['custom:level']) {
        cachedUser.level = parseInt(attributes['custom:level']);
      }
      if (attributes['custom:isPremium']) {
        cachedUser.isPremium = attributes['custom:isPremium'] === 'true';
      }
      if (attributes['custom:allianceId']) {
        cachedUser.allianceId = attributes['custom:allianceId'];
      }
    }
  }

  /**
   * Cleanup specific test user
   */
  async cleanupTestUser(user: TestUser): Promise<void> {
    try {
      await this.cognitoClient.deleteUser(user.username);
      
      // Remove from cache
      const userKey = Object.keys(this.createdUsers).find(key => 
        this.createdUsers.get(key)?.username === user.username
      );
      if (userKey) {
        this.createdUsers.delete(userKey);
      }
    } catch (error) {
      console.warn(`Failed to cleanup test user ${user.username}:`, error);
    }
  }

  /**
   * Cleanup all created users
   */
  async cleanup(): Promise<void> {
    if (!this.config.cleanupOnExit) {
      return;
    }

    const users = Array.from(this.createdUsers.values());
    console.log(`Cleaning up ${users.length} test users...`);
    
    const cleanupPromises = users.map(user => this.cleanupTestUser(user));
    await Promise.allSettled(cleanupPromises);
    
    this.createdUsers.clear();
  }

  /**
   * Get statistics about created users
   */
  getStats(): {
    totalUsers: number;
    usersByType: Record<string, number>;
    creationTimes: Date[];
  } {
    const users = Array.from(this.createdUsers.values());
    const usersByType: Record<string, number> = {};
    
    for (const user of users) {
      usersByType[user.userType] = (usersByType[user.userType] || 0) + 1;
    }
    
    return {
      totalUsers: users.length,
      usersByType,
      creationTimes: users.map(u => u.createdAt)
    };
  }

  /**
   * Force cleanup all test users (including from previous runs)
   */
  async forceCleanupAllTestUsers(): Promise<number> {
    return this.cognitoClient.cleanupTestUsers(this.config.userPrefix);
  }

  /**
   * Create factory from environment config
   */
  static fromEnvironment(env: EnvironmentConfig, config: Partial<TestDataConfig> = {}): TestDataFactory {
    return new TestDataFactory(env, config);
  }
}