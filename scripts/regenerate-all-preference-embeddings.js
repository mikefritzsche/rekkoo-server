#!/usr/bin/env node

/**
 * Script to regenerate all preference embeddings
 * Useful when embeddings are corrupted or after algorithm changes
 */

const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config({ path: '../.env' });

const DATABASE_URL = process.env.DATABASE_URL;
const AI_SERVER_URL = process.env.AI_SERVER_URL || 'http://localhost:3002';

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function buildCompositePreferenceText(userId, client) {
  const prefResult = await client.query(
    `SELECT
      up.*,
      us.discovery_mode
    FROM user_preferences up
    LEFT JOIN user_settings us ON us.user_id = up.user_id
    WHERE up.user_id = $1`,
    [userId]
  );

  if (!prefResult.rows.length) {
    return null;
  }

  const prefs = prefResult.rows[0];
  const textParts = [];

  // Add categories
  if (prefs.categories?.length > 0) {
    textParts.push(`Interested in categories: ${prefs.categories.join(', ')}`);
  }

  // Add subcategories
  if (prefs.subcategories?.length > 0) {
    textParts.push(`Specific interests: ${prefs.subcategories.join(', ')}`);
  }

  // Add keywords
  if (prefs.keywords?.length > 0) {
    textParts.push(`Keywords and topics: ${prefs.keywords.join(', ')}`);
  }

  // Add example lists if present
  if (prefs.example_lists?.length > 0) {
    const listTitles = prefs.example_lists.map(l => l.title || l.name).filter(Boolean);
    if (listTitles.length > 0) {
      textParts.push(`Example lists: ${listTitles.join(', ')}`);
    }
  }

  // Add discovery mode context
  if (prefs.discovery_mode) {
    const modeDescriptions = {
      'focused': 'Prefers highly relevant and closely matched suggestions',
      'balanced': 'Open to a mix of relevant and diverse suggestions',
      'explorer': 'Enjoys discovering diverse and unexpected connections'
    };
    if (modeDescriptions[prefs.discovery_mode]) {
      textParts.push(modeDescriptions[prefs.discovery_mode]);
    }
  }

  return textParts.length > 0 ? textParts.join('. ') : null;
}

async function generateEmbedding(text) {
  try {
    const response = await axios.post(`${AI_SERVER_URL}/api/embeddings`, {
      text: text,
      model: 'text-embedding-3-small'
    });
    return response.data.embedding;
  } catch (error) {
    console.error('Error generating embedding:', error.message);
    return null;
  }
}

async function regenerateAllEmbeddings() {
  const client = await pool.connect();

  try {
    console.log('\n🔄 Regenerating All Preference Embeddings\n');
    console.log('===============================================\n');

    // Get all users with preferences
    const usersResult = await client.query(
      `SELECT DISTINCT up.user_id, u.username, u.full_name
      FROM user_preferences up
      JOIN users u ON u.id = up.user_id
      ORDER BY up.updated_at DESC`
    );

    console.log(`Found ${usersResult.rows.length} users with preferences\n`);

    let successCount = 0;
    let failCount = 0;

    for (const user of usersResult.rows) {
      const displayName = user.username || user.full_name || user.user_id.substring(0, 8);
      process.stdout.write(`Processing ${displayName}... `);

      // Build composite text
      const compositeText = await buildCompositePreferenceText(user.user_id, client);

      if (!compositeText) {
        console.log('❌ No preference data');
        failCount++;
        continue;
      }

      // Generate embedding
      const embedding = await generateEmbedding(compositeText);

      if (!embedding) {
        console.log('❌ Failed to generate embedding');
        failCount++;
        continue;
      }

      // Store or update embedding
      await client.query(
        `INSERT INTO embeddings (entity_type, entity_id, embedding, created_at, updated_at)
        VALUES ('user_preferences', $1, $2, NOW(), NOW())
        ON CONFLICT (entity_type, entity_id)
        DO UPDATE SET
          embedding = $2,
          updated_at = NOW()`,
        [user.user_id, JSON.stringify(embedding)]
      );

      console.log('✅ Success');
      successCount++;
    }

    console.log('\n===============================================');
    console.log(`\n📊 Results:`);
    console.log(`  ✅ Successfully regenerated: ${successCount}`);
    console.log(`  ❌ Failed: ${failCount}`);
    console.log(`  📈 Total: ${usersResult.rows.length}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.release();
  }
}

console.log('⚠️  This will regenerate ALL preference embeddings');
console.log('   This may take a while for many users\n');

regenerateAllEmbeddings()
  .then(() => {
    console.log('\n✅ Regeneration complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });