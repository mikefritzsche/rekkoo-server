#!/usr/bin/env node

/**
 * Check the current embedding dimensions in the database
 */

const db = require('../src/config/db');

async function checkDimensions() {
  try {
    console.log('\n=== Checking Embedding Dimensions ===\n');

    // Check embeddings table
    const embeddingsInfo = await db.query(`
      SELECT
        column_name,
        data_type,
        udt_name,
        character_maximum_length,
        numeric_precision,
        col_description(pgc.oid, pa.attnum) as comment
      FROM information_schema.columns
      JOIN pg_class pgc ON pgc.relname = 'embeddings'
      JOIN pg_attribute pa ON pa.attrelid = pgc.oid AND pa.attname = 'embedding'
      WHERE table_name = 'embeddings'
        AND column_name = 'embedding'
    `);

    if (embeddingsInfo.rows.length > 0) {
      console.log('Embeddings table:');
      console.log('  Column type:', embeddingsInfo.rows[0].udt_name);
      console.log('  Comment:', embeddingsInfo.rows[0].comment || 'No comment');
    }

    // Try to get actual dimension from pg_type
    const dimensionQuery = await db.query(`
      SELECT
        typname,
        typlen,
        typmod
      FROM pg_type pt
      JOIN pg_attribute pa ON pa.atttypid = pt.oid
      JOIN pg_class pc ON pc.oid = pa.attrelid
      WHERE pc.relname = 'embeddings'
        AND pa.attname = 'embedding'
        AND pt.typname = 'vector'
    `);

    if (dimensionQuery.rows.length > 0) {
      const typmod = dimensionQuery.rows[0].typmod;
      // In pgvector, typmod stores the dimension
      const dimension = typmod > 0 ? typmod : 'variable';
      console.log('  Dimension:', dimension);
    }

    // Check if there are any embeddings
    const countQuery = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN entity_type = 'user_preferences' THEN 1 END) as preference_embeddings
      FROM embeddings
    `);

    console.log('\nCurrent embeddings:');
    console.log('  Total:', countQuery.rows[0].total);
    console.log('  Preference embeddings:', countQuery.rows[0].preference_embeddings);

    // Try to get a sample embedding to see its actual dimension
    const sampleQuery = await db.query(`
      SELECT
        id,
        entity_type,
        array_length(string_to_array(embedding::text, ','), 1) as actual_dimension
      FROM embeddings
      LIMIT 1
    `);

    if (sampleQuery.rows.length > 0) {
      console.log('\nSample embedding:');
      console.log('  Entity type:', sampleQuery.rows[0].entity_type);
      console.log('  Actual dimension:', sampleQuery.rows[0].actual_dimension);
    }

    // Check search_embeddings table
    const searchCountQuery = await db.query('SELECT COUNT(*) as total FROM search_embeddings');
    console.log('\nSearch embeddings:');
    console.log('  Total:', searchCountQuery.rows[0].total);

    process.exit(0);
  } catch (error) {
    console.error('Error checking dimensions:', error.message);
    process.exit(1);
  }
}

checkDimensions();