#!/bin/bash

# Enhanced JWT-Cedar Validation Testing Script
# Tests the complete authentication + authorization flow

set -e

# Configuration
API_URL="https://rofefpdvc2.execute-api.eu-north-1.amazonaws.com/prod"
USER_POOL_ID="eu-north-1_mn0zGxlAZ"
CLIENT_ID="26bt260p5jeu7o89po4acqdlvk"
USERNAME="testplayer"
PASSWORD="TestPassword123!"

echo "🚀 Testing Enhanced JWT-Cedar Validation Flow"
echo "================================================"

# Step 1: Authenticate user and get tokens
echo "Step 1: Authenticating user '$USERNAME'..."
AUTH_RESPONSE=$(aws cognito-idp admin-initiate-auth \
    --user-pool-id $USER_POOL_ID \
    --client-id $CLIENT_ID \
    --auth-flow ADMIN_NO_SRP_AUTH \
    --auth-parameters USERNAME=$USERNAME,PASSWORD=$PASSWORD \
    --profile AWSAdministratorAccess-728427470046 \
    --output json)

ACCESS_TOKEN=$(echo $AUTH_RESPONSE | jq -r '.AuthenticationResult.AccessToken')
ID_TOKEN=$(echo $AUTH_RESPONSE | jq -r '.AuthenticationResult.IdToken')
REFRESH_TOKEN=$(echo $AUTH_RESPONSE | jq -r '.AuthenticationResult.RefreshToken')

if [ "$ACCESS_TOKEN" = "null" ]; then
    echo "❌ Authentication failed!"
    echo "Response: $AUTH_RESPONSE"
    exit 1
fi

echo "✅ Authentication successful!"
echo "Access Token: ${ACCESS_TOKEN:0:50}..."

# Step 2: Test Enhanced JWT-Cedar Validation (Token Only)
echo -e "\nStep 2: Testing token-only validation..."
BASIC_VALIDATION=$(curl -s -X POST "$API_URL/enhanced-auth" \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$ACCESS_TOKEN\"
    }")

echo "Basic Validation Response:"
echo $BASIC_VALIDATION | jq '.'

# Step 3: Test Enhanced JWT-Cedar Validation with Action/Resource
echo -e "\nStep 3: Testing with action and resource..."
ENHANCED_VALIDATION=$(curl -s -X POST "$API_URL/enhanced-auth" \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$ACCESS_TOKEN\",
        \"action\": {
            \"actionType\": \"Action\",
            \"actionId\": \"viewProfile\"
        },
        \"resource\": {
            \"entityType\": \"Profile\",
            \"entityId\": \"profile-123\"
        },
        \"context\": {
            \"time\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
            \"location\": \"game-client\"
        }
    }")

echo "Enhanced Validation Response:"
echo $ENHANCED_VALIDATION | jq '.'

# Step 4: Test Alliance Action Authorization
echo -e "\nStep 4: Testing alliance action authorization..."
ALLIANCE_VALIDATION=$(curl -s -X POST "$API_URL/enhanced-auth" \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$ACCESS_TOKEN\",
        \"action\": {
            \"actionType\": \"Action\",
            \"actionId\": \"joinAlliance\"
        },
        \"resource\": {
            \"entityType\": \"Alliance\",
            \"entityId\": \"alliance-456\"
        },
        \"context\": {
            \"playerLevel\": 5,
            \"allianceCapacity\": 80
        }
    }")

echo "Alliance Validation Response:"
echo $ALLIANCE_VALIDATION | jq '.'

# Step 5: Test Combat Action Authorization
echo -e "\nStep 5: Testing combat action authorization..."
COMBAT_VALIDATION=$(curl -s -X POST "$API_URL/enhanced-auth" \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$ACCESS_TOKEN\",
        \"action\": {
            \"actionType\": \"Action\",
            \"actionId\": \"attackBase\"
        },
        \"resource\": {
            \"entityType\": \"Base\",
            \"entityId\": \"enemy-base-789\"
        },
        \"context\": {
            \"playerLevel\": 5,
            \"troops\": 1000,
            \"targetOwner\": \"enemy-player\"
        }
    }")

echo "Combat Validation Response:"
echo $COMBAT_VALIDATION | jq '.'

# Step 6: Test Admin Action (Should Fail for Player)
echo -e "\nStep 6: Testing admin action (should fail for player)..."
ADMIN_VALIDATION=$(curl -s -X POST "$API_URL/enhanced-auth" \
    -H "Content-Type: application/json" \
    -d "{
        \"token\": \"$ACCESS_TOKEN\",
        \"action\": {
            \"actionType\": \"Action\",
            \"actionId\": \"banUser\"
        },
        \"resource\": {
            \"entityType\": \"User\",
            \"entityId\": \"target-user-123\"
        },
        \"context\": {
            \"reason\": \"violation\"
        }
    }")

echo "Admin Action Validation Response:"
echo $ADMIN_VALIDATION | jq '.'

# Step 7: Test Regular Cedar Authorization Endpoint for Comparison
echo -e "\nStep 7: Testing regular Cedar authorization for comparison..."
CEDAR_AUTH=$(curl -s -X POST "$API_URL/authz" \
    -H "Content-Type: application/json" \
    -d "{
        \"principal\": {
            \"entityType\": \"GameUser\",
            \"entityId\": \"50bc29cc-10a1-7032-f2bc-9e0c48f6ec91\"
        },
        \"action\": {
            \"actionType\": \"Action\",
            \"actionId\": \"viewProfile\"
        },
        \"resource\": {
            \"entityType\": \"Profile\",
            \"entityId\": \"profile-123\"
        },
        \"context\": {}
    }")

echo "Cedar Authorization Response:"
echo $CEDAR_AUTH | jq '.'

echo -e "\n🎯 Enhanced JWT-Cedar Validation Testing Complete!"
echo "================================================"

# Summary
echo -e "\nTest Summary:"
echo "- Token Authentication: ✅ Completed"
echo "- Basic JWT-Cedar Validation: ✅ Completed" 
echo "- Action/Resource Authorization: ✅ Completed"
echo "- Alliance Permission Testing: ✅ Completed"
echo "- Combat Permission Testing: ✅ Completed"
echo "- Admin Permission Testing: ✅ Completed"
echo "- Cedar Authorization Comparison: ✅ Completed"

echo -e "\nAPI Endpoints Tested:"
echo "- POST /enhanced-auth (Enhanced JWT-Cedar Validation)"
echo "- POST /authz (Regular Cedar Authorization)"

echo -e "\nNext Steps:"
echo "1. Review response latency and performance"
echo "2. Validate Cedar entity creation and management"
echo "3. Test with different user types (admin, alliance members)"
echo "4. Implement more complex authorization policies"