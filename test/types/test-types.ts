/**
 * TypeScript Type Definitions for Integration Tests
 * 
 * This provides strong typing for all test data structures and API responses,
 * replacing the loose JSON parsing in bash scripts.
 */

// User Management Types
export interface TestUser {
  id: string;
  username: string;
  password: string;
  email: string;
  userType: 'player' | 'admin' | 'moderator';
  level: number;
  allianceId?: string;
  isPremium: boolean;
  deviceId: string;
  createdAt: Date;
  tokens?: {
    accessToken: string;
    idToken: string;
    refreshToken: string;
  };
}

export interface CreateUserParams {
  username: string;
  userType: 'player' | 'admin' | 'moderator';
  level?: number;
  allianceId?: string;
  isPremium?: boolean;
}

// Authentication Types
export interface AuthenticationRequest {
  username: string;
  password: string;
  deviceId: string;
  userType: string;
}

export interface AuthenticationResponse {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user?: {
    id: string;
    username: string;
    userType: string;
    level: number;
  };
}

// JWT Token Types
export interface JWTClaims {
  sub: string;
  username?: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  
  // Custom Cedar-enriched claims
  'custom:cedarEntityId'?: string;
  'custom:groups'?: string; // JSON array as string
  'custom:roles'?: string; // JSON array as string
  'custom:permissions'?: string; // JSON array as string
  'custom:level'?: string;
  'custom:isPremium'?: string;
  'custom:userType'?: string;
  'custom:allianceId'?: string;
  'custom:environment'?: string;
  'custom:enrichmentVersion'?: string;
  'custom:enrichedAt'?: string;
  
  // Allow any custom claim
  [key: string]: any;
}

// Enhanced Validation Types
export interface EnhancedValidationRequest {
  token: string;
  action?: {
    actionType: 'Action';
    actionId: string;
  };
  resource?: {
    entityType: string;
    entityId: string;
  };
  context?: Record<string, any>;
}

export interface EnhancedValidationResult {
  valid: boolean;
  user: {
    id: string;
    username: string;
    userType: string;
    level: number;
    allianceId?: string;
    isPremium: boolean;
  };
  permissions: string[];
  authorizationResult?: {
    decision: 'ALLOW' | 'DENY';
    reasons: string[];
    policies: string[];
  };
  sessionInfo: {
    tokenValid: boolean;
    sessionId: string;
    deviceId: string;
    lastSeen: string;
  };
  latency: number;
  error?: string;
}

// Cedar Authorization Types
export interface CedarEntity {
  uid: {
    type: string;
    id: string;
  };
  attrs: Record<string, any>;
  parents?: Array<{
    type: string;
    id: string;
  }>;
}

export interface CedarPolicy {
  id: string;
  policy: string;
  isActive: boolean;
  environment: string;
  createdAt: string;
  version: string;
}

// Test Result Types
export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  metadata?: Record<string, any>;
}

export interface TestSuiteResult {
  suiteName: string;
  environment: string;
  startTime: Date;
  endTime: Date;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  results: TestResult[];
  performance: {
    averageResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    throughput: number;
  };
}

// API Client Types
export interface ApiClientConfig {
  baseUrl: string;
  timeout: number;
  retries: number;
  headers?: Record<string, string>;
}

export interface ApiResponse<T = any> {
  data: T;
  status: number;
  headers: Record<string, string>;
  duration: number;
}

// Test Configuration Types
export interface TestConfig {
  environment: string;
  parallelism: number;
  timeout: number;
  retries: number;
  cleanup: boolean;
  verbose: boolean;
}

// Performance Testing Types
export interface LoadTestConfig {
  concurrentUsers: number;
  duration: number; // seconds
  rampUpTime: number; // seconds
  targetRPS: number; // requests per second
}

export interface PerformanceMetrics {
  averageResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  requestsPerSecond: number;
  errorRate: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
}