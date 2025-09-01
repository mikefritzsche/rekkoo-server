const db = require('./src/config/db');

async function testActiveAssociations() {
  const listId = '66184640-2290-4e78-9cdf-2c2c2343f195';
  const userId = '9f768190-b865-477d-9fd3-428b28e3ab7d';
  
  try {
    console.log('\n=== List Details ===');
    const listResult = await db.query(`
      SELECT id, title, owner_id, is_public, is_collaborative
      FROM lists
      WHERE id = $1
    `, [listId]);
    console.log('List:', listResult.rows[0]);
    
    console.log('\n=== ALL List-Group Associations for this list (including deleted) ===');
    const allAssociationsResult = await db.query(`
      SELECT 
        lgr.list_id,
        lgr.group_id,
        cg.name as group_name,
        lgr.role,
        lgr.created_at,
        lgr.updated_at,
        lgr.deleted_at,
        CASE WHEN lgr.deleted_at IS NULL THEN 'ACTIVE' ELSE 'DELETED' END as status
      FROM list_group_roles lgr
      LEFT JOIN collaboration_groups cg ON lgr.group_id = cg.id
      WHERE lgr.list_id = $1
      ORDER BY lgr.created_at DESC
    `, [listId]);
    console.log('All associations:', allAssociationsResult.rows);
    
    console.log('\n=== ACTIVE List-Group Associations for this list ===');
    const activeAssociationsResult = await db.query(`
      SELECT 
        lgr.list_id,
        lgr.group_id,
        cg.name as group_name,
        lgr.role,
        lgr.created_at
      FROM list_group_roles lgr
      LEFT JOIN collaboration_groups cg ON lgr.group_id = cg.id
      WHERE lgr.list_id = $1
        AND lgr.deleted_at IS NULL
    `, [listId]);
    console.log('Active associations:', activeAssociationsResult.rows);
    
    console.log('\n=== User Group Memberships ===');
    const membershipResult = await db.query(`
      SELECT 
        cgm.group_id,
        cg.name as group_name,
        cgm.role,
        cgm.joined_at
      FROM collaboration_group_members cgm
      JOIN collaboration_groups cg ON cgm.group_id = cg.id
      WHERE cgm.user_id = $1
      ORDER BY cgm.joined_at DESC
    `, [userId]);
    console.log('User is member of:', membershipResult.rows);
    
    // Check if any of the user's groups have access to the list
    console.log('\n=== Checking Access ===');
    for (const membership of membershipResult.rows) {
      const accessCheck = await db.query(`
        SELECT COUNT(*) as count
        FROM list_group_roles lgr
        WHERE lgr.list_id = $1
          AND lgr.group_id = $2
          AND lgr.deleted_at IS NULL
      `, [listId, membership.group_id]);
      
      console.log(`Group "${membership.group_name}" (${membership.group_id}): ${
        accessCheck.rows[0].count > 0 ? '✅ HAS ACCESS' : '❌ NO ACCESS'
      }`);
    }
    
    // Try to restore the deleted association if needed
    console.log('\n=== Checking if we need to restore the association ===');
    const deletedAssociation = await db.query(`
      SELECT * FROM list_group_roles
      WHERE list_id = $1
        AND group_id = '981d6a56-62a3-4818-8071-14426a979448'
    `, [listId]);
    
    if (deletedAssociation.rows.length > 0 && deletedAssociation.rows[0].deleted_at) {
      console.log('Found deleted association that needs to be restored:', deletedAssociation.rows[0]);
      console.log('\nTo restore it, run:');
      console.log(`UPDATE list_group_roles SET deleted_at = NULL WHERE list_id = '${listId}' AND group_id = '981d6a56-62a3-4818-8071-14426a979448';`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testActiveAssociations();