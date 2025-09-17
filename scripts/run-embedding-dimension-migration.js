#!/usr/bin/env node

/**
 * Script to run the embedding dimension migration from 384 to 768
 * This will delete all existing embeddings and update the vector columns
 */

const db = require('../src/config/db');
const { logger } = require('../src/utils/logger');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function runMigration() {
  console.log('=========================================');
  console.log('Embedding Dimension Migration (384 → 768)');
  console.log('=========================================');
  console.log('');
  console.log('⚠️  WARNING: This migration will:');
  console.log('   • Delete ALL existing embeddings');
  console.log('   • Update vector columns from 384 to 768 dimensions');
  console.log('   • Clear the embedding queue');
  console.log('');
  console.log('After this migration, you\'ll need to:');
  console.log('   1. Regenerate all embeddings');
  console.log('   2. Have users regenerate their preference embeddings');
  console.log('');

  // Ask for confirmation
  const answer = await new Promise((resolve) => {
    rl.question('Do you want to continue? (yes/no): ', resolve);
  });

  if (answer.toLowerCase() !== 'yes') {
    console.log('Migration cancelled.');
    rl.close();
    process.exit(0);
  }

  rl.close();

  const client = await db.pool.connect();

  try {
    console.log('');
    console.log('Starting migration...');
    console.log('');

    await client.query('BEGIN');

    // Step 1: Delete existing embeddings
    console.log('Step 1: Deleting existing embeddings...');
    const deleteEmbeddings = await client.query('DELETE FROM embeddings');
    console.log(`  ✓ Deleted ${deleteEmbeddings.rowCount} embeddings`);

    const deleteSearchEmbeddings = await client.query('DELETE FROM search_embeddings');
    console.log(`  ✓ Deleted ${deleteSearchEmbeddings.rowCount} search embeddings`);

    // Step 2: Drop indexes
    console.log('');
    console.log('Step 2: Dropping old indexes...');
    await client.query('DROP INDEX IF EXISTS embeddings_embedding_idx');
    console.log('  ✓ Dropped embeddings_embedding_idx');

    await client.query('DROP INDEX IF EXISTS search_embeddings_embedding_idx');
    console.log('  ✓ Dropped search_embeddings_embedding_idx');

    // Step 3: Alter columns to 768 dimensions
    console.log('');
    console.log('Step 3: Updating vector columns to 768 dimensions...');
    await client.query('ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(768)');
    console.log('  ✓ Updated embeddings table');

    await client.query('ALTER TABLE search_embeddings ALTER COLUMN embedding TYPE vector(768)');
    console.log('  ✓ Updated search_embeddings table');

    // Step 4: Recreate indexes
    console.log('');
    console.log('Step 4: Creating new indexes...');
    await client.query(`
      CREATE INDEX embeddings_embedding_idx
      ON embeddings
      USING hnsw (embedding vector_l2_ops)
    `);
    console.log('  ✓ Created embeddings_embedding_idx');

    await client.query(`
      CREATE INDEX search_embeddings_embedding_idx
      ON search_embeddings
      USING hnsw (embedding vector_l2_ops)
    `);
    console.log('  ✓ Created search_embeddings_embedding_idx');

    // Step 5: Clear embedding queue
    console.log('');
    console.log('Step 5: Resetting embedding queue...');
    const updateQueue = await client.query(`
      UPDATE embedding_queue
      SET status = 'pending',
          retry_count = 0,
          error_message = 'Reset after dimension upgrade'
      WHERE status != 'completed'
    `);
    console.log(`  ✓ Reset ${updateQueue.rowCount} queue items`);

    // Step 6: Add comments
    console.log('');
    console.log('Step 6: Adding documentation...');
    await client.query(`
      COMMENT ON COLUMN embeddings.embedding IS 'Vector embedding with 768 dimensions (upgraded from 384)'
    `);
    await client.query(`
      COMMENT ON COLUMN search_embeddings.embedding IS 'Search query embedding with 768 dimensions (upgraded from 384)'
    `);
    console.log('  ✓ Added column comments');

    // Commit the transaction
    await client.query('COMMIT');

    console.log('');
    console.log('=========================================');
    console.log('✅ Migration completed successfully!');
    console.log('=========================================');
    console.log('');
    console.log('Next steps:');
    console.log('1. The server should auto-restart with nodemon');
    console.log('2. Run: node scripts/generate-preference-embeddings.js');
    console.log('3. Test preference-based suggestions');
    console.log('');

    process.exit(0);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('');
    console.error('❌ Migration failed!');
    console.error('Error:', error.message);
    console.error('');
    console.error('Full error:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

// Run the migration
runMigration().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});