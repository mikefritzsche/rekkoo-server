#!/bin/bash

# Simple Connection API Test Script
# Uses curl for testing without Node.js dependencies

# Configuration
API_BASE_URL="${API_URL:-https://api-dev.rekkoo.com}"
TOKEN="${TEST_USER_TOKEN:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🚀 Connection API Test Script"
echo "================================"
echo "API URL: $API_BASE_URL"
echo ""

if [ -z "$TOKEN" ]; then
    echo -e "${RED}❌ Error: No authentication token provided${NC}"
    echo ""
    echo "Usage:"
    echo "  TEST_USER_TOKEN='your-jwt-token' ./test-connections-simple.sh"
    echo ""
    echo "To get a token, you can:"
    echo "  1. Log in through your app and check network requests"
    echo "  2. Use your auth endpoint directly"
    echo "  3. Check browser localStorage/sessionStorage"
    exit 1
fi

# Function to make API calls
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3

    echo -e "${YELLOW}Testing: $method $endpoint${NC}"

    if [ -z "$data" ]; then
        curl -k -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            "$API_BASE_URL/v1.0/connections$endpoint" \
            -w "\nHTTP Status: %{http_code}\n" \
            2>/dev/null | python -m json.tool 2>/dev/null || echo "Response received"
    else
        curl -k -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$API_BASE_URL/v1.0/connections$endpoint" \
            -w "\nHTTP Status: %{http_code}\n" \
            2>/dev/null | python -m json.tool 2>/dev/null || echo "Response received"
    fi

    echo ""
}

# Test Privacy Settings
echo -e "${GREEN}📋 Testing Privacy Settings...${NC}"
api_call GET "/privacy"

# Test Get Connections
echo -e "${GREEN}📚 Testing Get Connections...${NC}"
api_call GET "/"

# Test Get Following
echo -e "${GREEN}👥 Testing Get Following...${NC}"
api_call GET "/following"

# Test Get Followers
echo -e "${GREEN}👥 Testing Get Followers...${NC}"
api_call GET "/followers"

# Test Pending Requests
echo -e "${GREEN}📨 Testing Pending Requests...${NC}"
api_call GET "/requests/pending"

# Test Sent Requests
echo -e "${GREEN}📤 Testing Sent Requests...${NC}"
api_call GET "/requests/sent"

# Test Expiring Invitations
echo -e "${GREEN}⏰ Testing Expiring Invitations...${NC}"
api_call GET "/requests/expiring"

# Test User Search
echo -e "${GREEN}🔍 Testing User Search...${NC}"
api_call GET "/search?query=test&searchBy=username"

echo -e "${GREEN}✅ Basic tests completed!${NC}"
echo ""
echo "To test mutations (sending requests, accepting, etc.), you can use:"
echo ""
echo "  # Send connection request:"
echo "  curl -k -X POST \\"
echo "    -H 'Authorization: Bearer \$TOKEN' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"recipientId\": \"user-uuid\", \"message\": \"Hi!\"}' \\"
echo "    $API_BASE_URL/v1.0/connections/request"
echo ""
echo "  # Follow a user:"
echo "  curl -k -X POST \\"
echo "    -H 'Authorization: Bearer \$TOKEN' \\"
echo "    $API_BASE_URL/v1.0/connections/follow/user-uuid"