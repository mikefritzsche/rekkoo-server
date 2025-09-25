const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');

async function runMigration(migrationNumber) {
  try {
    const migrationPath = path.join(__dirname, `../sql/migrations/${migrationNumber}_*.sql`);
    const migrationFile = fs.readdirSync(path.dirname(migrationPath))
      .find(file => file.startsWith(`${migrationNumber}_`));

    if (!migrationFile) {
      console.error(`❌ Migration ${migrationNumber} not found`);
      process.exit(1);
    }

    console.log(`🚀 Running migration ${migrationNumber}: ${migrationFile}...`);

    // Read the migration file
    const fullMigrationPath = path.join(__dirname, `../sql/migrations/${migrationFile}`);
    const migrationSQL = fs.readFileSync(fullMigrationPath, 'utf8');

    // Execute the migration
    await db.query(migrationSQL);

    console.log(`✅ Migration ${migrationNumber} completed successfully!`);

  } catch (error) {
    console.error(`❌ Migration ${migrationNumber} failed:`, error.message);
    console.error('Details:', error);
    process.exit(1);
  }
}

async function runMigrations() {
  const migrationNumbers = process.argv.slice(2);

  if (migrationNumbers.length === 0) {
    console.error('Please provide migration numbers to run');
    console.log('Usage: node run-specific-migrations.js 088 089');
    process.exit(1);
  }

  console.log(`Running migrations: ${migrationNumbers.join(', ')}`);

  for (const migrationNumber of migrationNumbers) {
    await runMigration(migrationNumber);
  }

  console.log('✅ All migrations completed!');
  process.exit(0);
}

runMigrations();