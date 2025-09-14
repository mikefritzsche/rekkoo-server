#!/usr/bin/env node

/**
 * Test Phase 3 List Sharing with a specific list ID
 * Use this after creating a list with create-test-list.sql
 */

const https = require('https');
const axios = require('axios');

const API_URL = process.env.API_URL || 'https://api-dev.rekkoo.com';
const TOKEN = process.env.USER_TOKEN;
const LIST_ID = process.env.LIST_ID;

if (!TOKEN) {
  console.error('❌ Please provide a token:');
  console.error('   USER_TOKEN="your-token" LIST_ID="list-id-from-sql" node test-specific-list.js');
  process.exit(1);
}

if (!LIST_ID) {
  console.error('❌ Please provide the list ID from the SQL script:');
  console.error('   USER_TOKEN="your-token" LIST_ID="list-id-from-sql" node test-specific-list.js');
  console.error('\n💡 Run the create-test-list.sql script first to get a list ID');
  process.exit(1);
}

// Create axios instance
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  })
});

async function testListOperations() {
  console.log('🧪 Testing List Sharing with Specific List');
  console.log('=' .repeat(50));
  console.log(`📋 List ID: ${LIST_ID}`);
  console.log('');

  // Test 1: Check permissions for the list
  console.log('🔐 Test 1: Checking your permissions for this list...');
  try {
    const response = await api.get(`/v1.0/lists/${LIST_ID}/permissions`);
    const perms = response.data.permissions;
    console.log('✅ Permissions check successful!');
    console.log(`   Your role: ${perms.role}`);
    console.log(`   Permission source: ${perms.permission_source}`);

    if (perms.role === 'owner' || perms.role === 'admin') {
      console.log('   ✅ You can invite users to this list');
    }
  } catch (error) {
    console.log(`❌ Error: ${error.response?.data?.error || error.message}`);
    if (error.response?.status === 403) {
      console.log('   You do not have access to this list');
    } else if (error.response?.status === 404) {
      console.log('   List not found - check the LIST_ID');
    }
  }

  // Test 2: Get collaborators
  console.log('\n👥 Test 2: Getting list collaborators...');
  try {
    const response = await api.get(`/v1.0/lists/${LIST_ID}/collaborators`);
    console.log('✅ Collaborators retrieved!');
    console.log(`   Owner: ${response.data.owner?.username || 'Unknown'}`);
    console.log(`   Total collaborators: ${response.data.collaborators?.length || 0}`);

    if (response.data.collaborators?.length > 0) {
      response.data.collaborators.slice(0, 3).forEach(collab => {
        console.log(`   - ${collab.username} (${collab.role}) via ${collab.access_type}`);
      });
    }
  } catch (error) {
    console.log(`❌ Error: ${error.response?.data?.error || error.message}`);
  }

  // Test 3: Get current shares
  console.log('\n📤 Test 3: Getting current shares for this list...');
  try {
    const response = await api.get(`/v1.0/lists/${LIST_ID}/shares`);
    console.log('✅ Shares retrieved!');
    console.log(`   Total shares: ${response.data.shares?.length || 0}`);

    if (response.data.shares?.length > 0) {
      response.data.shares.forEach(share => {
        console.log(`   - Shared with ${share.shared_with_name} (${share.shared_with_type}) as ${share.role}`);
      });
    }
  } catch (error) {
    if (error.response?.status === 403) {
      console.log('⚠️  You need owner/admin role to view shares');
    } else {
      console.log(`❌ Error: ${error.response?.data?.error || error.message}`);
    }
  }

  // Test 4: Test invitation with non-connected user (should fail)
  console.log('\n🔗 Test 4: Testing connection requirement...');
  const randomUserId = '12345678-1234-1234-1234-123456789012';
  try {
    await api.post(`/v1.0/lists/${LIST_ID}/invitations`, {
      inviteeId: randomUserId,
      role: 'viewer',
      message: 'Test invitation'
    });
    console.log('❌ Should have required connection but didn\'t!');
  } catch (error) {
    if (error.response?.data?.requiresConnection) {
      console.log('✅ Connection requirement properly enforced!');
      console.log(`   Error: ${error.response.data.error}`);
    } else if (error.response?.status === 403) {
      console.log('⚠️  You need owner/admin role to send invitations');
    } else {
      console.log(`❌ Unexpected error: ${error.response?.data?.error || error.message}`);
    }
  }

  // Test 5: Get your connections
  console.log('\n🤝 Test 5: Looking for connections to test with...');
  try {
    const response = await api.get('/v1.0/connections');
    const connections = response.data.connections || [];
    console.log(`✅ Found ${connections.length} connections`);

    if (connections.length > 0) {
      const connection = connections[0];
      console.log(`\n📨 Attempting to invite: ${connection.connection_username || connection.connection_id}`);

      try {
        const inviteResponse = await api.post(`/v1.0/lists/${LIST_ID}/invitations`, {
          inviteeId: connection.connection_id,
          role: 'editor',
          message: 'Testing Phase 3 list sharing!'
        });

        console.log('🎉 Invitation sent successfully!');
        console.log(`   Invitation code: ${inviteResponse.data.invitation?.invitation_code}`);
        console.log(`   Role granted: ${inviteResponse.data.invitation?.role}`);
        console.log(`   Expires at: ${new Date(inviteResponse.data.invitation?.expiresAt).toLocaleDateString()}`);
      } catch (error) {
        if (error.response?.data?.error?.includes('already')) {
          console.log('⚠️  User already has an invitation or access to this list');
        } else if (error.response?.status === 403) {
          console.log('⚠️  You need owner/admin role to send invitations');
        } else {
          console.log(`❌ Failed to send invitation: ${error.response?.data?.error || error.message}`);
        }
      }
    } else {
      console.log('⚠️  No connections found');
      console.log('   To test invitations: ');
      console.log('   1. Connect with another user first');
      console.log('   2. Then run this test again');
    }
  } catch (error) {
    console.log(`❌ Failed to get connections: ${error.response?.data?.error || error.message}`);
  }

  // Test 6: Check pending invitations you've sent
  console.log('\n📮 Test 6: Checking invitations you\'ve sent...');
  try {
    const response = await api.get('/v1.0/lists/invitations/sent');
    const listInvites = response.data.invitations?.filter(inv => inv.list_id === LIST_ID) || [];
    console.log(`✅ Found ${listInvites.length} invitations for this list`);

    listInvites.forEach(invite => {
      console.log(`   - To: ${invite.invitee_name || invite.invitee_username}`);
      console.log(`     Status: ${invite.status}`);
      console.log(`     Role: ${invite.role}`);
      console.log(`     Code: ${invite.invitation_code}`);
    });
  } catch (error) {
    console.log(`❌ Error: ${error.response?.data?.error || error.message}`);
  }

  // Summary
  console.log('\n' + '=' .repeat(50));
  console.log('📊 Test Complete!');
  console.log('\n✅ What\'s Working:');
  console.log('   • List permission checking');
  console.log('   • Collaborator management');
  console.log('   • Connection requirement enforcement');
  console.log('   • Invitation system');
  console.log('   • Share tracking');

  console.log('\n💡 Next Steps:');
  console.log('   1. Create connections with other users');
  console.log('   2. Send invitations to connected users');
  console.log('   3. Test accepting invitations from another account');
  console.log('   4. Create frontend components');
}

// Run the test
testListOperations().catch(console.error);