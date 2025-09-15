#!/bin/bash

# Script to update privacy settings for a user
# This enables them to appear in suggestions

API_URL="https://api-dev.rekkoo.com/v1.0"

# You'll need to set your JWT token here
TOKEN="${JWT_TOKEN:-your_jwt_token_here}"

echo "Update Privacy Settings for User"
echo "================================"
echo ""

# Get current privacy settings
echo "Current privacy settings:"
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_URL/connections/privacy" | jq '.'

echo ""
echo "Updating to allow showing in suggestions..."
echo ""

# Update privacy settings to show in suggestions
curl -X PUT -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "show_in_suggestions": true,
    "privacy_mode": "private",
    "searchable_by_username": false,
    "searchable_by_email": false,
    "allow_connection_requests": true
  }' \
  "$API_URL/connections/privacy" | jq '.'

echo ""
echo "Done! User should now appear in suggestions."
echo ""
echo "To make yourself more discoverable, you can also try:"
echo '  - privacy_mode: "standard" (balanced privacy)'
echo '  - privacy_mode: "public" (fully discoverable)'
echo ""