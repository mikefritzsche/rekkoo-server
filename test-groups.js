const db = require('./src/config/db');

async function testGroups() {
  try {
    // 1. Get all groups
    console.log('\n=== All Groups ===');
    const groupsResult = await db.query(`
      SELECT id, name, created_by, created_at, deleted_at
      FROM user_groups
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.log('Groups:', groupsResult.rows);
    
    // 2. Get all group members
    console.log('\n=== All Group Members ===');
    const membersResult = await db.query(`
      SELECT 
        gm.group_id,
        ug.name as group_name,
        gm.user_id,
        u.username,
        gm.role,
        gm.deleted_at
      FROM group_members gm
      JOIN user_groups ug ON gm.group_id = ug.id
      JOIN users u ON gm.user_id = u.id
      ORDER BY gm.joined_at DESC
      LIMIT 20
    `);
    console.log('Members:', membersResult.rows);
    
    // 3. Get all list-group associations
    console.log('\n=== All List-Group Associations ===');
    const listGroupsResult = await db.query(`
      SELECT 
        lgr.list_id,
        l.title as list_title,
        lgr.group_id,
        ug.name as group_name,
        lgr.role,
        lgr.deleted_at
      FROM list_group_roles lgr
      JOIN lists l ON lgr.list_id = l.id
      JOIN user_groups ug ON lgr.group_id = ug.id
      ORDER BY lgr.created_at DESC
      LIMIT 20
    `);
    console.log('List-Group associations:', listGroupsResult.rows);
    
    // 4. Check specific list
    const listId = '66184640-2290-4e78-9cdf-2c2c2343f195';
    console.log(`\n=== Checking specific list ${listId} ===`);
    
    // Check if list is collaborative
    const listCollabResult = await db.query(`
      SELECT id, title, is_collaborative, is_public, owner_id
      FROM lists
      WHERE id = $1
    `, [listId]);
    console.log('List details:', listCollabResult.rows[0]);
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testGroups();