/**
 * Game Auth API Client for Integration Tests
 * 
 * This replaces the curl commands in bash scripts with a proper HTTP client
 * that provides retry logic, timeout handling, and comprehensive error reporting.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type {
  ApiClientConfig,
  ApiResponse,
  AuthenticationRequest,
  AuthenticationResponse,
  EnhancedValidationRequest,
  EnhancedValidationResult
} from '../types/test-types';

export class GameAuthApiClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl: string, config: Partial<ApiClientConfig> = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // Remove trailing slashes
    
    const defaultConfig: ApiClientConfig = {
      baseUrl: this.baseUrl,
      timeout: 10000, // 10 seconds
      retries: 3,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'GameAuth-IntegrationTests/1.0'
      }
    };

    const finalConfig = { ...defaultConfig, ...config };

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: finalConfig.timeout,
      headers: finalConfig.headers
    });

    // Request interceptor for logging and timing
    this.client.interceptors.request.use(
      (config) => {
        (config as any).startTime = Date.now();
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor for logging and duration calculation
    this.client.interceptors.response.use(
      (response) => {
        const duration = Date.now() - (response.config as any).startTime;
        (response as any).duration = duration;
        return response;
      },
      (error) => {
        const duration = Date.now() - (error.config?.startTime || Date.now());
        if (error.response) {
          (error.response as any).duration = duration;
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Generic API request method with retry logic
   */
  private async request<T = any>(config: AxiosRequestConfig): Promise<ApiResponse<T>> {
    try {
      const response: AxiosResponse<T> = await this.client.request(config);
      
      return {
        data: response.data,
        status: response.status,
        headers: response.headers as Record<string, string>,
        duration: (response as any).duration || 0
      };
    } catch (error: any) {
      const apiError = this.formatError(error);
      throw apiError;
    }
  }

  /**
   * Format errors with comprehensive details
   */
  private formatError(error: any): Error {
    if (error.response) {
      // Server responded with error status
      const duration = (error.response as any).duration || 0;
      const message = `HTTP ${error.response.status}: ${error.response.statusText}`;
      const details = {
        status: error.response.status,
        data: error.response.data,
        duration,
        url: error.config?.url
      };
      
      const formattedError = new Error(`${message} - ${JSON.stringify(details)}`);
      (formattedError as any).response = error.response;
      return formattedError;
    } else if (error.request) {
      // Request was made but no response received
      return new Error(`Network error: No response received from ${error.config?.url}`);
    } else {
      // Something else happened
      return new Error(`Request setup error: ${error.message}`);
    }
  }

  /**
   * Health check endpoint
   */
  async healthCheck(): Promise<ApiResponse<any>> {
    return this.request({
      method: 'GET',
      url: '/'
    });
  }

  /**
   * Generate JWT Token (replaces POST /jwt/generate)
   */
  async generateToken(request: AuthenticationRequest): Promise<ApiResponse<AuthenticationResponse>> {
    return this.request<AuthenticationResponse>({
      method: 'POST',
      url: '/jwt/generate',
      data: request
    });
  }

  /**
   * Validate JWT Token (replaces POST /jwt/validate)
   */
  async validateToken(token: string): Promise<ApiResponse<{ valid: boolean; user?: any }>> {
    return this.request({
      method: 'POST',
      url: '/jwt/validate',
      data: { token }
    });
  }

  /**
   * Enhanced JWT-Cedar Validation (our new endpoint)
   */
  async validateEnhanced(request: EnhancedValidationRequest): Promise<EnhancedValidationResult> {
    const response = await this.request<EnhancedValidationResult>({
      method: 'POST',
      url: '/jwt/validate-enhanced',
      data: request
    });

    // Add duration to the result
    response.data.latency = response.duration;
    
    return response.data;
  }

  /**
   * Refresh JWT Token (replaces POST /jwt/refresh)
   */
  async refreshToken(refreshToken: string, deviceId: string): Promise<ApiResponse<AuthenticationResponse>> {
    return this.request<AuthenticationResponse>({
      method: 'POST',
      url: '/jwt/refresh',
      data: {
        refreshToken,
        deviceId
      }
    });
  }

  /**
   * Revoke JWT Token (replaces POST /jwt/revoke)
   */
  async revokeToken(token: string, reason: string = 'Integration test'): Promise<ApiResponse<{ success: boolean }>> {
    return this.request({
      method: 'POST',
      url: '/jwt/revoke',
      data: {
        token,
        reason
      }
    });
  }

  /**
   * Convenience method for authentication flow
   */
  async authenticate(credentials: Pick<AuthenticationRequest, 'username' | 'password'>): Promise<{
    accessToken: string;
    idToken: string;
    refreshToken: string;
  }> {
    const request: AuthenticationRequest = {
      ...credentials,
      deviceId: `test-device-${Date.now()}`,
      userType: 'player'
    };

    const response = await this.generateToken(request);
    
    return {
      accessToken: response.data.accessToken,
      idToken: response.data.idToken,
      refreshToken: response.data.refreshToken
    };
  }

  /**
   * Performance testing helper - measure multiple requests
   */
  async measurePerformance(
    requestFn: () => Promise<any>,
    iterations: number = 10
  ): Promise<{
    average: number;
    min: number;
    max: number;
    requests: number;
    results: number[];
  }> {
    const results: number[] = [];
    
    for (let i = 0; i < iterations; i++) {
      const startTime = Date.now();
      await requestFn();
      const duration = Date.now() - startTime;
      results.push(duration);
    }

    return {
      average: results.reduce((a, b) => a + b, 0) / results.length,
      min: Math.min(...results),
      max: Math.max(...results),
      requests: iterations,
      results
    };
  }

  /**
   * Test connectivity and basic functionality
   */
  async testConnection(): Promise<{
    healthy: boolean;
    latency: number;
    endpoints: Record<string, boolean>;
  }> {
    const results: Record<string, boolean> = {};
    let totalLatency = 0;
    let healthyEndpoints = 0;

    // Test health endpoint
    try {
      const response = await this.healthCheck();
      results['health'] = response.status === 200;
      totalLatency += response.duration;
      if (results['health']) healthyEndpoints++;
    } catch (error) {
      results['health'] = false;
    }

    // Test auth endpoint (expect 400 for empty request, not 500)
    try {
      await this.generateToken({} as AuthenticationRequest);
      results['auth'] = false; // Should fail with bad request
    } catch (error: any) {
      // We expect 400 Bad Request for malformed request
      results['auth'] = error.response?.status === 400;
      if (results['auth']) healthyEndpoints++;
    }

    return {
      healthy: healthyEndpoints > 0,
      latency: totalLatency / healthyEndpoints || 0,
      endpoints: results
    };
  }
}