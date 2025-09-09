#!/usr/bin/env node

// Test script for R2 Admin endpoints
// Usage: node test-r2-admin.js

const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // Set this to a valid admin JWT token

if (!ADMIN_TOKEN) {
  console.error('Please set ADMIN_TOKEN environment variable with a valid admin JWT token');
  console.log('You can get a token by logging into the admin app and checking localStorage.getItem("accessToken") in the browser console');
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
};

async function testEndpoints() {
  console.log('Testing R2 Admin Endpoints...\n');

  try {
    // Test 1: Get storage statistics
    console.log('1. Testing GET /v1.0/admin/r2/stats');
    const statsResponse = await axios.get(`${API_URL}/v1.0/admin/r2/stats`, { headers });
    console.log('✓ Storage stats:', {
      totalObjects: statsResponse.data.totalObjects,
      totalSizeMB: statsResponse.data.totalSizeMB,
      uniqueUsers: statsResponse.data.uniqueUsers,
    });
    console.log('');

    // Test 2: List objects
    console.log('2. Testing GET /v1.0/admin/r2/objects');
    const listResponse = await axios.get(`${API_URL}/v1.0/admin/r2/objects?maxKeys=5&imageOnly=true`, { headers });
    console.log(`✓ Found ${listResponse.data.items.length} objects`);
    if (listResponse.data.items.length > 0) {
      console.log('  First object:', {
        key: listResponse.data.items[0].key,
        size: listResponse.data.items[0].size,
        userId: listResponse.data.items[0].userId,
      });
    }
    console.log('');

    // Test 3: Get presigned URL for an object (if we have objects)
    if (listResponse.data.items.length > 0) {
      const firstKey = listResponse.data.items[0].key;
      console.log('3. Testing GET /v1.0/admin/r2/object-url');
      const urlResponse = await axios.get(
        `${API_URL}/v1.0/admin/r2/object-url?key=${encodeURIComponent(firstKey)}&expiresIn=3600`,
        { headers }
      );
      console.log('✓ Generated presigned URL for:', firstKey);
      console.log('  URL starts with:', urlResponse.data.presignedUrl.substring(0, 50) + '...');
    } else {
      console.log('3. Skipping URL test (no objects found)');
    }
    console.log('');

    console.log('✅ All tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    if (error.response?.status === 403) {
      console.log('\nMake sure the token belongs to a user with admin role');
    }
    process.exit(1);
  }
}

testEndpoints();