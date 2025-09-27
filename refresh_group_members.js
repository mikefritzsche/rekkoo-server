const { Pool } = require('pg');
require('dotenv').config();

// Configure connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  ssl: false,
});

async function refreshGroupMembers() {
  const client = await pool.connect();

  try {
    // Get all active groups with pending connections
    const { rows: groups } = await client.query(`
      SELECT DISTINCT
        g.id as group_id,
        g.name as group_name,
        pgi.invitee_id,
        pgi.inviter_id,
        ci.status as connection_status
      FROM collaboration_groups g
      JOIN pending_group_invitations pgi ON g.id = pgi.group_id
      JOIN connection_invitations ci ON ci.id = pgi.connection_invitation_id
      WHERE g.deleted_at IS NULL
        AND pgi.status = 'waiting'
    `);

    console.log(`Found ${groups.length} groups with pending connections`);

    for (const group of groups) {
      console.log(`\nProcessing group ${group.group_id} (${group.group_name})`);
      console.log(`  Connection status: ${group.connection_status}`);
      console.log(`  Inviter: ${group.inviter_id}`);
      console.log(`  Invitee: ${group.invitee_id}`);

      // Check if connection is actually accepted
      if (group.connection_status === 'accepted') {
        // Check if user is already a member
        const { rows: memberCheck } = await client.query(`
          SELECT 1 FROM collaboration_group_members
          WHERE group_id = $1 AND user_id = $2 AND deleted_at IS NULL
        `, [group.group_id, group.invitee_id]);

        if (memberCheck.length === 0) {
          // Add user to group
          await client.query(`
            INSERT INTO collaboration_group_members (
              group_id, user_id, role, status, joined_at, invited_by
            ) VALUES ($1, $2, 'member', 'active', NOW(), $3)
          `, [group.group_id, group.invitee_id, group.inviter_id]);

          console.log(`  ✓ Added user ${group.invitee_id} to group`);

          // Remove pending invitation
          await client.query(`
            DELETE FROM pending_group_invitations
            WHERE group_id = $1 AND invitee_id = $2
          `, [group.group_id, group.invitee_id]);

          console.log(`  ✓ Removed pending invitation`);
        } else {
          console.log(`  User is already a member`);
        }
      }
    }

    console.log('\nRefresh completed');
  } catch (error) {
    console.error('Error refreshing group members:', error);
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  refreshGroupMembers()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = refreshGroupMembers;