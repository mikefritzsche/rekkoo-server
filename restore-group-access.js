const db = require('./src/config/db');

async function restoreGroupAccess() {
  const listId = '66184640-2290-4e78-9cdf-2c2c2343f195';
  const groupId = '981d6a56-62a3-4818-8071-14426a979448';
  
  try {
    console.log('Restoring group access for "First Gift Group" to "Birthday 2025" list...\n');
    
    // Restore the association
    const result = await db.query(`
      UPDATE list_group_roles 
      SET deleted_at = NULL,
          updated_at = NOW()
      WHERE list_id = $1 
        AND group_id = $2
      RETURNING *
    `, [listId, groupId]);
    
    if (result.rows.length > 0) {
      console.log('✅ Successfully restored group access!');
      console.log('Updated record:', result.rows[0]);
      
      // Verify the access now works
      const userId = '9f768190-b865-477d-9fd3-428b28e3ab7d';
      const accessCheck = await db.query(`
        SELECT COUNT(*) as count
        FROM list_group_roles lgr
        JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
        WHERE lgr.list_id = $1
          AND cgm.user_id = $2
          AND lgr.deleted_at IS NULL
      `, [listId, userId]);
      
      console.log(`\n✅ User mf65 now has access: ${accessCheck.rows[0].count > 0 ? 'YES' : 'NO'}`);
    } else {
      console.log('❌ No record found to restore');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

restoreGroupAccess();