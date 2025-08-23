#!/bin/bash

# JWT Management System - Endpoint Testing Script
API_ID="rofefpdvc2"
REGION="eu-north-1"
BASE_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/prod"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "Testing JWT Management System Endpoints"
echo "========================================"
echo "API Gateway: ${BASE_URL}"
echo ""

# Test 1: Generate JWT Token
echo -e "${YELLOW}Test 1: Generate JWT Token${NC}"
echo "POST ${BASE_URL}/jwt/generate"

GENERATE_RESPONSE=$(curl -s -X POST "${BASE_URL}/jwt/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "test-user-123",
    "password": "TestPassword123!",
    "deviceId": "test-device-001",
    "userType": "player"
  }')

echo "Response: ${GENERATE_RESPONSE}"

# Extract tokens from response
ACCESS_TOKEN=$(echo $GENERATE_RESPONSE | jq -r '.accessToken // .token // empty')
REFRESH_TOKEN=$(echo $GENERATE_RESPONSE | jq -r '.refreshToken // empty')

if [ -n "$ACCESS_TOKEN" ]; then
    echo -e "${GREEN}Token generation successful${NC}"
    TOKEN_LENGTH=${#ACCESS_TOKEN}
    echo "Access Token received (length: ${TOKEN_LENGTH})"
else
    echo -e "${RED}Token generation failed${NC}"
    echo "Full response: $GENERATE_RESPONSE"
fi

echo ""

# Test 2: Validate JWT Token
echo -e "${YELLOW}Test 2: Validate JWT Token${NC}"
echo "POST ${BASE_URL}/jwt/validate"

if [ -n "$ACCESS_TOKEN" ]; then
    VALIDATE_RESPONSE=$(curl -s -X POST "${BASE_URL}/jwt/validate" \
      -H "Content-Type: application/json" \
      -d "{
        \"token\": \"${ACCESS_TOKEN}\"
      }")
    
    echo "Response: ${VALIDATE_RESPONSE}"
    
    IS_VALID=$(echo $VALIDATE_RESPONSE | jq -r '.isValid // .valid // false')
    
    if [ "$IS_VALID" = "true" ]; then
        echo -e "${GREEN}Token validation successful${NC}"
    else
        echo -e "${RED}Token validation failed${NC}"
    fi
else
    echo -e "${YELLOW}Skipping validation test (no token available)${NC}"
fi

echo ""

# Test 3: Refresh Token
echo -e "${YELLOW}Test 3: Refresh Token${NC}"
echo "POST ${BASE_URL}/jwt/refresh"

if [ -n "$REFRESH_TOKEN" ]; then
    REFRESH_RESPONSE=$(curl -s -X POST "${BASE_URL}/jwt/refresh" \
      -H "Content-Type: application/json" \
      -d "{
        \"refreshToken\": \"${REFRESH_TOKEN}\",
        \"deviceId\": \"test-device-001\"
      }")
    
    echo "Response: ${REFRESH_RESPONSE}"
    
    NEW_ACCESS_TOKEN=$(echo $REFRESH_RESPONSE | jq -r '.accessToken // .token // empty')
    
    if [ -n "$NEW_ACCESS_TOKEN" ]; then
        echo -e "${GREEN}Token refresh successful${NC}"
        ACCESS_TOKEN=$NEW_ACCESS_TOKEN
    else
        echo -e "${RED}Token refresh failed${NC}"
    fi
else
    echo -e "${YELLOW}Skipping refresh test (no refresh token available)${NC}"
fi

echo ""

# Test 4: Revoke Token
echo -e "${YELLOW}Test 4: Revoke Token${NC}"
echo "POST ${BASE_URL}/jwt/revoke"

if [ -n "$ACCESS_TOKEN" ]; then
    REVOKE_RESPONSE=$(curl -s -X POST "${BASE_URL}/jwt/revoke" \
      -H "Content-Type: application/json" \
      -d "{
        \"token\": \"${ACCESS_TOKEN}\",
        \"userId\": \"test-user-123\",
        \"reason\": \"Testing revocation\"
      }")
    
    echo "Response: ${REVOKE_RESPONSE}"
    
    SUCCESS=$(echo $REVOKE_RESPONSE | jq -r '.success // false')
    
    if [ "$SUCCESS" = "true" ]; then
        echo -e "${GREEN}Token revocation successful${NC}"
    else
        echo -e "${YELLOW}Revocation response received${NC}"
    fi
else
    echo -e "${YELLOW}Skipping revocation test (no token available)${NC}"
fi

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo "API Gateway URL: ${BASE_URL}"
echo "Region: ${REGION}"
echo "Test completed at: $(date)"