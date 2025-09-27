const { Pool } = require('pg');
require('dotenv').config({ path: '.env.development' });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function cleanupInvitations() {
  try {
    console.log('Cleaning up duplicate connection invitations...\n');

    // First, let's check all invitations between the users
    const userA = '1bcd0366-498a-4d6e-82a6-e880e47c808f'; // mike
    const userB = '0320693e-043b-4750-92b4-742e298a5f7f'; // demo_user1

    // Delete all connection invitations between these users
    const deleteResult = await pool.query(
      `DELETE FROM connection_invitations
       WHERE (sender_id = $1 AND recipient_id = $2)
       OR (sender_id = $2 AND recipient_id = $1)
       RETURNING id`,
      [userA, userB]
    );

    console.log(`Deleted ${deleteResult.rowCount} connection invitations`);

    // Also check and clean up any connection request history
    const historyResult = await pool.query(
      `DELETE FROM connection_request_history
       WHERE (sender_id = $1 AND recipient_id = $2)
       OR (sender_id = $2 AND recipient_id = $1)
       RETURNING id`,
      [userA, userB]
    );

    console.log(`Deleted ${historyResult.rowCount} connection request history records`);

    // Also check for any pending group invitations
    const groupResult = await pool.query(
      `DELETE FROM pending_group_invitations
       WHERE (inviter_id = $1 AND invitee_id = $2)
       OR (inviter_id = $2 AND invitee_id = $1)
       RETURNING id`,
      [userA, userB]
    );

    console.log(`Deleted ${groupResult.rowCount} pending group invitations`);

    // And regular group invitations
    const regularGroupResult = await pool.query(
      `DELETE FROM group_invitations
       WHERE (inviter_id = $1 AND invitee_id = $2)
       OR (inviter_id = $2 AND invitee_id = $1)
       RETURNING id`,
      [userA, userB]
    );

    console.log(`Deleted ${regularGroupResult.rowCount} group invitations`);

    console.log('\n=== Cleanup completed ===\n');

  } catch (error) {
    console.error('Error cleaning up:', error);
  } finally {
    await pool.end();
  }
}

cleanupInvitations();