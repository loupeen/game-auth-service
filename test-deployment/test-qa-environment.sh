#!/bin/bash

# QA Environment JWT Management System - Comprehensive Testing Script
QA_API_ID="k1lyuds5y5"
QA_REGION="us-east-1"
QA_BASE_URL="https://${QA_API_ID}.execute-api.${QA_REGION}.amazonaws.com/prod"
ENVIRONMENT="qa"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}===============================================${NC}"
echo -e "${BLUE}  QA Environment Validation Test Suite${NC}"
echo -e "${BLUE}===============================================${NC}"
echo -e "${CYAN}Environment: ${ENVIRONMENT}${NC}"
echo -e "${CYAN}Region: ${QA_REGION}${NC}"
echo -e "${CYAN}API Gateway: ${QA_BASE_URL}${NC}"
echo -e "${CYAN}Time: $(date)${NC}"
echo ""

# Global variables for test results
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
TEST_RESULTS=()

# Function to run a test and record results
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_status="$3"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -e "${YELLOW}Test ${TOTAL_TESTS}: ${test_name}${NC}"
    
    # Execute the test command and capture both output and HTTP status
    local start_time=$(date +%s)
    local response=$(eval "$test_command")
    local exit_code=$?
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    # Check if test passed
    if [ $exit_code -eq 0 ]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo -e "${GREEN}✅ PASSED${NC} (${duration}s)"
        TEST_RESULTS+=("✅ $test_name - PASSED (${duration}s)")
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo -e "${RED}❌ FAILED${NC} (${duration}s)"
        echo -e "${RED}Error: $response${NC}"
        TEST_RESULTS+=("❌ $test_name - FAILED (${duration}s)")
    fi
    echo ""
}

# Function to create test user in QA Cognito
create_qa_test_user() {
    echo -e "${BLUE}Creating Test User in QA Environment${NC}"
    echo "=================================="
    
    # QA User Pool ID from deployment output
    local USER_POOL_ID="us-east-1_kgI32QiAb"
    local TEST_USERNAME="qa-test-user-$(date +%s)"
    local TEST_PASSWORD="QATestPassword123!"
    local TEST_EMAIL="qa-test@loupeen.com"
    
    # Create user
    aws cognito-idp admin-create-user \
        --user-pool-id $USER_POOL_ID \
        --username $TEST_USERNAME \
        --user-attributes Name=email,Value=$TEST_EMAIL Name=email_verified,Value=true \
        --temporary-password $TEST_PASSWORD \
        --message-action SUPPRESS \
        --profile AWSAdministratorAccess-077029784291 \
        --region $QA_REGION > /dev/null 2>&1
    
    # Set permanent password
    aws cognito-idp admin-set-user-password \
        --user-pool-id $USER_POOL_ID \
        --username $TEST_USERNAME \
        --password $TEST_PASSWORD \
        --permanent \
        --profile AWSAdministratorAccess-077029784291 \
        --region $QA_REGION > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Test user created successfully${NC}"
        echo "Username: $TEST_USERNAME"
        echo "Password: $TEST_PASSWORD"
        echo ""
        
        # Export for use in tests
        export QA_TEST_USERNAME="$TEST_USERNAME"
        export QA_TEST_PASSWORD="$TEST_PASSWORD"
        return 0
    else
        echo -e "${RED}❌ Failed to create test user${NC}"
        return 1
    fi
}

# Test 1: API Gateway Health Check
test_api_health() {
    run_test "API Gateway Health Check" \
        "curl -s -o /dev/null -w '%{http_code}' '$QA_BASE_URL/'" \
        "200"
}

# Test 2: JWT Token Generation
test_token_generation() {
    local test_cmd="curl -s -X POST '$QA_BASE_URL/jwt/generate' \
        -H 'Content-Type: application/json' \
        -d '{
            \"username\": \"$QA_TEST_USERNAME\",
            \"password\": \"$QA_TEST_PASSWORD\",
            \"deviceId\": \"qa-test-device-001\",
            \"userType\": \"player\"
        }' | jq -e '.accessToken != null'"
    
    run_test "JWT Token Generation" "$test_cmd" "0"
    
    # Store tokens for subsequent tests
    if [ $? -eq 0 ]; then
        local response=$(curl -s -X POST "$QA_BASE_URL/jwt/generate" \
            -H "Content-Type: application/json" \
            -d "{
                \"username\": \"$QA_TEST_USERNAME\",
                \"password\": \"$QA_TEST_PASSWORD\",
                \"deviceId\": \"qa-test-device-001\",
                \"userType\": \"player\"
            }")
        
        export QA_ACCESS_TOKEN=$(echo $response | jq -r '.accessToken')
        export QA_REFRESH_TOKEN=$(echo $response | jq -r '.refreshToken')
        
        echo -e "${CYAN}Tokens stored for subsequent tests${NC}"
        echo ""
    fi
}

# Test 3: JWT Token Validation
test_token_validation() {
    if [ -n "$QA_ACCESS_TOKEN" ]; then
        local test_cmd="curl -s -X POST '$QA_BASE_URL/jwt/validate' \
            -H 'Content-Type: application/json' \
            -d '{\"token\": \"$QA_ACCESS_TOKEN\"}' | jq -e '.valid == true'"
        
        run_test "JWT Token Validation" "$test_cmd" "0"
    else
        echo -e "${YELLOW}Skipping token validation - no access token available${NC}"
    fi
}

# Test 4: JWT Token Refresh
test_token_refresh() {
    if [ -n "$QA_REFRESH_TOKEN" ]; then
        local test_cmd="curl -s -X POST '$QA_BASE_URL/jwt/refresh' \
            -H 'Content-Type: application/json' \
            -d '{
                \"refreshToken\": \"$QA_REFRESH_TOKEN\",
                \"deviceId\": \"qa-test-device-001\"
            }' | jq -e '.accessToken != null'"
        
        run_test "JWT Token Refresh" "$test_cmd" "0"
    else
        echo -e "${YELLOW}Skipping token refresh - no refresh token available${NC}"
    fi
}

# Test 5: JWT Token Revocation
test_token_revocation() {
    if [ -n "$QA_ACCESS_TOKEN" ]; then
        local test_cmd="curl -s -X POST '$QA_BASE_URL/jwt/revoke' \
            -H 'Content-Type: application/json' \
            -d '{
                \"token\": \"$QA_ACCESS_TOKEN\",
                \"reason\": \"QA environment testing\"
            }' | jq -e '.success == true'"
        
        run_test "JWT Token Revocation" "$test_cmd" "0"
    else
        echo -e "${YELLOW}Skipping token revocation - no access token available${NC}"
    fi
}

# Test 6: Performance Validation
test_performance() {
    echo -e "${BLUE}Performance Testing${NC}"
    echo "=================="
    
    local total_time=0
    local test_count=5
    
    for i in $(seq 1 $test_count); do
        local start_time=$(date +%s)
        
        curl -s -X POST "$QA_BASE_URL/jwt/generate" \
            -H "Content-Type: application/json" \
            -d "{
                \"username\": \"$QA_TEST_USERNAME\",
                \"password\": \"$QA_TEST_PASSWORD\",
                \"deviceId\": \"qa-perf-test-$i\",
                \"userType\": \"player\"
            }" > /dev/null
        
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        total_time=$((total_time + duration))
        
        echo "Request $i: ${duration}s"
    done
    
    local avg_time=$((total_time / test_count))
    echo -e "${CYAN}Average response time: ${avg_time}s${NC}"
    
    # Performance validation
    if [ $avg_time -lt 2 ]; then
        echo -e "${GREEN}✅ Performance: EXCELLENT (<2s)${NC}"
    elif [ $avg_time -lt 5 ]; then
        echo -e "${YELLOW}⚠️  Performance: GOOD (2-5s)${NC}"
    else
        echo -e "${RED}❌ Performance: NEEDS IMPROVEMENT (>5s)${NC}"
    fi
    echo ""
}

# Test 7: Error Handling
test_error_handling() {
    echo -e "${BLUE}Error Handling Tests${NC}"
    echo "==================="
    
    # Test invalid credentials
    run_test "Invalid Credentials Handling" \
        "curl -s -X POST '$QA_BASE_URL/jwt/generate' \
            -H 'Content-Type: application/json' \
            -d '{
                \"username\": \"invalid-user\",
                \"password\": \"wrong-password\",
                \"deviceId\": \"test-device\",
                \"userType\": \"player\"
            }' | jq -e '.error != null'" \
        "0"
    
    # Test malformed request
    run_test "Malformed Request Handling" \
        "curl -s -o /dev/null -w '%{http_code}' -X POST '$QA_BASE_URL/jwt/generate' \
            -H 'Content-Type: application/json' \
            -d '{\"invalid\": \"request\"}' | grep -q '400'" \
        "0"
    
    # Test invalid token validation
    run_test "Invalid Token Validation" \
        "curl -s -X POST '$QA_BASE_URL/jwt/validate' \
            -H 'Content-Type: application/json' \
            -d '{\"token\": \"invalid.token.here\"}' | jq -e '.valid == false'" \
        "0"
}

# Test 8: CORS and Security Headers
test_security_headers() {
    echo -e "${BLUE}Security Headers Test${NC}"
    echo "===================="
    
    local headers=$(curl -s -I "$QA_BASE_URL/jwt/generate")
    
    if echo "$headers" | grep -q "access-control-allow-origin"; then
        echo -e "${GREEN}✅ CORS headers present${NC}"
    else
        echo -e "${RED}❌ CORS headers missing${NC}"
    fi
    
    if echo "$headers" | grep -q "content-type"; then
        echo -e "${GREEN}✅ Content-Type header present${NC}"
    else
        echo -e "${RED}❌ Content-Type header missing${NC}"
    fi
    echo ""
}

# Test 9: Environment-Specific Configuration
test_environment_config() {
    echo -e "${BLUE}Environment Configuration Test${NC}"
    echo "=============================="
    
    # Test that we're hitting the QA environment
    local response=$(curl -s -X POST "$QA_BASE_URL/jwt/generate" \
        -H "Content-Type: application/json" \
        -d "{
            \"username\": \"$QA_TEST_USERNAME\",
            \"password\": \"$QA_TEST_PASSWORD\",
            \"deviceId\": \"env-test-device\",
            \"userType\": \"player\"
        }")
    
    local access_token=$(echo $response | jq -r '.accessToken')
    
    if [ -n "$access_token" ] && [ "$access_token" != "null" ]; then
        # Decode JWT payload to check issuer
        local payload=$(echo $access_token | cut -d'.' -f2 | base64 -d 2>/dev/null | jq -r '.iss' 2>/dev/null)
        
        if echo "$payload" | grep -q "qa"; then
            echo -e "${GREEN}✅ Environment-specific configuration correct (QA)${NC}"
        else
            echo -e "${YELLOW}⚠️  Environment configuration may not be QA-specific${NC}"
        fi
    else
        echo -e "${RED}❌ Could not verify environment configuration${NC}"
    fi
    echo ""
}

# Main execution
main() {
    echo -e "${BLUE}Starting QA Environment Validation...${NC}"
    echo ""
    
    # Create test user
    if ! create_qa_test_user; then
        echo -e "${RED}Failed to create test user. Exiting.${NC}"
        exit 1
    fi
    
    # Run all tests
    test_api_health
    test_token_generation
    test_token_validation
    test_token_refresh
    test_token_revocation
    test_performance
    test_error_handling
    test_security_headers
    test_environment_config
    
    # Test Summary
    echo -e "${BLUE}===============================================${NC}"
    echo -e "${BLUE}          QA Environment Test Summary${NC}"
    echo -e "${BLUE}===============================================${NC}"
    echo -e "${CYAN}Total Tests: ${TOTAL_TESTS}${NC}"
    echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
    echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"
    echo ""
    
    # Calculate success rate
    local success_rate=$((PASSED_TESTS * 100 / TOTAL_TESTS))
    echo -e "${CYAN}Success Rate: ${success_rate}%${NC}"
    
    if [ $success_rate -ge 90 ]; then
        echo -e "${GREEN}🎉 QA Environment: EXCELLENT${NC}"
    elif [ $success_rate -ge 75 ]; then
        echo -e "${YELLOW}⚠️  QA Environment: GOOD (some issues)${NC}"
    else
        echo -e "${RED}❌ QA Environment: NEEDS ATTENTION${NC}"
    fi
    
    echo ""
    echo -e "${BLUE}Detailed Results:${NC}"
    for result in "${TEST_RESULTS[@]}"; do
        echo "  $result"
    done
    
    echo ""
    echo -e "${CYAN}QA validation completed at: $(date)${NC}"
    echo -e "${CYAN}Next steps: Compare with Test environment performance${NC}"
    
    # Cleanup test user
    echo ""
    echo -e "${BLUE}Cleaning up test user...${NC}"
    aws cognito-idp admin-delete-user \
        --user-pool-id "us-east-1_kgI32QiAb" \
        --username "$QA_TEST_USERNAME" \
        --profile AWSAdministratorAccess-077029784291 \
        --region $QA_REGION > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Test user cleaned up${NC}"
    fi
}

# Check dependencies
if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq is required but not installed${NC}"
    exit 1
fi

if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is required but not installed${NC}"
    exit 1
fi

# Run main function
main