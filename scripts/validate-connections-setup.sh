#!/bin/bash

# Validate Connections System Setup
# Run with: bash scripts/validate-connections-setup.sh

echo "🔍 Validating Connections System Setup"
echo "======================================"

# Check if server is running
echo -n "1. Checking server health... "
response=$(curl -s -o /dev/null -w "%{http_code}" https://api-dev.rekkoo.com/api/v1.0/health)
if [ "$response" = "200" ]; then
    echo "✅ Server is running"
else
    echo "❌ Server is not responding (HTTP $response)"
    exit 1
fi

# Check connections endpoint (should return 401 without auth)
echo -n "2. Checking connections endpoint... "
response=$(curl -s -o /dev/null -w "%{http_code}" https://api-dev.rekkoo.com/v1.0/connections/)
if [ "$response" = "401" ]; then
    echo "✅ Connections endpoint exists (requires auth)"
else
    echo "❌ Unexpected response (HTTP $response)"
fi

# Check collaboration search endpoint
echo -n "3. Checking collaboration search endpoint... "
response=$(curl -s -o /dev/null -w "%{http_code}" https://api-dev.rekkoo.com/v1.0/collaboration/users/search)
if [ "$response" = "401" ]; then
    echo "✅ Collaboration search endpoint exists (requires auth)"
else
    echo "❌ Unexpected response (HTTP $response)"
fi

# Check group invitations endpoint
echo -n "4. Checking group invitations endpoint... "
response=$(curl -s -o /dev/null -w "%{http_code}" https://api-dev.rekkoo.com/v1.0/collaboration/groups/invitations/pending)
if [ "$response" = "401" ]; then
    echo "✅ Group invitations endpoint exists (requires auth)"
else
    echo "❌ Unexpected response (HTTP $response)"
fi

echo ""
echo "📊 Database Tables Check"
echo "------------------------"
echo "Run the following SQL to verify tables exist:"
echo ""
cat << 'EOF'
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN (
    'connections',
    'connection_invitations',
    'user_privacy_settings',
    'group_invitations'
)
ORDER BY table_name;
EOF

echo ""
echo "✨ Setup validation complete!"
echo ""
echo "Next steps:"
echo "1. Get JWT tokens for testing"
echo "2. Run: TEST_USER_1_TOKEN='token1' TEST_USER_2_TOKEN='token2' node scripts/test-connections-api.js"
echo "3. Check server logs for any errors"