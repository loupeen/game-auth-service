#!/bin/bash

# QA Environment CloudWatch Monitoring Setup
QA_REGION="us-east-1"
QA_PROFILE="AWSAdministratorAccess-077029784291"
ENVIRONMENT="qa"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}===============================================${NC}"
echo -e "${BLUE}    QA Environment Monitoring Setup${NC}"
echo -e "${BLUE}===============================================${NC}"
echo -e "${CYAN}Region: ${QA_REGION}${NC}"
echo -e "${CYAN}Environment: ${ENVIRONMENT}${NC}"
echo -e "${CYAN}Time: $(date)${NC}"
echo ""

# Function to create CloudWatch alarm
create_alarm() {
    local alarm_name="$1"
    local metric_name="$2"
    local namespace="$3"
    local threshold="$4"
    local comparison="$5"
    local description="$6"
    local dimensions="$7"
    
    echo -e "${YELLOW}Creating alarm: ${alarm_name}${NC}"
    
    aws cloudwatch put-metric-alarm \
        --alarm-name "JWT-QA-${alarm_name}" \
        --alarm-description "${description}" \
        --metric-name "${metric_name}" \
        --namespace "${namespace}" \
        --statistic Average \
        --period 300 \
        --threshold ${threshold} \
        --comparison-operator ${comparison} \
        --evaluation-periods 2 \
        --treat-missing-data notBreaching \
        --dimensions ${dimensions} \
        --region ${QA_REGION} \
        --profile ${QA_PROFILE}
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ ${alarm_name} alarm created${NC}"
    else
        echo -e "${RED}❌ Failed to create ${alarm_name} alarm${NC}"
    fi
    echo ""
}

# Get Lambda function names from QA environment
echo -e "${BLUE}Discovering QA Lambda functions...${NC}"

LAMBDA_FUNCTIONS=$(aws lambda list-functions \
    --region ${QA_REGION} \
    --profile ${QA_PROFILE} \
    --query 'Functions[?contains(FunctionName, `GameAuthService-qa`)].FunctionName' \
    --output text)

echo -e "${CYAN}Found Lambda functions:${NC}"
for func in $LAMBDA_FUNCTIONS; do
    echo "  - $func"
done
echo ""

# Create Lambda monitoring alarms
echo -e "${BLUE}Setting up Lambda monitoring alarms...${NC}"

for func_name in $LAMBDA_FUNCTIONS; do
    echo -e "${YELLOW}Setting up alarms for: ${func_name}${NC}"
    
    # Error rate alarm
    create_alarm \
        "${func_name}-ErrorRate" \
        "Errors" \
        "AWS/Lambda" \
        "5" \
        "GreaterThanThreshold" \
        "High error rate for ${func_name} in QA" \
        "Name=${func_name}"
    
    # Duration alarm
    create_alarm \
        "${func_name}-Duration" \
        "Duration" \
        "AWS/Lambda" \
        "5000" \
        "GreaterThanThreshold" \
        "High duration for ${func_name} in QA" \
        "Name=${func_name}"
    
    # Throttle alarm
    create_alarm \
        "${func_name}-Throttles" \
        "Throttles" \
        "AWS/Lambda" \
        "1" \
        "GreaterThanThreshold" \
        "Throttling detected for ${func_name} in QA" \
        "Name=${func_name}"
done

# API Gateway monitoring
echo -e "${BLUE}Setting up API Gateway monitoring...${NC}"

API_ID="k1lyuds5y5"

# API Gateway 4XX errors
create_alarm \
    "APIGateway-4XXError" \
    "4XXError" \
    "AWS/ApiGateway" \
    "10" \
    "GreaterThanThreshold" \
    "High 4XX error rate for JWT API in QA" \
    "ApiName=GameAuthService-qa"

# API Gateway 5XX errors
create_alarm \
    "APIGateway-5XXError" \
    "5XXError" \
    "AWS/ApiGateway" \
    "1" \
    "GreaterThanThreshold" \
    "5XX errors detected for JWT API in QA" \
    "ApiName=GameAuthService-qa"

# API Gateway latency
create_alarm \
    "APIGateway-Latency" \
    "Latency" \
    "AWS/ApiGateway" \
    "2000" \
    "GreaterThanThreshold" \
    "High latency for JWT API in QA" \
    "ApiName=GameAuthService-qa"

# DynamoDB monitoring
echo -e "${BLUE}Setting up DynamoDB monitoring...${NC}"

# Get DynamoDB table names
DYNAMODB_TABLES=$(aws dynamodb list-tables \
    --region ${QA_REGION} \
    --profile ${QA_PROFILE} \
    --query 'TableNames[?contains(@, `loupeen`) && contains(@, `qa`)]' \
    --output text)

echo -e "${CYAN}Found DynamoDB tables:${NC}"
for table in $DYNAMODB_TABLES; do
    echo "  - $table"
done
echo ""

for table_name in $DYNAMODB_TABLES; do
    echo -e "${YELLOW}Setting up alarms for table: ${table_name}${NC}"
    
    # Read throttle alarm
    create_alarm \
        "${table_name}-ReadThrottles" \
        "ReadThrottledEvents" \
        "AWS/DynamoDB" \
        "1" \
        "GreaterThanThreshold" \
        "Read throttling detected for ${table_name} in QA" \
        "TableName=${table_name}"
    
    # Write throttle alarm
    create_alarm \
        "${table_name}-WriteThrottles" \
        "WriteThrottledEvents" \
        "AWS/DynamoDB" \
        "1" \
        "GreaterThanThreshold" \
        "Write throttling detected for ${table_name} in QA" \
        "TableName=${table_name}"
done

# Custom JWT validation latency alarm (if custom metrics are available)
echo -e "${BLUE}Setting up custom JWT metrics monitoring...${NC}"

create_alarm \
    "JWT-ValidationLatency" \
    "ValidationLatency" \
    "Loupeen/JWT" \
    "300" \
    "GreaterThanThreshold" \
    "JWT validation latency exceeding 300ms in QA" \
    "Environment=qa"

# Create CloudWatch dashboard for QA environment
echo -e "${BLUE}Creating QA monitoring dashboard...${NC}"

cat > /tmp/qa-dashboard.json << 'EOF'
{
    "widgets": [
        {
            "type": "metric",
            "x": 0,
            "y": 0,
            "width": 12,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AWS/Lambda", "Duration", "FunctionName", "GameAuthService-qa-EnhancedJwtManagementConstructTokenGenerationFunction" ],
                    [ ".", "Errors", ".", "." ],
                    [ ".", "Invocations", ".", "." ]
                ],
                "period": 300,
                "stat": "Average",
                "region": "us-east-1",
                "title": "JWT Token Generation Lambda"
            }
        },
        {
            "type": "metric",
            "x": 12,
            "y": 0,
            "width": 12,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AWS/Lambda", "Duration", "FunctionName", "GameAuthService-qa-EnhancedJwtManagementConstructEnhancedTokenValidationFunction" ],
                    [ ".", "Errors", ".", "." ],
                    [ ".", "Invocations", ".", "." ]
                ],
                "period": 300,
                "stat": "Average",
                "region": "us-east-1",
                "title": "JWT Token Validation Lambda"
            }
        },
        {
            "type": "metric",
            "x": 0,
            "y": 6,
            "width": 24,
            "height": 6,
            "properties": {
                "metrics": [
                    [ "AWS/ApiGateway", "4XXError", "ApiName", "GameAuthService-qa" ],
                    [ ".", "5XXError", ".", "." ],
                    [ ".", "Latency", ".", "." ],
                    [ ".", "Count", ".", "." ]
                ],
                "period": 300,
                "stat": "Sum",
                "region": "us-east-1",
                "title": "API Gateway Metrics"
            }
        }
    ]
}
EOF

aws cloudwatch put-dashboard \
    --dashboard-name "JWT-QA-Environment" \
    --dashboard-body file:///tmp/qa-dashboard.json \
    --region ${QA_REGION} \
    --profile ${QA_PROFILE}

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ QA monitoring dashboard created${NC}"
else
    echo -e "${RED}❌ Failed to create QA monitoring dashboard${NC}"
fi

# List all created alarms
echo ""
echo -e "${BLUE}Created CloudWatch Alarms:${NC}"
aws cloudwatch describe-alarms \
    --alarm-name-prefix "JWT-QA-" \
    --region ${QA_REGION} \
    --profile ${QA_PROFILE} \
    --query 'MetricAlarms[*].[AlarmName,StateValue,MetricName]' \
    --output table

echo ""
echo -e "${GREEN}🎉 QA Environment Monitoring Setup Complete!${NC}"
echo ""
echo -e "${CYAN}Dashboard URL:${NC}"
echo "https://console.aws.amazon.com/cloudwatch/home?region=${QA_REGION}#dashboards:name=JWT-QA-Environment"
echo ""
echo -e "${CYAN}CloudWatch Alarms:${NC}"
echo "https://console.aws.amazon.com/cloudwatch/home?region=${QA_REGION}#alarmsV2:"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Configure SNS topics for alarm notifications"
echo "2. Set up email/Slack notifications"
echo "3. Test alarm triggers with load testing"
echo "4. Review and adjust alarm thresholds based on usage patterns"

rm -f /tmp/qa-dashboard.json