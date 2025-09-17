#!/usr/bin/env node

/**
 * Check the status of preference embeddings
 */

const db = require('../src/config/db');
const { logger } = require('../src/utils/logger');

async function checkEmbeddingStatus() {
  try {
    console.log('\n=== Preference Embedding Status ===\n');

    // Check overall stats
    const statsQuery = `
      SELECT
        COUNT(DISTINCT up.user_id) as users_with_preferences,
        COUNT(DISTINCT e.related_entity_id) as users_with_embeddings,
        COUNT(DISTINCT up.user_id) - COUNT(DISTINCT e.related_entity_id) as users_missing_embeddings
      FROM user_preferences up
      LEFT JOIN embeddings e ON e.related_entity_id = up.user_id
        AND e.entity_type = 'user_preferences'
      WHERE up.weight > 0
    `;

    const { rows: [stats] } = await db.query(statsQuery);

    console.log(`Users with preferences: ${stats.users_with_preferences}`);
    console.log(`Users with embeddings: ${stats.users_with_embeddings}`);
    console.log(`Users missing embeddings: ${stats.users_missing_embeddings}`);

    // List users missing embeddings
    if (stats.users_missing_embeddings > 0) {
      const missingQuery = `
        SELECT DISTINCT
          up.user_id,
          u.username,
          COUNT(up.subcategory_id) as preference_count
        FROM user_preferences up
        JOIN users u ON u.id = up.user_id
        LEFT JOIN embeddings e ON e.related_entity_id = up.user_id
          AND e.entity_type = 'user_preferences'
        WHERE e.id IS NULL
          AND up.weight > 0
        GROUP BY up.user_id, u.username
        LIMIT 10
      `;

      const { rows: missing } = await db.query(missingQuery);

      console.log('\nFirst 10 users missing embeddings:');
      missing.forEach(user => {
        console.log(`  - User ${user.user_id} (${user.username}): ${user.preference_count} preferences`);
      });
    }

    // Check recent embeddings
    const recentQuery = `
      SELECT
        e.related_entity_id as user_id,
        u.username,
        e.created_at,
        e.updated_at,
        array_length(string_to_array(e.embedding::text, ','), 1) as embedding_dimension
      FROM embeddings e
      JOIN users u ON u.id = e.related_entity_id
      WHERE e.entity_type = 'user_preferences'
      ORDER BY e.updated_at DESC
      LIMIT 5
    `;

    const { rows: recent } = await db.query(recentQuery);

    if (recent.length > 0) {
      console.log('\nMost recent preference embeddings:');
      recent.forEach(emb => {
        console.log(`  - ${emb.username}: Created ${emb.created_at}, Updated ${emb.updated_at}, Dimension: ${emb.embedding_dimension}`);
      });
    }

    // Check embedding types distribution
    const typesQuery = `
      SELECT
        entity_type,
        COUNT(*) as count
      FROM embeddings
      GROUP BY entity_type
      ORDER BY count DESC
    `;

    const { rows: types } = await db.query(typesQuery);

    console.log('\nEmbedding types distribution:');
    types.forEach(type => {
      console.log(`  - ${type.entity_type}: ${type.count}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error checking embedding status:', error);
    process.exit(1);
  }
}

checkEmbeddingStatus();