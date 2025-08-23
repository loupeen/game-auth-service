/**
 * JWT Token Decoder and Analyzer for Integration Tests
 * 
 * This provides utilities for decoding and validating JWT tokens,
 * replacing the base64 decode commands in bash scripts.
 */

import type { JWTClaims } from '../types/test-types';

export interface TokenValidationResult {
  valid: boolean;
  expired: boolean;
  claims?: JWTClaims;
  errors: string[];
}

export interface TokenAnalysis {
  header: any;
  payload: JWTClaims;
  signature: string;
  isExpired: boolean;
  expiresIn: number; // seconds until expiration
  age: number; // seconds since issued
  cedarEnriched: boolean;
  customClaims: string[];
}

export class JWTDecoder {
  /**
   * Decode JWT token without verification
   * This is safe for testing purposes where we trust our own tokens
   */
  decode(token: string): JWTClaims {
    if (!token || typeof token !== 'string') {
      throw new Error('Invalid token: must be a non-empty string');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token: must have three parts separated by dots');
    }

    try {
      // Decode the payload (middle part)
      const payload = parts[1];
      const decodedPayload = this.base64UrlDecode(payload);
      const claims = JSON.parse(decodedPayload);
      
      return claims as JWTClaims;
    } catch (error: any) {
      throw new Error(`Failed to decode token: ${error.message}`);
    }
  }

  /**
   * Decode and analyze JWT token comprehensively
   */
  analyze(token: string): TokenAnalysis {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    try {
      // Decode header
      const headerDecoded = this.base64UrlDecode(parts[0]);
      const header = JSON.parse(headerDecoded);

      // Decode payload
      const payloadDecoded = this.base64UrlDecode(parts[1]);
      const payload = JSON.parse(payloadDecoded) as JWTClaims;

      // Signature (we don't decode this, just store it)
      const signature = parts[2];

      // Calculate expiration info
      const now = Math.floor(Date.now() / 1000);
      const isExpired = payload.exp < now;
      const expiresIn = payload.exp - now;
      const age = now - payload.iat;

      // Check for Cedar enrichment
      const cedarEnriched = !!(
        payload['custom:cedarEntityId'] ||
        payload['custom:groups'] ||
        payload['custom:permissions']
      );

      // Extract custom claims
      const customClaims = Object.keys(payload).filter(key => key.startsWith('custom:'));

      return {
        header,
        payload,
        signature,
        isExpired,
        expiresIn,
        age,
        cedarEnriched,
        customClaims
      };
    } catch (error: any) {
      throw new Error(`Failed to analyze token: ${error.message}`);
    }
  }

  /**
   * Validate token structure and claims
   */
  validate(token: string, expectedClaims: Partial<JWTClaims> = {}): TokenValidationResult {
    const errors: string[] = [];
    
    try {
      const analysis = this.analyze(token);
      const claims = analysis.payload;

      // Check expiration
      if (analysis.isExpired) {
        errors.push('Token is expired');
      }

      // Validate required standard claims
      if (!claims.sub) {
        errors.push('Missing subject (sub) claim');
      }

      if (!claims.iss) {
        errors.push('Missing issuer (iss) claim');
      }

      if (!claims.aud) {
        errors.push('Missing audience (aud) claim');
      }

      // Validate expected claims
      for (const [key, expectedValue] of Object.entries(expectedClaims)) {
        const actualValue = claims[key as keyof JWTClaims];
        if (actualValue !== expectedValue) {
          errors.push(`Claim ${key} mismatch: expected "${expectedValue}", got "${actualValue}"`);
        }
      }

      return {
        valid: errors.length === 0,
        expired: analysis.isExpired,
        claims: claims,
        errors
      };
    } catch (error: any) {
      errors.push(`Token validation failed: ${error.message}`);
      
      return {
        valid: false,
        expired: false,
        errors
      };
    }
  }

  /**
   * Extract Cedar-specific claims
   */
  extractCedarClaims(token: string): {
    entityId?: string;
    groups: string[];
    roles: string[];
    permissions: string[];
    environment?: string;
    enrichmentVersion?: string;
    enrichedAt?: Date;
  } {
    const claims = this.decode(token);
    
    const groups = this.parseArrayClaim(claims['custom:groups']);
    const roles = this.parseArrayClaim(claims['custom:roles']);
    const permissions = this.parseArrayClaim(claims['custom:permissions']);
    
    let enrichedAt: Date | undefined;
    if (claims['custom:enrichedAt']) {
      enrichedAt = new Date(claims['custom:enrichedAt']);
    }

    return {
      entityId: claims['custom:cedarEntityId'],
      groups,
      roles,
      permissions,
      environment: claims['custom:environment'],
      enrichmentVersion: claims['custom:enrichmentVersion'],
      enrichedAt
    };
  }

  /**
   * Extract user profile information from token
   */
  extractUserProfile(token: string): {
    userId: string;
    username: string;
    userType: string;
    level: number;
    isPremium: boolean;
    allianceId?: string;
  } {
    const claims = this.decode(token);
    
    return {
      userId: claims.sub,
      username: claims.username || claims.sub,
      userType: claims['custom:userType'] || 'unknown',
      level: parseInt(claims['custom:level'] || '1'),
      isPremium: claims['custom:isPremium'] === 'true',
      allianceId: claims['custom:allianceId']
    };
  }

  /**
   * Parse array claim (stored as JSON string)
   */
  private parseArrayClaim(claim: string | undefined): string[] {
    if (!claim) {
      return [];
    }
    
    try {
      const parsed = JSON.parse(claim);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Base64 URL decode (JWT uses URL-safe base64)
   */
  private base64UrlDecode(str: string): string {
    // Add padding if needed
    let padded = str;
    while (padded.length % 4 !== 0) {
      padded += '=';
    }
    
    // Replace URL-safe characters
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    
    // Decode base64
    try {
      return Buffer.from(base64, 'base64').toString('utf-8');
    } catch (error) {
      throw new Error('Failed to decode base64');
    }
  }

  /**
   * Get token expiration time as Date
   */
  getExpirationDate(token: string): Date {
    const claims = this.decode(token);
    return new Date(claims.exp * 1000);
  }

  /**
   * Get token issued time as Date
   */
  getIssuedDate(token: string): Date {
    const claims = this.decode(token);
    return new Date(claims.iat * 1000);
  }

  /**
   * Check if token will expire within specified minutes
   */
  willExpireSoon(token: string, withinMinutes: number = 5): boolean {
    const claims = this.decode(token);
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = claims.exp - now;
    return expiresIn <= (withinMinutes * 60);
  }

  /**
   * Format token claims for debugging
   */
  formatClaims(token: string): string {
    try {
      const analysis = this.analyze(token);
      const claims = analysis.payload;
      
      const lines: string[] = [
        '=== JWT Token Claims ===',
        `Subject (sub): ${claims.sub}`,
        `Username: ${claims.username || 'N/A'}`,
        `Issuer (iss): ${claims.iss}`,
        `Audience (aud): ${claims.aud}`,
        `Issued At: ${new Date(claims.iat * 1000).toISOString()}`,
        `Expires At: ${new Date(claims.exp * 1000).toISOString()}`,
        `Age: ${analysis.age} seconds`,
        `Expires In: ${analysis.expiresIn} seconds`,
        `Is Expired: ${analysis.isExpired}`,
        `Cedar Enriched: ${analysis.cedarEnriched}`,
        ''
      ];

      if (analysis.customClaims.length > 0) {
        lines.push('=== Custom Claims ===');
        for (const claim of analysis.customClaims) {
          const value = claims[claim as keyof JWTClaims];
          lines.push(`${claim}: ${value}`);
        }
      }

      return lines.join('\n');
    } catch (error: any) {
      return `Error formatting claims: ${error.message}`;
    }
  }
}