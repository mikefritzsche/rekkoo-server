const db = require('./src/config/db');

async function testGroupAccess() {
  const listId = '66184640-2290-4e78-9cdf-2c2c2343f195';
  const userId = '9f768190-b865-477d-9fd3-428b28e3ab7d';
  
  try {
    // 1. Get list info
    console.log('\n=== List Info ===');
    const listResult = await db.query(
      'SELECT id, title, owner_id, is_public FROM lists WHERE id = $1',
      [listId]
    );
    console.log(listResult.rows[0]);
    
    // 2. Get groups with access to this list
    console.log('\n=== Groups with access to this list ===');
    const groupsResult = await db.query(`
      SELECT 
        lgr.group_id,
        ug.name as group_name,
        lgr.role,
        lgr.deleted_at
      FROM list_group_roles lgr
      JOIN user_groups ug ON lgr.group_id = ug.id
      WHERE lgr.list_id = $1
    `, [listId]);
    console.log('Groups:', groupsResult.rows);
    
    // 3. Get user's group memberships
    console.log('\n=== User group memberships ===');
    const membershipResult = await db.query(`
      SELECT 
        gm.group_id,
        ug.name as group_name,
        gm.user_id,
        u.username,
        gm.deleted_at as member_deleted
      FROM group_members gm
      JOIN user_groups ug ON gm.group_id = ug.id
      JOIN users u ON gm.user_id = u.id
      WHERE gm.user_id = $1
    `, [userId]);
    console.log('Memberships:', membershipResult.rows);
    
    // 4. Test the access check query
    console.log('\n=== Access check result ===');
    const accessResult = await db.query(`
      SELECT COUNT(*) as count
      FROM list_group_roles lgr
      JOIN group_members gm ON lgr.group_id = gm.group_id
      WHERE lgr.list_id = $1
        AND gm.user_id = $2
        AND lgr.deleted_at IS NULL
        AND gm.deleted_at IS NULL
    `, [listId, userId]);
    console.log('Has access:', accessResult.rows[0].count > 0);
    
    // 5. Find the intersection
    console.log('\n=== Detailed intersection ===');
    const detailResult = await db.query(`
      SELECT 
        lgr.group_id,
        ug.name as group_name,
        lgr.role as list_role,
        gm.role as member_role,
        lgr.deleted_at as lgr_deleted,
        gm.deleted_at as gm_deleted
      FROM list_group_roles lgr
      JOIN group_members gm ON lgr.group_id = gm.group_id
      JOIN user_groups ug ON lgr.group_id = ug.id
      WHERE lgr.list_id = $1
        AND gm.user_id = $2
    `, [listId, userId]);
    console.log('Intersection:', detailResult.rows);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await db.end();
  }
}

testGroupAccess();