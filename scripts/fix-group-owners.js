const db = require('../src/config/db');

async function fixGroupOwners() {
  try {
    console.log('Fixing missing group owner memberships...\n');

    // Find groups where owner is not in collaboration_group_members
    const missing = await db.query(`
      SELECT
        g.id as group_id,
        g.name as group_name,
        g.owner_id,
        u.username as owner_username
      FROM collaboration_groups g
      JOIN users u ON u.id = g.owner_id
      LEFT JOIN collaboration_group_members gm
        ON g.id = gm.group_id
        AND g.owner_id = gm.user_id
      WHERE g.owner_id IS NOT NULL
        AND gm.user_id IS NULL
    `);

    if (missing.rows.length === 0) {
      console.log('✓ All group owners are already members. Nothing to fix!');
      process.exit(0);
    }

    console.log(`Found ${missing.rows.length} groups with missing owner membership\n`);

    // Fix each missing owner
    for (const group of missing.rows) {
      try {
        await db.query(
          `INSERT INTO collaboration_group_members (group_id, user_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (group_id, user_id) DO UPDATE
           SET role = 'owner'`,
          [group.group_id, group.owner_id]
        );
        console.log(`✓ Fixed: ${group.group_name} - added owner ${group.owner_username} as member`);
      } catch (error) {
        console.error(`✗ Failed to fix ${group.group_name}:`, error.message);
      }
    }

    // Verify the fix
    console.log('\nVerifying fixes...');
    const check = await db.query(`
      SELECT COUNT(*) as remaining
      FROM collaboration_groups g
      LEFT JOIN collaboration_group_members gm
        ON g.id = gm.group_id
        AND g.owner_id = gm.user_id
      WHERE g.owner_id IS NOT NULL
        AND gm.user_id IS NULL
    `);

    if (check.rows[0].remaining === '0') {
      console.log('✓ All group owners are now properly set as members!');
    } else {
      console.log(`⚠ ${check.rows[0].remaining} groups still have missing owner membership`);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error fixing group owners:', error);
    process.exit(1);
  }
}

fixGroupOwners();