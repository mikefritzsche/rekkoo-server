#!/bin/bash

# Test the debug endpoint for user suggestions
# This will show why users might not be appearing in suggestions

API_URL="https://api-dev.rekkoo.com/v1.0"

# You'll need to set your JWT token here
# You can get this from the browser's developer tools when logged in
TOKEN="${JWT_TOKEN:-your_jwt_token_here}"

echo "Testing User Suggestions Debug Endpoint"
echo "========================================"
echo ""

# Test debug endpoint
echo "Calling /users/suggestions/debug:"
echo ""

curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_URL/users/suggestions/debug" | jq '.'

echo ""
echo "Key things to check:"
echo "1. eligible_count - How many users are eligible for suggestions"
echo "2. users_without_settings - Users who don't have settings records (should be included)"
echo "3. status_counts - Breakdown of why users are excluded"
echo "4. is_following - Which users are already being followed (should be filtered on frontend)"
echo ""
echo "Done!"