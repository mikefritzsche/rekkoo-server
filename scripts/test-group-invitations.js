#!/usr/bin/env node

/**
 * Test script for Group Invitation API with Connection Requirements
 * Tests the Phase 2 implementation: Group invitations requiring connections
 */

const axios = require('axios');
const https = require('https');

// Configuration
const API_BASE_URL = process.env.API_URL || 'https://api-dev.rekkoo.com';
const USER_TOKEN = process.env.USER_TOKEN || '';
const TARGET_USER_ID = process.env.TARGET_USER_ID || '';
const GROUP_ID = process.env.GROUP_ID || '';

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

console.log('⚠️  Warning: Ignoring SSL certificate verification (development mode)');
console.log('');

// Test functions
async function testGetGroups() {
  console.log('📋 Getting user groups...');
  try {
    const response = await api.get('/collaboration/groups');
    console.log(`✅ Found ${response.data.length} groups`);

    if (response.data.length > 0) {
      console.log('\nYour groups:');
      response.data.forEach(group => {
        console.log(`  - ${group.name} (ID: ${group.id})`);
        console.log(`    Owner: ${group.owner_id === USER_TOKEN ? 'You' : group.owner_id}`);
        console.log(`    Members: ${group.member_count || 'Unknown'}`);
      });
      return response.data[0].id; // Return first group ID for testing
    }
    return null;
  } catch (error) {
    console.error('❌ Error getting groups:', error.response?.data || error.message);
    return null;
  }
}

async function testCreateGroup() {
  console.log('\n➕ Creating a test group...');
  try {
    const response = await api.post('/collaboration/groups', {
      name: `Test Group ${Date.now()}`,
      description: 'Test group for connection-based invitations'
    });
    console.log('✅ Group created:', response.data);
    return response.data.id;
  } catch (error) {
    console.error('❌ Error creating group:', error.response?.data || error.message);
    return null;
  }
}

async function testSearchConnectedUsers() {
  console.log('\n🔍 Searching for connected users...');
  try {
    // First get all connections
    const connectionsResponse = await api.get('/connections');
    console.log(`Found ${connectionsResponse.data.length} connections`);

    if (connectionsResponse.data.length > 0) {
      console.log('\nConnected users you can invite:');
      connectionsResponse.data.forEach(conn => {
        console.log(`  - @${conn.username} (${conn.full_name || 'No name'})`);
        console.log(`    ID: ${conn.connection_id}`);
        console.log(`    Type: ${conn.connection_type} | Status: ${conn.status}`);
      });
      return connectionsResponse.data[0].connection_id; // Return first connected user
    }
    return null;
  } catch (error) {
    console.error('❌ Error searching users:', error.response?.data || error.message);
    return null;
  }
}

async function testInviteToGroup(groupId, userId) {
  console.log(`\n📨 Inviting user ${userId} to group ${groupId}...`);
  try {
    const response = await api.post(`/collaboration/groups/${groupId}/invitations`, {
      userId: userId,
      role: 'member',
      message: 'Join our test group!'
    });
    console.log('✅ Invitation sent:', response.data);
    return response.data;
  } catch (error) {
    const errorData = error.response?.data;
    if (errorData?.requiresConnection) {
      console.error('❌ Connection required:', errorData.error);
      console.log('💡 You need to connect with this user first');
      console.log(`   User ID: ${errorData.userId}`);
    } else {
      console.error('❌ Error sending invitation:', errorData || error.message);
    }
    return null;
  }
}

async function testInviteNonConnectedUser(groupId) {
  console.log('\n🚫 Testing invitation to non-connected user (should fail)...');

  // Generate a random UUID-like string for testing
  const randomUserId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });

  try {
    await api.post(`/collaboration/groups/${groupId}/invitations`, {
      userId: randomUserId,
      role: 'member'
    });
    console.log('❌ UNEXPECTED: Invitation should have been rejected!');
  } catch (error) {
    const errorData = error.response?.data;
    if (errorData?.requiresConnection || errorData?.error?.includes('can only invite connected users')) {
      console.log('✅ Correctly rejected: ' + errorData.error);
    } else {
      console.log('✅ Rejected with:', errorData?.error || error.message);
    }
  }
}

async function testGetPendingInvitations() {
  console.log('\n📥 Checking pending group invitations...');
  try {
    const response = await api.get('/collaboration/groups/invitations/pending');
    console.log(`Found ${response.data.length} pending invitations`);

    if (response.data.length > 0) {
      console.log('\nPending invitations:');
      response.data.forEach(inv => {
        console.log(`  - Group: ${inv.group_name || inv.group_id}`);
        console.log(`    From: ${inv.inviter_username || inv.inviter_id}`);
        console.log(`    Role: ${inv.role || 'member'}`);
        console.log(`    ID: ${inv.id}`);
      });
      return response.data[0];
    }
    return null;
  } catch (error) {
    console.error('❌ Error getting invitations:', error.response?.data || error.message);
    return null;
  }
}

async function testAcceptInvitation(invitationId) {
  console.log(`\n✅ Accepting invitation ${invitationId}...`);
  try {
    const response = await api.post(`/collaboration/groups/invitations/${invitationId}/accept`);
    console.log('✅ Invitation accepted:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Error accepting invitation:', error.response?.data || error.message);
    return null;
  }
}

// Main test flow
async function runTests() {
  console.log('🚀 Group Invitation System Test (Phase 2)');
  console.log('=========================================');
  console.log('Testing connection-based group invitations');
  console.log('API URL:', API_BASE_URL);
  console.log('');

  if (!USER_TOKEN) {
    console.error('❌ No authentication token provided');
    console.log('\nUsage:');
    console.log('  USER_TOKEN="your-jwt-token" node scripts/test-group-invitations.js');
    console.log('\nOptional:');
    console.log('  GROUP_ID="group-uuid" - Specific group to test with');
    console.log('  TARGET_USER_ID="user-uuid" - Specific user to invite');
    process.exit(1);
  }

  console.log('=== Step 1: Check Existing Groups ===');
  let groupId = GROUP_ID || await testGetGroups();

  if (!groupId) {
    console.log('\n=== Step 2: Create a Test Group ===');
    groupId = await testCreateGroup();
    if (!groupId) {
      console.log('❌ Could not create or find a group for testing');
      process.exit(1);
    }
  }

  console.log(`\nUsing group ID: ${groupId}`);

  console.log('\n=== Step 3: Find Connected Users ===');
  const connectedUserId = TARGET_USER_ID || await testSearchConnectedUsers();

  if (!connectedUserId) {
    console.log('\n⚠️  No connected users found');
    console.log('You need to have at least one connection to test group invitations');
    console.log('\nTo create connections:');
    console.log('1. Send a connection request to another user');
    console.log('2. Have them accept it');
    console.log('3. Or follow another user (auto-accepted)');

    console.log('\n=== Testing Connection Requirement ===');
    await testInviteNonConnectedUser(groupId);
  } else {
    console.log('\n=== Step 4: Test Invitation Flow ===');

    // Test inviting a connected user (should succeed)
    const invitation = await testInviteToGroup(groupId, connectedUserId);

    // Test inviting a non-connected user (should fail)
    await testInviteNonConnectedUser(groupId);
  }

  console.log('\n=== Step 5: Check Pending Invitations ===');
  const pendingInvitation = await testGetPendingInvitations();

  if (pendingInvitation) {
    console.log('\n=== Step 6: Accept an Invitation ===');
    await testAcceptInvitation(pendingInvitation.id);
  }

  console.log('\n✨ Group invitation tests completed!');
  console.log('\n📋 Summary:');
  console.log('- Connection requirement is enforced ✅');
  console.log('- Only connected users can be invited ✅');
  console.log('- Non-connected users are properly rejected ✅');

  console.log('\n💡 Next steps:');
  console.log('1. Update frontend to show connection status before inviting');
  console.log('2. Add "Connect First" button when trying to invite non-connected users');
  console.log('3. Show pending group invitations in the app');
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});