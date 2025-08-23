#!/bin/bash

# Script to create GitHubActionsDeploymentRole in QA account (077029784291)
# This role is needed for GitHub Actions to deploy to the QA environment

echo "🔧 Setting up GitHubActionsDeploymentRole in QA Account (077029784291)"
echo "=================================================================="

QA_ACCOUNT_ID="077029784291"
ROLE_NAME="GitHubActionsDeploymentRole"
GITHUB_REPO="loupeen/game-auth-service"

# Check if we're authenticated to the correct account
echo "🔍 Checking AWS credentials..."
CURRENT_ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text --profile AWSAdministratorAccess-077029784291 2>/dev/null)

if [ "$CURRENT_ACCOUNT" != "$QA_ACCOUNT_ID" ]; then
    echo "❌ Error: Not authenticated to QA account ($QA_ACCOUNT_ID)"
    echo "Current account: $CURRENT_ACCOUNT"
    echo "Please run: aws sso login --profile AWSAdministratorAccess-077029784291"
    exit 1
fi

echo "✅ Authenticated to QA account: $CURRENT_ACCOUNT"

# Create OIDC Identity Provider (if it doesn't exist)
echo "🔐 Creating OIDC Identity Provider for GitHub Actions..."

OIDC_PROVIDER_ARN="arn:aws:iam::${QA_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

# Check if OIDC provider exists
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" --profile AWSAdministratorAccess-077029784291 >/dev/null 2>&1; then
    echo "✅ OIDC Provider already exists: $OIDC_PROVIDER_ARN"
else
    echo "➕ Creating OIDC Provider..."
    aws iam create-open-id-connect-provider \
        --url "https://token.actions.githubusercontent.com" \
        --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" \
        --client-id-list "sts.amazonaws.com" \
        --profile AWSAdministratorAccess-077029784291
    
    if [ $? -eq 0 ]; then
        echo "✅ OIDC Provider created successfully"
    else
        echo "❌ Failed to create OIDC Provider"
        exit 1
    fi
fi

# Create Trust Policy
echo "📄 Creating IAM role trust policy..."
cat > /tmp/github-trust-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Federated": "arn:aws:iam::${QA_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
            },
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {
                "StringEquals": {
                    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
                },
                "StringLike": {
                    "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:*"
                }
            }
        }
    ]
}
EOF

# Create the IAM role
echo "👤 Creating GitHubActionsDeploymentRole..."

if aws iam get-role --role-name "$ROLE_NAME" --profile AWSAdministratorAccess-077029784291 >/dev/null 2>&1; then
    echo "✅ Role already exists, updating trust policy..."
    aws iam update-assume-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-document file:///tmp/github-trust-policy.json \
        --profile AWSAdministratorAccess-077029784291
else
    echo "➕ Creating new role..."
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document file:///tmp/github-trust-policy.json \
        --description "Role for GitHub Actions to deploy to QA environment" \
        --profile AWSAdministratorAccess-077029784291
    
    if [ $? -eq 0 ]; then
        echo "✅ Role created successfully"
    else
        echo "❌ Failed to create role"
        exit 1
    fi
fi

# Attach necessary policies
echo "🔗 Attaching policies to role..."

POLICIES=(
    "arn:aws:iam::aws:policy/PowerUserAccess"
    "arn:aws:iam::aws:policy/IAMFullAccess"
)

for policy in "${POLICIES[@]}"; do
    echo "➕ Attaching policy: $policy"
    aws iam attach-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-arn "$policy" \
        --profile AWSAdministratorAccess-077029784291
done

# Clean up temporary file
rm -f /tmp/github-trust-policy.json

echo ""
echo "🎉 GitHubActionsDeploymentRole setup complete!"
echo "=================================================================="
echo "Role ARN: arn:aws:iam::${QA_ACCOUNT_ID}:role/${ROLE_NAME}"
echo "Account: ${QA_ACCOUNT_ID} (QA)"
echo "Region: us-east-1"
echo ""
echo "✅ GitHub Actions can now deploy to QA environment"
echo "🔐 Next: Set up manual approval protection rules for 'qa' environment"
echo ""