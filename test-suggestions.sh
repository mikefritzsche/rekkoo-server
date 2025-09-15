#!/bin/bash

# Test script for user suggestions API

API_URL="https://api-dev.rekkoo.com/v1.0"

# You'll need to set your JWT token here
TOKEN="${JWT_TOKEN:-your_jwt_token_here}"

echo "Testing User Suggestions API"
echo "================================"

# Test regular suggestions endpoint
echo -e "\n1. Testing /users/suggestions:"
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_URL/users/suggestions?page=1&limit=10" | jq '.'

# Test debug endpoint
echo -e "\n2. Testing /users/suggestions/debug:"
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_URL/users/suggestions/debug" | jq '.'

echo -e "\nDone!"