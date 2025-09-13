#!/usr/bin/env node

/**
 * Test script for Connection API endpoints
 * Run with: node scripts/test-connections-api.js
 */

const axios = require('axios');

// Configuration
const API_BASE_URL = process.env.API_URL || 'https://api-dev.rekkoo.com';
const TEST_USER_1_TOKEN = process.env.TEST_USER_1_TOKEN || ''; // Set this to a valid JWT token
const TEST_USER_2_TOKEN = process.env.TEST_USER_2_TOKEN || ''; // Set this to a valid JWT token for second user

// Create axios instances for each user
const user1Api = axios.create({
  baseURL: `${API_BASE_URL}/v1.0/connections`,
  headers: {
    'Authorization': `Bearer ${TEST_USER_1_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

const user2Api = axios.create({
  baseURL: `${API_BASE_URL}/v1.0/connections`,
  headers: {
    'Authorization': `Bearer ${TEST_USER_2_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// Test functions
async function testPrivacySettings() {
  console.log('\n📋 Testing Privacy Settings...');

  try {
    // Get current privacy settings
    const response = await user1Api.get('/privacy');
    console.log('✅ Get privacy settings:', response.data);

    // Update privacy settings
    const updateResponse = await user1Api.put('/privacy', {
      privacy_mode: 'standard',
      searchable_by_username: true,
      allow_connection_requests: true
    });
    console.log('✅ Update privacy settings:', updateResponse.data);

  } catch (error) {
    console.error('❌ Privacy settings error:', error.response?.data || error.message);
  }
}

async function testUserSearch() {
  console.log('\n🔍 Testing User Search...');

  try {
    const response = await user1Api.get('/search', {
      params: {
        query: 'test',
        searchBy: 'username'
      }
    });
    console.log('✅ Search results:', response.data);
    return response.data[0]?.id; // Return first user ID for further testing

  } catch (error) {
    console.error('❌ Search error:', error.response?.data || error.message);
    return null;
  }
}

async function testConnectionFlow(recipientId) {
  if (!recipientId) {
    console.log('⚠️  No recipient ID provided, skipping connection flow test');
    return;
  }

  console.log('\n🤝 Testing Connection Flow...');

  try {
    // 1. Send connection request
    console.log('1️⃣  Sending connection request...');
    const requestResponse = await user1Api.post('/request', {
      recipientId: recipientId,
      message: 'Hi! Let\'s connect on Rekkoo!'
    });
    console.log('✅ Connection request sent:', requestResponse.data);

    // 2. Check pending requests for recipient
    console.log('2️⃣  Checking pending requests for recipient...');
    const pendingResponse = await user2Api.get('/requests/pending');
    console.log('✅ Pending requests:', pendingResponse.data);

    const requestId = pendingResponse.data[0]?.id;

    if (requestId) {
      // 3. Accept the request
      console.log('3️⃣  Accepting connection request...');
      const acceptResponse = await user2Api.post(`/requests/${requestId}/accept`);
      console.log('✅ Request accepted:', acceptResponse.data);

      // 4. Verify connections list
      console.log('4️⃣  Verifying connections...');
      const connectionsResponse = await user1Api.get('/');
      console.log('✅ User 1 connections:', connectionsResponse.data);

      const connections2Response = await user2Api.get('/');
      console.log('✅ User 2 connections:', connections2Response.data);
    }

  } catch (error) {
    console.error('❌ Connection flow error:', error.response?.data || error.message);
  }
}

async function testGetConnections() {
  console.log('\n📚 Testing Get Connections...');

  try {
    const response = await user1Api.get('/');
    console.log('✅ Current connections:', response.data);

  } catch (error) {
    console.error('❌ Get connections error:', error.response?.data || error.message);
  }
}

async function testGetSentRequests() {
  console.log('\n📤 Testing Get Sent Requests...');

  try {
    const response = await user1Api.get('/requests/sent');
    console.log('✅ Sent requests:', response.data);

  } catch (error) {
    console.error('❌ Get sent requests error:', error.response?.data || error.message);
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting Connection API Tests');
  console.log('================================');
  console.log('API URL:', API_BASE_URL);

  if (!TEST_USER_1_TOKEN || !TEST_USER_2_TOKEN) {
    console.error('❌ Please set TEST_USER_1_TOKEN and TEST_USER_2_TOKEN environment variables');
    console.log('\nExample usage:');
    console.log('TEST_USER_1_TOKEN="your-jwt-token-1" TEST_USER_2_TOKEN="your-jwt-token-2" node scripts/test-connections-api.js');
    process.exit(1);
  }

  // Run tests in sequence
  await testPrivacySettings();
  const userId = await testUserSearch();
  await testConnectionFlow(userId);
  await testGetConnections();
  await testGetSentRequests();

  console.log('\n✨ Connection API tests completed!');
}

// Run the tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});