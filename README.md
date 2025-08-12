# @loupeen/game-auth-service

[\![CI/CD Pipeline](https://github.com/loupeen/game-auth-service/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/loupeen/game-auth-service/actions/workflows/ci-cd.yml)

Authentication service for the Loupeen RTS Platform - Cognito integration, JWT management, MFA, and social login support.

## 🎯 Overview

This service provides comprehensive authentication and user management for the Loupeen RTS Platform, supporting:

- **AWS Cognito Integration** - Separate user pools for players and administrators
- **JWT Token Management** - Secure token generation and validation with refresh rotation
- **Multi-Factor Authentication** - Adaptive MFA with gaming-specific optimizations
- **Social Login** - Integration with Google, Facebook, and other social providers
- **Session Management** - Distributed session storage with DynamoDB
- **Gaming Optimizations** - <50ms token validation, gaming incentives for security

## 🏗️ Architecture

### Core Components

- **Cognito User Pools** - Player and admin authentication
- **Lambda Functions** - Token validation, user registration, MFA handling
- **DynamoDB** - Session storage and user metadata
- **API Gateway** - RESTful authentication endpoints
- **CloudWatch** - Monitoring, logging, and alerting

### Performance Targets

- **Token Validation**: <50ms response time
- **User Registration**: <2s with social login
- **Concurrent Sessions**: 10,000+ per Lambda instance
- **Availability**: 99.9% uptime

## 🚀 Getting Started

### Prerequisites

- Node.js 18.x or 20.x
- AWS CDK CLI
- AWS credentials configured
- Access to Loupeen shared packages

### Installation

```bash
# Clone repository
git clone https://github.com/loupeen/game-auth-service.git
cd game-auth-service

# Install dependencies
npm install

# Build project
npm run build
```

### Development

```bash
# Start in watch mode
npm run watch

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint
```

### Deployment

```bash
# Deploy to test environment
npm run deploy -- --context environment=test

# Deploy to QA environment  
npm run deploy -- --context environment=qa

# Deploy to production
npm run deploy -- --context environment=production
```

## 📖 API Documentation

### Authentication Endpoints

#### POST /auth/register
Register a new player account.

```typescript
interface RegistrationRequest {
  email: string;
  username: string;
  password: string;
  playerName: string;
  deviceFingerprint?: string;
}
```

#### POST /auth/validate-token
Validate JWT token and check permissions.

```typescript
interface TokenValidationRequest {
  token: string;
  requiredRoles?: string[];
}
```

## 🧪 Testing

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage report
npm run test:coverage
```

## 📊 Monitoring

The service includes comprehensive monitoring:

- **CloudWatch Metrics** - Performance and error tracking
- **CloudWatch Logs** - Structured logging with correlation IDs
- **CloudWatch Alarms** - Automated alerting for failures
- **X-Ray Tracing** - Request tracing and performance analysis

## 🔒 Security

- **JWT Tokens** - Signed with rotating secrets
- **Session Storage** - Encrypted in DynamoDB
- **MFA Support** - TOTP and SMS-based authentication
- **Rate Limiting** - Protection against brute force attacks
- **Audit Logging** - Complete authentication event history

## 🤝 Contributing

1. Follow SOLID principles and gaming performance patterns
2. Write comprehensive tests (80%+ coverage required)
3. Update documentation for any API changes
4. Ensure all CI/CD checks pass

## 📄 License

UNLICENSED - Private package for Loupeen RTS Platform

## 🔗 Related Services

- [@loupeen/shared-cdk-constructs](https://github.com/loupeen/shared-cdk-constructs) - CDK constructs library
- [@loupeen/shared-js-utils](https://github.com/loupeen/shared-js-utils) - JavaScript utilities library
- [@loupeen/shared-config-library](https://github.com/loupeen/shared-config-library) - Configuration management

---

**Built with ❤️ for the Loupeen RTS Platform**
