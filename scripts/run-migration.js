const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

async function runMigration() {
  try {
    console.log('🚀 Running unified change log migration...');
    
    // Read the migration file
    const migrationPath = path.join(__dirname, '../sql/migrations/011_create_unified_change_log.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the migration
    await db.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    console.log('📊 Change log table and triggers are now active');
    
    // Verify the table was created
    const result = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = 'change_log'
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ change_log table verified');
    } else {
      console.log('❌ change_log table not found');
    }
    
    // Check triggers
    const triggers = await db.query(`
      SELECT trigger_name, event_object_table 
      FROM information_schema.triggers 
      WHERE trigger_name = 'sync_log_trigger'
    `);
    
    console.log(`✅ Found ${triggers.rows.length} sync triggers on tables:`, 
      triggers.rows.map(t => t.event_object_table).join(', '));
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error('Details:', error);
  } finally {
    process.exit(0);
  }
}

runMigration(); 