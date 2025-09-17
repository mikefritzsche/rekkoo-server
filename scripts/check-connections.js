#!/usr/bin/env node

/**
 * Script to check connection status for a user
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function checkConnections(userId) {
  const client = await pool.connect();

  try {
    console.log('\n🔍 Checking connections for user:', userId);
    console.log('===============================================\n');

    // Check user exists
    const userResult = await client.query(
      'SELECT id, username, full_name FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      console.log('❌ User not found');
      return;
    }

    const user = userResult.rows[0];
    console.log('✅ User:', user.username || user.full_name || user.id);

    // Check mutual connections (both ways)
    const mutualResult = await client.query(
      `SELECT
        c.*,
        u.username,
        u.full_name,
        CASE
          WHEN c.user_id = $1 THEN 'Outgoing'
          ELSE 'Incoming'
        END as direction
      FROM connections c
      JOIN users u ON (
        CASE
          WHEN c.user_id = $1 THEN c.connection_id
          ELSE c.user_id
        END
      ) = u.id
      WHERE (c.user_id = $1 OR c.connection_id = $1)
        AND c.status = 'accepted'
        AND c.connection_type = 'mutual'
      ORDER BY c.accepted_at DESC`,
      [userId]
    );

    console.log('\n📊 Mutual Connections:');
    if (mutualResult.rows.length > 0) {
      console.log(`  Found ${mutualResult.rows.length} mutual connections:`);
      mutualResult.rows.forEach((row, idx) => {
        console.log(`  ${idx + 1}. ${row.username || row.full_name} (${row.direction})`);
        console.log(`     Status: ${row.status}, Type: ${row.connection_type}`);
        console.log(`     Accepted: ${row.accepted_at || 'Not yet'}`);
      });
    } else {
      console.log('  No mutual connections found');
    }

    // Check all connections regardless of type
    const allResult = await client.query(
      `SELECT
        c.*,
        u.username,
        u.full_name
      FROM connections c
      JOIN users u ON c.connection_id = u.id
      WHERE c.user_id = $1
      ORDER BY c.created_at DESC`,
      [userId]
    );

    console.log('\n📋 All Connections (from this user):');
    if (allResult.rows.length > 0) {
      console.log(`  Found ${allResult.rows.length} total connections:`);
      allResult.rows.forEach((row, idx) => {
        console.log(`  ${idx + 1}. ${row.username || row.full_name}`);
        console.log(`     Status: ${row.status}, Type: ${row.connection_type}`);
      });
    } else {
      console.log('  No connections found');
    }

    // Check pending requests
    const pendingResult = await client.query(
      `SELECT
        ci.*,
        u.username as sender_username,
        u.full_name as sender_name
      FROM connection_invitations ci
      JOIN users u ON ci.sender_id = u.id
      WHERE ci.recipient_id = $1
        AND ci.status = 'pending'
      ORDER BY ci.created_at DESC`,
      [userId]
    );

    console.log('\n⏳ Pending Connection Requests:');
    if (pendingResult.rows.length > 0) {
      console.log(`  ${pendingResult.rows.length} pending requests:`);
      pendingResult.rows.forEach((row, idx) => {
        console.log(`  ${idx + 1}. From: ${row.sender_username || row.sender_name}`);
        console.log(`     Created: ${row.created_at}`);
      });
    } else {
      console.log('  No pending requests');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.release();
  }
}

// Get user ID from command line
const userId = process.argv[2];

if (!userId) {
  console.log('Usage: node check-connections.js <user_id>');
  console.log('\nExample: node check-connections.js abc123-def456-...');
  process.exit(1);
}

checkConnections(userId)
  .then(() => {
    console.log('\n✅ Check complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });