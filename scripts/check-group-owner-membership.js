const db = require('../src/config/db');

async function checkGroupOwnerMembership() {
  try {
    console.log('Checking if group owners are in collaboration_group_members table...\n');

    // Get all groups with their owner membership status
    const result = await db.query(`
      SELECT
        g.id as group_id,
        g.name as group_name,
        g.owner_id,
        u.username as owner_username,
        gm.user_id as member_user_id,
        gm.role as member_role,
        CASE
          WHEN gm.user_id IS NULL THEN 'MISSING'
          ELSE 'EXISTS'
        END as membership_status
      FROM collaboration_groups g
      JOIN users u ON u.id = g.owner_id
      LEFT JOIN collaboration_group_members gm
        ON g.id = gm.group_id
        AND g.owner_id = gm.user_id
      WHERE g.owner_id IS NOT NULL
      ORDER BY g.created_at DESC
    `);

    console.log(`Found ${result.rows.length} groups with owners\n`);

    const missing = result.rows.filter(r => r.membership_status === 'MISSING');
    const exists = result.rows.filter(r => r.membership_status === 'EXISTS');

    console.log(`✓ ${exists.length} groups have owners properly in collaboration_group_members`);
    console.log(`✗ ${missing.length} groups have owners MISSING from collaboration_group_members\n`);

    if (missing.length > 0) {
      console.log('Groups with missing owner membership:');
      missing.forEach(g => {
        console.log(`  - ${g.group_name} (ID: ${g.group_id}, Owner: ${g.owner_username})`);
      });

      console.log('\nWould you like to fix these? Run: npm run fix:group-owners');
    } else {
      console.log('All group owners are properly set up as members!');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error checking group ownership:', error);
    process.exit(1);
  }
}

checkGroupOwnerMembership();