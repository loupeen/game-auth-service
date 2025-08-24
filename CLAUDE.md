# CLAUDE OPERATIONAL GUIDE - Game Authentication Service

## 🎯 Service Overview & Mission

**Game Authentication Service** - Comprehensive authentication, authorization, and MFA system for the Loupeen RTS Platform. Handles 100K+ player authentication with Cedar-based authorization and adaptive MFA security.

**Development Status**: ✅ **PRODUCTION READY** - MFA system fully implemented with comprehensive testing

---

## 📚 Documentation & Context

### 🗂️ Primary Documentation
- **[claude-docs](https://github.com/loupeen/claude-docs)** - Platform documentation
- **[Epic #2: Authentication & Authorization](https://github.com/loupeen/claude-docs/issues/2)** - Current epic
- **[Platform Vision](https://github.com/loupeen/claude-docs/blob/main/docs/vision/PLATFORM-VISION.md)** - Overall strategy

### Service Architecture
```
game-auth-service/
├── 🔐 Authentication (Cognito User Pools)
├── 🛡️  Authorization (Cedar Policy Engine)  
├── 🔑 JWT Management (Enhanced with Cedar)
├── 📱 MFA System (TOTP + SMS + Risk Assessment) ✅ COMPLETED
└── 👤 User Entity Management
```

---

## 🚀 Recently Completed Work

### ✅ Multi-Factor Authentication System (Issue #15)
**Status**: COMPLETED - Fully functional MFA system with gaming optimizations

#### 🎯 Implementation Highlights
- **TOTP Support**: Google Authenticator, Authy integration via speakeasy
- **SMS Fallback**: AWS SNS with rate limiting and attempt tracking
- **Risk Assessment**: IP analysis, device fingerprinting, geolocation
- **Gaming Incentives**: 500 Gold for MFA enrollment, 25 Gold for SMS usage
- **Device Trust**: 30-day trusted device management
- **Recovery Codes**: 8 secure recovery codes per user
- **Security**: SHA-256 hashing, encrypted storage, attempt limiting

#### 📊 Technical Architecture
```typescript
// 5 Lambda Functions
- enrollment.ts      // TOTP device enrollment with QR codes
- verification.ts    // Code verification with risk scoring  
- device-trust.ts    // Trusted device management
- risk-assessment.ts // Behavioral analysis and scoring
- sms-fallback.ts    // SMS backup authentication

// 5 DynamoDB Tables  
- mfa-devices        // TOTP device registrations
- trusted-devices    // Device trust management (30d TTL)
- recovery-codes     // Encrypted recovery codes
- risk-assessment    // Behavioral analysis data (90d TTL)  
- sms-codes         // SMS code storage (5m TTL)
```

#### 🧪 Quality Assurance
- **Unit Tests**: Complete Jest test suite with AWS SDK mocking
- **Integration Tests**: End-to-end MFA flow validation
- **CI/CD**: GitHub Actions pipeline with Node 18.x + 20.x matrix
- **Code Quality**: ESLint passing, TypeScript strict mode
- **Security**: No high/critical vulnerabilities

---

## 🛠️ Development Commands

### Standard Operations
```bash
# Development
npm install                    # Install dependencies
npm run build                  # TypeScript compilation
npm run synth                  # CDK synthesis
npm test                       # Run all tests
npm run test:watch             # TDD mode
npm run test:integration       # Integration tests

# Code Quality
npm run lint                   # ESLint checks
npm run typecheck              # TypeScript validation
npm run lint -- --fix         # Auto-fix linting issues

# Deployment
npm run deploy:test            # Deploy to test environment
npm run deploy:qa              # Deploy to QA environment
```

### Environment-Specific Deployment
```bash
# Test Environment (GameTest Account: 728427470046)
JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 npx cdk deploy GameAuthService-test \
  --context environment=test --require-approval never \
  --profile AWSAdministratorAccess-728427470046

# QA Environment (GameQA Account: 077029784291)  
JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 npx cdk deploy GameAuthService-qa \
  --context environment=qa --require-approval never \
  --profile AWSAdministratorAccess-077029784291
```

### Testing & Monitoring
```bash
# API Testing
./test-deployment/test-jwt-endpoints.sh
./test-deployment/test-enhanced-jwt-cedar.sh
./test-deployment/test-final-integration.sh

# CloudWatch Monitoring
./test-deployment/monitor-cloudwatch.sh
./test-deployment/setup-qa-monitoring.sh
```

---

## 🏗️ Infrastructure & Architecture

### AWS Resources Created
```yaml
Cognito User Pools:
  - Player Pool: Enhanced security, social login
  - Admin Pool: MFA required, strict policies

DynamoDB Tables:  
  - User sessions with TTL
  - MFA device registrations
  - Trusted device management  
  - Recovery codes storage
  - Risk assessment data
  - SMS code temporary storage

Lambda Functions:
  - Authentication & JWT generation
  - Cedar authorization engine
  - MFA enrollment & verification
  - Risk assessment & device trust
  - User entity management

API Gateway:
  - RESTful endpoints for all auth operations
  - CORS enabled for web clients
  - Request validation and rate limiting
```

### Environment Configuration
- **Test**: eu-north-1 (cost-optimized, loose policies)
- **QA**: us-east-1 + eu-central-1 (production-like, strict policies)  
- **Production**: TBD (multi-region, full redundancy)

---

## 🧪 Testing Strategy

### Coverage Requirements
- **Unit Tests**: >80% coverage
- **Integration Tests**: Full API workflow coverage  
- **Security Tests**: Authentication bypass attempts
- **Performance Tests**: <100ms response time targets

### Mock Patterns
```typescript
// AWS SDK Mocking
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/lib-dynamodb');
jest.mock('@aws-sdk/client-cognito-identity-provider');

// Speakeasy TOTP Mocking  
jest.mock('speakeasy');
(speakeasy.totp.verify as jest.Mock).mockReturnValue(true);
```

---

## 🔒 Security Implementation

### Authentication Security
- **JWT**: Short-lived access tokens (15min), long-lived refresh tokens  
- **MFA**: TOTP primary, SMS fallback with rate limiting
- **Cedar**: Fine-grained authorization policies
- **Encryption**: AES-256 for sensitive data storage

### Risk Assessment Features
- **Device Fingerprinting**: Hardware and browser characteristics
- **IP Reputation**: Geolocation and threat intelligence
- **Behavioral Analysis**: Login patterns and timing analysis
- **Impossible Travel**: Geographic velocity detection

### Gaming Security Optimizations  
- **Trusted Devices**: 30-day trust periods for verified devices
- **Gaming Rewards**: In-game incentives for security adoption
- **Minimal Friction**: Streamlined UX to avoid gameplay interruption

---

## 🎮 Gaming Integration Features

### Player Incentives
```typescript
// MFA Enrollment Reward
enrollmentReward: {
  type: 'in-game-currency',
  amount: 500,
  description: 'Security Champion Bonus: 500 Gold for enabling MFA'
}

// SMS Usage Reward  
smsReward: {
  type: 'security-backup-bonus',
  amount: 25,
  description: 'SMS Backup Bonus: 25 Gold for using SMS fallback'
}
```

### Performance Optimizations
- **ARM64 Architecture**: 20% cost savings on Lambda
- **DynamoDB TTL**: Automatic cleanup of expired data
- **CloudWatch Alarms**: Proactive monitoring and alerting
- **Regional Deployment**: Cost-optimized regions (eu-north-1)

---

## 📊 Monitoring & Observability

### CloudWatch Metrics
- **MFA Adoption Rate**: Target >50% user adoption
- **Authentication Success**: >99.5% success rate target
- **Response Times**: <100ms P95 response time
- **Failed Attempts**: Security incident detection

### Alarms Configured
- **Low MFA Adoption**: Alert if <50% users have MFA enabled
- **Suspicious Failures**: Alert on 10+ MFA failures in evaluation period
- **High Latency**: Alert if P95 > 1000ms response time

---

## 🎯 Next Development Priorities

### Upcoming Work (Epic #2 Continuation)
1. **Cedar Authorization Policies** - Fine-grained permissions for game actions
2. **Alliance Role System** - Hierarchical permissions within alliances  
3. **Audit Service** - Comprehensive audit trail for security events
4. **Performance Optimization** - Sub-50ms token validation

### Future Enhancements
- **Biometric Authentication**: Mobile device biometric integration
- **Advanced Risk Scoring**: Machine learning-based behavioral analysis  
- **Social Authentication**: Extended social provider support
- **Passwordless Login**: WebAuthn and FIDO2 integration

---

## 🚨 Critical Success Requirements

### Before Any Production Deployment
- [ ] **CI/CD Pipeline**: 100% green status required
- [ ] **Test Coverage**: >80% unit test coverage achieved  
- [ ] **Security Audit**: No high/critical vulnerabilities
- [ ] **Performance**: <100ms P95 response time validated
- [ ] **Integration**: End-to-end auth flow tested
- [ ] **Documentation**: API documentation complete

### My Development Discipline  
1. **📚 Always consult claude-docs before changes**
2. **📋 Always use TodoWrite for task planning**  
3. **🧪 Always write tests before implementation**
4. **🔍 Always monitor CI/CD pipeline completion**
5. **📝 Always update documentation for changes**
6. **🔒 Always apply security-first principles**

---

## 🔗 Essential Links

- **Repository**: https://github.com/loupeen/game-auth-service
- **Project Board**: https://github.com/orgs/loupeen/projects/5
- **Documentation**: https://github.com/loupeen/claude-docs
- **CI/CD Pipeline**: GitHub Actions (automatic on push)

---

*Last Updated: 2025-08-24*  
*Current Status: MFA System ✅ COMPLETE*  
*Next Focus: Cedar Authorization Policies*  
*Epic Progress: Epic #2 Authentication & Authorization - Phase 2 Ready*