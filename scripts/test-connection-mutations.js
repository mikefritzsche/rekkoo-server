#!/usr/bin/env node

/**
 * Test Connection Mutations - Send requests, follow users, accept/decline
 * This tests the write operations of the connections API
 */

const axios = require('axios');
const https = require('https');

// Configuration
const API_BASE_URL = process.env.API_URL || 'https://api-dev.rekkoo.com';
const USER_TOKEN = process.env.USER_TOKEN || '';
const TARGET_USER_ID = process.env.TARGET_USER_ID || '';
const TARGET_USERNAME = process.env.TARGET_USERNAME || '';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const api = axios.create({
  baseURL: `${API_BASE_URL}/v1.0`,
  headers: {
    'Authorization': `Bearer ${USER_TOKEN}`,
    'Content-Type': 'application/json'
  },
  httpsAgent: httpsAgent
});

// Helper function to find a user
async function findUserToConnect() {
  console.log('🔍 Searching for users to connect with...');

  try {
    // Try searching by username patterns
    const searchPatterns = ['mike', 'test', 'admin', 'user', 'demo'];

    for (const pattern of searchPatterns) {
      const response = await api.get(`/connections/search?query=${pattern}&searchBy=username`);
      if (response.data && response.data.length > 0) {
        // Find a user we're not already connected to
        const unconnectedUser = response.data.find(u => !u.isConnected);
        if (unconnectedUser) {
          console.log(`✅ Found user: @${unconnectedUser.username} (${unconnectedUser.full_name})`);
          return unconnectedUser;
        }
      }
    }

    console.log('❌ No unconnected users found in search');
    return null;
  } catch (error) {
    console.error('Search error:', error.response?.data || error.message);
    return null;
  }
}

// Test sending a mutual connection request
async function testSendConnectionRequest(recipientId, recipientUsername) {
  console.log(`\n📤 Sending connection request to @${recipientUsername}...`);

  try {
    const response = await api.post('/connections/request', {
      recipientId: recipientId,
      message: 'Hi! I would like to connect with you.',
      connectionType: 'mutual'
    });

    console.log('✅ Connection request sent:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to send request:', error.response?.data || error.message);
    return null;
  }
}

// Test following a user
async function testFollowUser(userId, username) {
  console.log(`\n👥 Following @${username}...`);

  try {
    const response = await api.post(`/connections/follow/${userId}`);
    console.log('✅ Now following:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to follow:', error.response?.data || error.message);
    return null;
  }
}

// Test unfollowing a user
async function testUnfollowUser(userId, username) {
  console.log(`\n👤 Unfollowing @${username}...`);

  try {
    const response = await api.delete(`/connections/unfollow/${userId}`);
    console.log('✅ Unfollowed:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to unfollow:', error.response?.data || error.message);
    return null;
  }
}

// Test accepting a pending request
async function testAcceptRequest() {
  console.log('\n✅ Checking for pending requests to accept...');

  try {
    const pendingResponse = await api.get('/connections/requests/pending');

    if (pendingResponse.data.length === 0) {
      console.log('No pending requests to accept');
      return null;
    }

    const request = pendingResponse.data[0];
    console.log(`Found request from: ${request.sender?.username}`);

    const acceptResponse = await api.post(`/connections/requests/${request.id}/accept`);
    console.log('✅ Request accepted:', acceptResponse.data);
    return acceptResponse.data;
  } catch (error) {
    console.error('❌ Failed to accept request:', error.response?.data || error.message);
    return null;
  }
}

// Test connection status check
async function testConnectionStatus(userId) {
  console.log(`\n🔍 Checking connection status with user ${userId}...`);

  try {
    const response = await api.get(`/connections/status/${userId}`);
    console.log('Connection status:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to check status:', error.response?.data || error.message);
    return null;
  }
}

// Main test flow
async function runTests() {
  console.log('🚀 Connection Mutations Test');
  console.log('=============================');
  console.log('API URL:', API_BASE_URL);
  console.log('');

  if (!USER_TOKEN) {
    console.error('❌ No authentication token provided');
    console.log('\nUsage:');
    console.log('  USER_TOKEN="your-jwt-token" node scripts/test-connection-mutations.js');
    console.log('\nOptional:');
    console.log('  TARGET_USER_ID="user-uuid" - Specific user to connect with');
    process.exit(1);
  }

  // If TARGET_USER_ID provided, use it
  let targetUser = null;
  if (TARGET_USER_ID) {
    targetUser = {
      id: TARGET_USER_ID,
      username: TARGET_USERNAME || 'specified-user'
    };
    console.log(`Using specified target user: ${TARGET_USER_ID}`);
  } else {
    // Otherwise, find a user to test with
    targetUser = await findUserToConnect();
  }

  if (!targetUser) {
    console.log('\n⚠️  No target user available for testing mutations');
    console.log('You can specify a user with: TARGET_USER_ID="user-uuid"');
    process.exit(0);
  }

  // Run test sequence
  console.log(`\n🎯 Testing with user: @${targetUser.username} (${targetUser.id})`);

  // 1. Check initial status
  const initialStatus = await testConnectionStatus(targetUser.id);

  // 2. Test based on current status
  if (initialStatus) {
    if (initialStatus.isConnected) {
      console.log('Already connected to this user');
    } else if (initialStatus.hasSentRequest) {
      console.log('Already sent a request to this user');
    } else if (initialStatus.hasReceivedRequest) {
      console.log('This user has sent you a request - accepting it');
      await testAcceptRequest();
    } else {
      // Not connected, test different connection types
      console.log('\n--- Testing Connection Types ---');

      // Test following
      await testFollowUser(targetUser.id, targetUser.username);

      // Check status after following
      await testConnectionStatus(targetUser.id);

      // Unfollow
      await testUnfollowUser(targetUser.id, targetUser.username);

      // Send mutual connection request
      await testSendConnectionRequest(targetUser.id, targetUser.username);

      // Final status check
      await testConnectionStatus(targetUser.id);
    }
  }

  console.log('\n✨ Mutation tests completed!');
  console.log('\nCheck your connections with:');
  console.log('  USER_TOKEN="your-token" node scripts/test-connections-api.js');
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});