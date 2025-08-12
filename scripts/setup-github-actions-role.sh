#!/bin/bash

# Setup GitHub Actions OIDC Provider and IAM Role for AWS deployment
# Run this script in the GameTest account (728427470046)

set -e

ACCOUNT_ID="728427470046"
REGION="eu-north-1"
REPO_OWNER="loupeen"
REPO_NAME="game-auth-service"
ROLE_NAME="GitHubActionsDeploymentRole"
AWS_PROFILE="AWSAdministratorAccess-728427470046"

echo "🔧 Setting up GitHub Actions OIDC Provider and IAM Role..."

# Create OIDC Identity Provider
echo "Creating OIDC Identity Provider..."
aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd \
    --profile ${AWS_PROFILE} \
    || echo "OIDC Provider already exists (OK)"

# Create trust policy for GitHub Actions
cat > github-actions-trust-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
            },
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {
                "StringEquals": {
                    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
                },
                "StringLike": {
                    "token.actions.githubusercontent.com:sub": [
                        "repo:${REPO_OWNER}/${REPO_NAME}:ref:refs/heads/main",
                        "repo:${REPO_OWNER}/${REPO_NAME}:environment:test"
                    ]
                }
            }
        }
    ]
}
EOF

# Create IAM role
echo "Creating IAM role: ${ROLE_NAME}"
aws iam create-role \
    --role-name ${ROLE_NAME} \
    --assume-role-policy-document file://github-actions-trust-policy.json \
    --description "Role for GitHub Actions to deploy CDK stacks" \
    --profile ${AWS_PROFILE}

# Create deployment policy for CDK
cat > github-actions-deployment-policy.json << EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "cloudformation:*",
                "iam:*",
                "lambda:*",
                "apigateway:*",
                "cognito-idp:*",
                "dynamodb:*",
                "logs:*",
                "s3:*",
                "ssm:GetParameter",
                "ssm:GetParameters",
                "ssm:PutParameter",
                "sts:GetCallerIdentity",
                "ecr:*",
                "secretsmanager:*"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject"
            ],
            "Resource": "arn:aws:s3:::cdk-*"
        }
    ]
}
EOF

# Attach policy to role
aws iam put-role-policy \
    --role-name ${ROLE_NAME} \
    --policy-name CDKDeploymentPolicy \
    --policy-document file://github-actions-deployment-policy.json \
    --profile ${AWS_PROFILE}

# Get role ARN
ROLE_ARN=$(aws iam get-role \
    --role-name ${ROLE_NAME} \
    --profile ${AWS_PROFILE} \
    --query 'Role.Arn' \
    --output text)

echo "✅ Setup complete!"
echo "Role ARN: ${ROLE_ARN}"
echo ""
echo "📝 Update your GitHub Actions workflow with:"
echo "role-to-assume: ${ROLE_ARN}"
echo "aws-region: ${REGION}"
echo ""
echo "🧹 Cleaning up temporary files..."
rm -f github-actions-trust-policy.json github-actions-deployment-policy.json

echo ""
echo "🎯 Next steps:"
echo "1. The IAM role is ready for GitHub Actions"
echo "2. The workflow is already configured with the correct role ARN"
echo "3. Test deployment by pushing to main branch"