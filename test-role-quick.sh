#!/bin/bash

# Quick test for the role endpoint
echo "Testing role endpoint..."

curl -s 'https://api-dev.rekkoo.com/v1.0/collaboration/lists/66184640-2290-4e78-9cdf-2c2c2343f195/users/9f768190-b865-477d-9fd3-428b28e3ab7d/role' \
  -H 'accept: application/json' \
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI5Zjc2ODE5MC1iODY1LTQ3N2QtOWZkMy00MjhiMjhlM2FiN2QiLCJ1c2VybmFtZSI6Im1mNjUiLCJyb2xlcyI6WyJ2aWV3ZXIiLCJlZGl0b3IiLCJtb2RlcmF0b3IiXSwiaWF0IjoxNzU2NzUwMzA1LCJleHAiOjE3NTY4MzY3MDV9.-_5h2J7DXw9iiSmnEZDQzr1Vj2yFgGkZWzlcYjtNQ6U' \
  | python3 -m json.tool

echo ""
echo "Expected output: {\"role\": \"reserver\"} or similar"