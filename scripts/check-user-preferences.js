#!/usr/bin/env node

/**
 * Script to check user preferences and embeddings
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function checkUserPreferences(userId) {
  const client = await pool.connect();

  try {
    console.log('\n🔍 Checking preferences for user:', userId);
    console.log('===============================================\n');

    // Check user preferences
    const prefResult = await client.query(
      `SELECT
        up.*,
        us.discovery_mode,
        us.show_in_suggestions
      FROM user_preferences up
      LEFT JOIN user_settings us ON us.user_id = up.user_id
      WHERE up.user_id = $1`,
      [userId]
    );

    if (prefResult.rows.length === 0) {
      console.log('❌ No preferences found for this user');
      return;
    }

    const prefs = prefResult.rows[0];
    console.log('✅ User Preferences Found:');
    console.log('  - Categories:', prefs.categories?.length || 0);
    console.log('  - Subcategories:', prefs.subcategories?.length || 0);
    console.log('  - Keywords:', prefs.keywords?.length || 0);
    console.log('  - Discovery Mode:', prefs.discovery_mode || 'Not set');
    console.log('  - Show in Suggestions:', prefs.show_in_suggestions !== false);
    console.log('  - Last Updated:', prefs.updated_at);

    // Check for embedding
    const embResult = await client.query(
      `SELECT
        id,
        entity_type,
        entity_id,
        vector_dimension(embedding) as dimensions,
        created_at,
        updated_at
      FROM embeddings
      WHERE entity_type = 'user_preferences' AND entity_id = $1`,
      [userId]
    );

    console.log('\n📊 Embedding Status:');
    if (embResult.rows.length > 0) {
      const emb = embResult.rows[0];
      console.log('  ✅ Embedding exists');
      console.log('  - Dimensions:', emb.dimensions);
      console.log('  - Created:', emb.created_at);
      console.log('  - Updated:', emb.updated_at);
    } else {
      console.log('  ❌ No embedding found - preferences need to be saved/updated');
    }

    // Check similarity with other users
    if (embResult.rows.length > 0) {
      const simResult = await client.query(
        `WITH user_embedding AS (
          SELECT embedding
          FROM embeddings
          WHERE entity_type = 'user_preferences' AND entity_id = $1
        )
        SELECT
          e.entity_id as user_id,
          u.username,
          u.full_name,
          1 - (e.embedding <=> ue.embedding) as similarity
        FROM embeddings e
        CROSS JOIN user_embedding ue
        JOIN users u ON u.id = e.entity_id
        WHERE e.entity_type = 'user_preferences'
          AND e.entity_id != $1
        ORDER BY similarity DESC
        LIMIT 5`,
        [userId]
      );

      console.log('\n🤝 Top 5 Most Similar Users:');
      if (simResult.rows.length > 0) {
        simResult.rows.forEach((row, idx) => {
          console.log(`  ${idx + 1}. ${row.username || row.full_name} (${row.user_id.substring(0, 8)}...)`);
          console.log(`     Similarity: ${(row.similarity * 100).toFixed(1)}%`);
        });
      } else {
        console.log('  No other users with embeddings found');
      }
    }

    // Check how many users would appear in "Recommended" (> 0.4 similarity)
    if (embResult.rows.length > 0) {
      const recommendedResult = await client.query(
        `WITH user_embedding AS (
          SELECT embedding
          FROM embeddings
          WHERE entity_type = 'user_preferences' AND entity_id = $1
        )
        SELECT COUNT(*) as count
        FROM embeddings e
        CROSS JOIN user_embedding ue
        WHERE e.entity_type = 'user_preferences'
          AND e.entity_id != $1
          AND (1 - (e.embedding <=> ue.embedding)) > 0.4`,
        [userId]
      );

      console.log('\n📈 Recommendation Stats:');
      console.log(`  - Users with > 40% similarity: ${recommendedResult.rows[0].count}`);
      console.log(`  - These would appear in "Recommended for You" section`);
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.release();
  }
}

// Get user ID from command line
const userId = process.argv[2];

if (!userId) {
  console.log('Usage: node check-user-preferences.js <user_id>');
  console.log('\nExample: node check-user-preferences.js abc123-def456-...');
  process.exit(1);
}

checkUserPreferences(userId)
  .then(() => {
    console.log('\n✅ Check complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });