import { describe, it, expect } from '@jest/globals';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

describe('Cedar Basic Integration', () => {
  it('should evaluate a simple policy correctly', async () => {
    // Simple policy that allows anyone to view public resources
    const policy = `
      permit (
        principal,
        action == Action::"view",
        resource
      ) when {
        resource.type == "public"
      };
    `;

    // Simple entity setup
    const entities = [
      {
        uid: { type: "User", id: "alice" },
        attrs: { name: "Alice" } as Record<string, any>,
        parents: []
      },
      {
        uid: { type: "Resource", id: "doc1" },
        attrs: { type: "public", name: "Public Document" } as Record<string, any>,
        parents: []
      }
    ];

    // Authorization request
    const authorizationCall = {
      principal: { type: "User", id: "alice" },
      action: { type: "Action", id: "view" },
      resource: { type: "Resource", id: "doc1" },
      context: {},
      policies: { staticPolicies: policy },
      entities
    };

    const result = cedar.isAuthorized(authorizationCall);
    
    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.response.decision).toBe('allow');
    }
  });

  it('should deny access when policy conditions are not met', async () => {
    const policy = `
      permit (
        principal,
        action == Action::"view",
        resource
      ) when {
        resource.type == "private" && principal.clearance >= 5
      };
    `;

    const entities = [
      {
        uid: { type: "User", id: "bob" },
        attrs: { name: "Bob", clearance: 3 } as Record<string, any>,
        parents: []
      },
      {
        uid: { type: "Resource", id: "secret" },
        attrs: { type: "private", name: "Secret Document" } as Record<string, any>,
        parents: []
      }
    ];

    const authorizationCall = {
      principal: { type: "User", id: "bob" },
      action: { type: "Action", id: "view" },
      resource: { type: "Resource", id: "secret" },
      context: {},
      policies: { staticPolicies: policy },
      entities
    };

    const result = cedar.isAuthorized(authorizationCall);
    
    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.response.decision).toBe('deny');
    }
  });

  it('should handle group membership correctly', async () => {
    const policy = `
      permit (
        principal in Group::"admins",
        action == Action::"delete",
        resource
      );
    `;

    const entities = [
      {
        uid: { type: "User", id: "admin1" },
        attrs: { name: "Admin One" } as Record<string, any>,
        parents: [{ type: "Group", id: "admins" }]
      },
      {
        uid: { type: "Group", id: "admins" },
        attrs: { name: "Administrators" } as Record<string, any>,
        parents: []
      },
      {
        uid: { type: "Resource", id: "file1" },
        attrs: { name: "Some File" } as Record<string, any>,
        parents: []
      }
    ];

    const authorizationCall = {
      principal: { type: "User", id: "admin1" },
      action: { type: "Action", id: "delete" },
      resource: { type: "Resource", id: "file1" },
      context: {},
      policies: { staticPolicies: policy },
      entities
    };

    const result = cedar.isAuthorized(authorizationCall);
    
    expect(result.type).toBe('success');
    if (result.type === 'success') {
      expect(result.response.decision).toBe('allow');
    }
  });
});