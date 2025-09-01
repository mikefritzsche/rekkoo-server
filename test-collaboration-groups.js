const db = require('./src/config/db');

async function testCollaborationGroups() {
  const listId = '66184640-2290-4e78-9cdf-2c2c2343f195';
  const userId = '9f768190-b865-477d-9fd3-428b28e3ab7d';
  
  try {
    // 1. Get all collaboration groups
    console.log('\n=== All Collaboration Groups ===');
    const groupsResult = await db.query(`
      SELECT id, name, owner_id, created_at, deleted_at
      FROM collaboration_groups
      ORDER BY created_at DESC
      LIMIT 10
    `);
    console.log('Groups:', groupsResult.rows);
    
    // 2. Get all collaboration group members
    console.log('\n=== All Collaboration Group Members ===');
    const membersResult = await db.query(`
      SELECT 
        cgm.group_id,
        cg.name as group_name,
        cgm.user_id,
        u.username,
        cgm.role,
        cgm.joined_at
      FROM collaboration_group_members cgm
      JOIN collaboration_groups cg ON cgm.group_id = cg.id
      JOIN users u ON cgm.user_id = u.id
      ORDER BY cgm.joined_at DESC
      LIMIT 20
    `);
    console.log('Members:', membersResult.rows);
    
    // 3. Get list-group associations
    console.log('\n=== List-Group Associations (list_group_roles) ===');
    const listGroupsResult = await db.query(`
      SELECT 
        lgr.list_id,
        l.title as list_title,
        lgr.group_id,
        cg.name as group_name,
        lgr.role,
        lgr.deleted_at
      FROM list_group_roles lgr
      JOIN lists l ON lgr.list_id = l.id
      LEFT JOIN collaboration_groups cg ON lgr.group_id = cg.id
      ORDER BY lgr.created_at DESC
      LIMIT 20
    `);
    console.log('List-Group associations:', listGroupsResult.rows);
    
    // 4. Test the fixed access check query
    console.log(`\n=== Testing access for user ${userId} to list ${listId} ===`);
    const accessResult = await db.query(`
      SELECT COUNT(*) as count
      FROM list_group_roles lgr
      JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
      WHERE lgr.list_id = $1
        AND cgm.user_id = $2
        AND lgr.deleted_at IS NULL
    `, [listId, userId]);
    console.log('Has access via collaboration groups:', accessResult.rows[0].count > 0);
    
    // 5. Show detailed intersection if any
    if (accessResult.rows[0].count > 0) {
      const detailResult = await db.query(`
        SELECT 
          lgr.group_id,
          cg.name as group_name,
          lgr.role as list_role,
          cgm.role as member_role
        FROM list_group_roles lgr
        JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
        JOIN collaboration_groups cg ON lgr.group_id = cg.id
        WHERE lgr.list_id = $1
          AND cgm.user_id = $2
          AND lgr.deleted_at IS NULL
      `, [listId, userId]);
      console.log('Access details:', detailResult.rows);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testCollaborationGroups();