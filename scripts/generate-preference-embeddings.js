#!/usr/bin/env node

/**
 * One-time script to generate preference embeddings for existing users
 * Run with: node scripts/generate-preference-embeddings.js
 */

const db = require('../src/config/db');
const { logger } = require('../src/utils/logger');
const preferencesControllerFactory = require('../src/controllers/PreferencesController');

// Create controller instance
const preferencesController = preferencesControllerFactory();

async function generateMissingEmbeddings() {
  try {
    logger.info('Starting preference embedding generation for existing users...');

    // Find users with preferences but no embeddings
    const usersQuery = `
      SELECT DISTINCT up.user_id
      FROM user_preferences up
      LEFT JOIN embeddings e ON e.related_entity_id = up.user_id
        AND e.entity_type = 'user_preferences'
      WHERE e.id IS NULL
        AND up.weight > 0
      ORDER BY up.user_id
    `;

    const { rows: users } = await db.query(usersQuery);
    logger.info(`Found ${users.length} users with preferences but no embeddings`);

    let successCount = 0;
    let errorCount = 0;

    // Process each user
    for (const user of users) {
      try {
        logger.info(`Generating embedding for user ${user.user_id}...`);

        // Use the helper functions from PreferencesController
        // We need to access them directly since they're not exported
        const client = await db.pool.connect();

        try {
          await client.query('BEGIN');

          // Build composite text
          const compositeTextQuery = `
            SELECT
              c.name as category_name,
              c.slug as category_slug,
              s.name as subcategory_name,
              s.slug as subcategory_slug,
              s.keywords,
              s.example_lists,
              up.weight
            FROM user_preferences up
            JOIN preference_subcategories s ON s.id = up.subcategory_id
            JOIN preference_categories c ON c.id = s.category_id
            WHERE up.user_id = $1
              AND up.weight > 0
            ORDER BY up.weight DESC, c.display_order, s.name
          `;

          const { rows: preferences } = await client.query(compositeTextQuery, [user.user_id]);

          if (preferences.length === 0) {
            logger.warn(`No valid preferences for user ${user.user_id}, skipping`);
            continue;
          }

          // Build composite text
          const textParts = [];
          for (const pref of preferences) {
            const categoryText = `${pref.category_name} ${pref.subcategory_name}`;
            textParts.push(categoryText);

            if (pref.keywords && Array.isArray(pref.keywords)) {
              textParts.push(pref.keywords.join(' '));
            }

            if (pref.example_lists && Array.isArray(pref.example_lists)) {
              textParts.push(pref.example_lists.join(' '));
            }

            if (pref.weight > 1.5) {
              textParts.push(categoryText);
            }
          }

          // Get discovery mode
          const { rows: [settings] } = await client.query(
            'SELECT discovery_mode FROM user_discovery_settings WHERE user_id = $1',
            [user.user_id]
          );

          if (settings?.discovery_mode) {
            const modeContext = {
              'focused': 'interested in specific focused content',
              'balanced': 'interested in balanced mix of familiar and new content',
              'explorer': 'interested in exploring diverse new content'
            };
            textParts.push(modeContext[settings.discovery_mode] || '');
          }

          const compositeText = textParts.filter(t => t && t.trim()).join(' ');

          if (!compositeText) {
            logger.warn(`Empty composite text for user ${user.user_id}, skipping`);
            continue;
          }

          // Generate embedding using the embedding service
          const embeddingService = require('../src/services/embeddingService');
          const embedding = await embeddingService.generateEmbedding(compositeText);

          // Store embedding
          await client.query(`
            INSERT INTO embeddings (
              related_entity_id,
              entity_type,
              embedding
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (related_entity_id, entity_type)
            DO UPDATE SET
              embedding = EXCLUDED.embedding,
              updated_at = CURRENT_TIMESTAMP
          `, [
            user.user_id,
            'user_preferences',
            `[${embedding.join(',')}]`
          ]);

          await client.query('COMMIT');

          successCount++;
          logger.info(`✓ Generated embedding for user ${user.user_id} (${successCount}/${users.length})`);

        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        // Small delay to avoid overwhelming the AI server
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        errorCount++;
        logger.error(`✗ Failed to generate embedding for user ${user.user_id}:`, error);
      }
    }

    logger.info(`\n=== Embedding Generation Complete ===`);
    logger.info(`Success: ${successCount}`);
    logger.info(`Errors: ${errorCount}`);
    logger.info(`Total processed: ${users.length}`);

    // Verify the results
    const verifyQuery = `
      SELECT
        COUNT(DISTINCT up.user_id) as users_with_preferences,
        COUNT(DISTINCT e.related_entity_id) as users_with_embeddings
      FROM user_preferences up
      LEFT JOIN embeddings e ON e.related_entity_id = up.user_id
        AND e.entity_type = 'user_preferences'
      WHERE up.weight > 0
    `;

    const { rows: [verify] } = await db.query(verifyQuery);
    logger.info(`\n=== Verification ===`);
    logger.info(`Users with preferences: ${verify.users_with_preferences}`);
    logger.info(`Users with embeddings: ${verify.users_with_embeddings}`);

    process.exit(0);
  } catch (error) {
    logger.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the migration
generateMissingEmbeddings();