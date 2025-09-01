#!/bin/bash

# Test script for the fixed user role endpoint
# Update these variables with your actual values

API_URL="https://api-dev.rekkoo.com"
LIST_ID="66184640-2290-4e78-9cdf-2c2c2343f195"
USER_ID="9f768190-b865-477d-9fd3-428b28e3ab7d"
AUTH_TOKEN="YOUR_AUTH_TOKEN_HERE"

echo "Testing user role endpoint..."
echo "URL: $API_URL/v1.0/collaboration/lists/$LIST_ID/users/$USER_ID/role"

# Make the API call
curl -X GET "$API_URL/v1.0/collaboration/lists/$LIST_ID/users/$USER_ID/role" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  | jq '.'

echo ""
echo "If you see a role response above, the endpoint is working!"
echo "Expected response format: { \"role\": \"viewer\" | \"reserver\" | \"editor\" | \"admin\" | \"owner\" }"