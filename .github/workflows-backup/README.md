# Legacy Workflow Files (Archived)

These workflow files have been consolidated into a single `ci-cd.yml` file to follow DRY principles and leverage the centralized `loupeen/github-workflows` infrastructure.

## Consolidation Summary

**Replaced 9 separate workflow files** with **1 modular workflow**:

### Old Files (Archived)
- `cdk-service.yml` - CDK service pipeline
- `deploy-production.yml` - Production deployment
- `deploy-qa.yml` - QA deployment  
- `deploy-test.yml` - Test deployment
- `deploy.yml` - General deployment
- `deployment-tests.yml` - Deployment testing
- `integration-tests.yml` - Integration tests
- `performance-tests.yml` - Performance testing
- `security-tests.yml` - Security scanning

### New Consolidated Workflow
- `ci-cd.yml` - Complete CI/CD pipeline using reusable workflows from `loupeen/github-workflows`

## Benefits of Consolidation

1. **DRY Principle** - Eliminates duplicated CI/CD logic
2. **Centralized Management** - Updates in `github-workflows` benefit all repositories
3. **Standardization** - Consistent patterns across Loupeen platform
4. **AWS Credentials** - Reuses existing centralized credentials configuration
5. **Cost Efficiency** - Optimized GitHub Actions usage
6. **Maintainability** - Single source of truth for CI/CD logic

## AWS Credentials Configuration

The new workflow uses standardized credential naming from `loupeen/github-workflows`:

- `AWS_ACCESS_KEY_ID_TEST` / `AWS_SECRET_ACCESS_KEY_TEST` (Account: 728427470046)
- `AWS_ACCESS_KEY_ID_QA` / `AWS_SECRET_ACCESS_KEY_QA` (Account: 077029784291)
- `AWS_ACCESS_KEY_ID_PROD` / `AWS_SECRET_ACCESS_KEY_PROD` (Account: TBD)

## Migration Date
**August 23, 2025** - Consolidated as part of ESLint error resolution and workflow optimization effort.

## Recovery
If rollback is needed, these files can be restored from this backup directory.