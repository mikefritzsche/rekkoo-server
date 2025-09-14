#!/usr/bin/env node

/**
 * Helper script to get JWT tokens for testing
 * This script helps you obtain valid JWT tokens for API testing
 */

const axios = require('axios');
const https = require('https');

const API_BASE_URL = process.env.API_URL || 'https://api-dev.rekkoo.com';

// Ignore SSL for development
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

async function loginUser(email, password) {
  try {
    const response = await axios.post(
      `${API_BASE_URL}/v1.0/auth/login`,
      {
        email: email,
        password: password
      },
      {
        httpsAgent: httpsAgent
      }
    );

    if (response.data.token) {
      return {
        token: response.data.token,
        userId: response.data.user?.id,
        username: response.data.user?.username,
        email: email
      };
    }
    return null;
  } catch (error) {
    console.error(`Failed to login ${email}:`, error.response?.data?.message || error.message);
    return null;
  }
}

async function main() {
  console.log('🔐 JWT Token Generator for Testing');
  console.log('===================================');
  console.log('API URL:', API_BASE_URL);
  console.log('');

  // Check if credentials are provided via environment variables
  const user1Email = process.env.TEST_USER_1_EMAIL;
  const user1Password = process.env.TEST_USER_1_PASSWORD;
  const user2Email = process.env.TEST_USER_2_EMAIL;
  const user2Password = process.env.TEST_USER_2_PASSWORD;

  if (!user1Email || !user1Password) {
    console.log('❌ Please provide test user credentials:');
    console.log('');
    console.log('Usage:');
    console.log('  TEST_USER_1_EMAIL="user1@example.com" \\');
    console.log('  TEST_USER_1_PASSWORD="password1" \\');
    console.log('  TEST_USER_2_EMAIL="user2@example.com" \\');
    console.log('  TEST_USER_2_PASSWORD="password2" \\');
    console.log('  node scripts/get-test-tokens.js');
    console.log('');
    console.log('Or create test users first:');
    console.log('  1. Use your app registration flow');
    console.log('  2. Or create directly in database');
    console.log('  3. Or use existing test accounts');
    process.exit(1);
  }

  console.log('Logging in test users...\n');

  // Login User 1
  console.log(`Logging in User 1: ${user1Email}`);
  const user1 = await loginUser(user1Email, user1Password);

  if (user1) {
    console.log('✅ User 1 logged in successfully');
    console.log(`   Username: ${user1.username}`);
    console.log(`   User ID: ${user1.userId}`);
    console.log('');
  } else {
    console.log('❌ Failed to login User 1\n');
  }

  // Login User 2 (if provided)
  if (user2Email && user2Password) {
    console.log(`Logging in User 2: ${user2Email}`);
    const user2 = await loginUser(user2Email, user2Password);

    if (user2) {
      console.log('✅ User 2 logged in successfully');
      console.log(`   Username: ${user2.username}`);
      console.log(`   User ID: ${user2.userId}`);
      console.log('');
    } else {
      console.log('❌ Failed to login User 2\n');
    }
  }

  // Output tokens for testing
  if (user1?.token) {
    console.log('=====================================');
    console.log('🎯 Use these tokens for testing:');
    console.log('=====================================\n');

    console.log('# For test-connections-api.js:');
    console.log(`TEST_USER_1_TOKEN="${user1.token}" \\`);
    if (user2?.token) {
      console.log(`TEST_USER_2_TOKEN="${user2.token}" \\`);
    }
    console.log('node scripts/test-connections-api.js\n');

    console.log('# For test-connections-simple.sh:');
    console.log(`TEST_USER_TOKEN="${user1.token}" ./test-connections-simple.sh\n`);

    console.log('# For manual curl testing:');
    console.log(`export TOKEN="${user1.token}"`);
    console.log('curl -k -H "Authorization: Bearer $TOKEN" \\');
    console.log(`  ${API_BASE_URL}/v1.0/connections\n`);

    console.log('⚠️  Note: Tokens typically expire after some time.');
    console.log('   Re-run this script to get fresh tokens when needed.');
  }
}

main().catch(console.error);