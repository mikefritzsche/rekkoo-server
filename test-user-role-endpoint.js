/**
 * Test script for the new user role endpoint
 * Run this to verify the endpoint is working correctly
 */

const axios = require('axios');

// Configuration - update these values as needed
const API_URL = 'https://api-dev.rekkoo.com';
const AUTH_TOKEN = 'YOUR_AUTH_TOKEN_HERE'; // Replace with actual token
const LIST_ID = '66184640-2290-4e78-9cdf-2c2c2343f195';
const USER_ID = '9f768190-b865-477d-9fd3-428b28e3ab7d';

async function testUserRoleEndpoint() {
    try {
        console.log('Testing user role endpoint...');
        console.log(`URL: ${API_URL}/v1.0/collaboration/lists/${LIST_ID}/users/${USER_ID}/role`);
        
        const response = await axios.get(
            `${API_URL}/v1.0/collaboration/lists/${LIST_ID}/users/${USER_ID}/role`,
            {
                headers: {
                    'Authorization': `Bearer ${AUTH_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('Success! Response:', response.data);
        console.log('User role:', response.data.role);
        
        if (response.data.source) {
            console.log('Role source:', response.data.source);
        }
        
    } catch (error) {
        if (error.response) {
            console.error('Error response:', {
                status: error.response.status,
                data: error.response.data
            });
        } else {
            console.error('Error:', error.message);
        }
    }
}

// Instructions for using this test script
console.log(`
=== User Role Endpoint Test Script ===

Before running this test:
1. Make sure the server is running (npm run dev in the server directory)
2. Replace AUTH_TOKEN with a valid JWT token
3. Optionally update LIST_ID and USER_ID for your test case

To get a valid auth token:
- Check browser DevTools Network tab when logged in
- Look for Authorization header in API requests
- Copy the token after "Bearer "

`);

// Uncomment to run the test
// testUserRoleEndpoint();