const db = require('../config/db');
const { logger } = require('../utils/logger');
const embeddingService = require('../services/embeddingService');

/**
 * Factory function that creates a PreferencesController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with preference management methods
 */
function preferencesControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    notifyUser: () => {} // No-op function
  };

  /**
   * Build a composite text representation of user preferences
   * @param {number} userId - The user ID
   * @param {Object} client - Database client for transactional queries
   * @returns {Promise<string>} Composite preference text
   */
  const buildCompositePreferenceText = async (userId, client = null) => {
    try {
      const dbClient = client || db;

      // Get all user preferences with category and subcategory details
      const preferencesQuery = `
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

      const { rows: preferences } = await dbClient.query(preferencesQuery, [userId]);

      if (preferences.length === 0) {
        return '';
      }

      // Build composite text from preferences
      const textParts = [];

      for (const pref of preferences) {
        // Include category and subcategory names
        const categoryText = `${pref.category_name} ${pref.subcategory_name}`;
        textParts.push(categoryText);

        // Include keywords if available
        if (pref.keywords && Array.isArray(pref.keywords) && pref.keywords.length > 0) {
          textParts.push(pref.keywords.join(' '));
        }

        // Include example lists if available
        if (pref.example_lists && Array.isArray(pref.example_lists) && pref.example_lists.length > 0) {
          textParts.push(pref.example_lists.join(' '));
        }

        // Weight the text by repeating important preferences
        if (pref.weight > 1.5) {
          textParts.push(categoryText); // Add once more for high-weight preferences
        }
      }

      // Get discovery mode to add context
      const settingsQuery = `
        SELECT discovery_mode
        FROM user_discovery_settings
        WHERE user_id = $1
      `;
      const { rows: [settings] } = await dbClient.query(settingsQuery, [userId]);

      if (settings && settings.discovery_mode) {
        const modeContext = {
          'focused': 'interested in specific focused content',
          'balanced': 'interested in balanced mix of familiar and new content',
          'explorer': 'interested in exploring diverse new content'
        };
        textParts.push(modeContext[settings.discovery_mode] || '');
      }

      return textParts.filter(text => text && text.trim()).join(' ');
    } catch (error) {
      logger.error(`Error building composite preference text for user ${userId}:`, error);
      return '';
    }
  };

  /**
   * Generate and store preference embedding for a user
   * @param {number} userId - The user ID
   * @param {Object} client - Database client for transactional queries
   */
  const generatePreferenceEmbedding = async (userId, client = null) => {
    try {
      const dbClient = client || db;

      // Build composite text from preferences
      const compositeText = await buildCompositePreferenceText(userId, dbClient);

      if (!compositeText) {
        logger.info(`No preferences to generate embedding for user ${userId}`);
        return null;
      }

      // Generate embedding
      const embedding = await embeddingService.generateEmbedding(compositeText);

      // Store embedding in embeddings table
      const result = await dbClient.query(`
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
        RETURNING id
      `, [
        userId,
        'user_preferences',
        `[${embedding.join(',')}]`
      ]);

      logger.info(`Generated preference embedding for user ${userId}, embedding ID: ${result.rows[0].id}`);
      return result.rows[0].id;
    } catch (error) {
      logger.error(`Error generating preference embedding for user ${userId}:`, error);
      return null;
    }
  };

  /**
   * Get all preference categories with their subcategories
   */
  const getCategories = async (req, res) => {
    try {
      // First check if image_url column exists (for backward compatibility)
      let hasImageUrl = false;
      try {
        const columnCheckQuery = `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'preference_categories'
          AND column_name = 'image_url'
          AND table_schema = 'public'
        `;
        const { rows: columnCheck } = await db.query(columnCheckQuery);
        hasImageUrl = columnCheck.length > 0;
      } catch (checkErr) {
        // If check fails, assume column doesn't exist
        logger.warn('Could not check for image_url column:', checkErr.message);
      }

      // Build query based on whether image_url column exists
      const categoriesQuery = hasImageUrl ? `
        SELECT
          c.id,
          c.name,
          c.slug,
          c.icon,
          c.color,
          c.image_url,
          c.display_order,
          COALESCE(
            json_agg(
              json_build_object(
                'id', s.id,
                'name', s.name,
                'slug', s.slug,
                'keywords', s.keywords,
                'popularity_score', s.popularity_score,
                'example_lists', s.example_lists
              ) ORDER BY s.name
            ) FILTER (WHERE s.id IS NOT NULL),
            '[]'::json
          ) as subcategories
        FROM preference_categories c
        LEFT JOIN preference_subcategories s ON s.category_id = c.id AND s.is_active = true
        WHERE c.is_active = true
        GROUP BY c.id, c.name, c.slug, c.icon, c.color, c.image_url, c.display_order
        ORDER BY c.display_order, c.name
      ` : `
        SELECT
          c.id,
          c.name,
          c.slug,
          c.icon,
          c.color,
          NULL as image_url,
          c.display_order,
          COALESCE(
            json_agg(
              json_build_object(
                'id', s.id,
                'name', s.name,
                'slug', s.slug,
                'keywords', s.keywords,
                'popularity_score', s.popularity_score,
                'example_lists', s.example_lists
              ) ORDER BY s.name
            ) FILTER (WHERE s.id IS NOT NULL),
            '[]'::json
          ) as subcategories
        FROM preference_categories c
        LEFT JOIN preference_subcategories s ON s.category_id = c.id AND s.is_active = true
        WHERE c.is_active = true
        GROUP BY c.id, c.name, c.slug, c.icon, c.color, c.display_order
        ORDER BY c.display_order, c.name
      `;

      const { rows } = await db.query(categoriesQuery);

      res.json({
        success: true,
        categories: rows
      });
    } catch (err) {
      logger.error('Error fetching preference categories:', err);
      res.status(500).json({ error: 'Failed to fetch preference categories' });
    }
  };

  /**
   * Get user's current preferences
   */
  const getUserPreferences = async (req, res) => {
    try {
      const userId = req.user.id;

      const preferencesQuery = `
        SELECT
          up.subcategory_id,
          up.weight,
          up.source,
          s.name as subcategory_name,
          s.slug as subcategory_slug,
          c.id as category_id,
          c.name as category_name,
          c.slug as category_slug,
          c.icon as category_icon,
          c.color as category_color
        FROM user_preferences up
        JOIN preference_subcategories s ON s.id = up.subcategory_id
        JOIN preference_categories c ON c.id = s.category_id
        WHERE up.user_id = $1
        ORDER BY c.display_order, s.name
      `;

      const { rows: preferences } = await db.query(preferencesQuery, [userId]);

      // Get discovery settings
      const settingsQuery = `
        SELECT
          discovery_mode,
          onboarding_completed,
          onboarding_completed_at,
          preferences_set_count
        FROM user_discovery_settings
        WHERE user_id = $1
      `;

      const { rows: [settings] } = await db.query(settingsQuery, [userId]);

      res.json({
        success: true,
        preferences,
        discoverySettings: settings || {
          discovery_mode: 'balanced',
          onboarding_completed: false,
          preferences_set_count: 0
        }
      });
    } catch (err) {
      logger.error('Error fetching user preferences:', err);
      res.status(500).json({ error: 'Failed to fetch user preferences' });
    }
  };

  /**
   * Save user preferences (for onboarding or updates)
   */
  const saveUserPreferences = async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const userId = req.user.id;
      const {
        preferences = [], // Array of { subcategoryId, weight }
        discoveryMode = 'balanced',
        source = 'manual' // 'onboarding', 'manual', 'inferred', 'behavior'
      } = req.body;

      if (!Array.isArray(preferences)) {
        return res.status(400).json({ error: 'Preferences must be an array' });
      }

      // Clear existing preferences if this is onboarding
      if (source === 'onboarding') {
        await client.query(
          'DELETE FROM user_preferences WHERE user_id = $1 AND source = $2',
          [userId, 'onboarding']
        );
      }

      // Insert new preferences
      for (const pref of preferences) {
        if (!pref.subcategoryId) continue;

        const weight = pref.weight || 1.0;

        await client.query(`
          INSERT INTO user_preferences (user_id, subcategory_id, weight, source)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, subcategory_id)
          DO UPDATE SET
            weight = EXCLUDED.weight,
            source = EXCLUDED.source,
            updated_at = CURRENT_TIMESTAMP
        `, [userId, pref.subcategoryId, weight, source]);

        // Update popularity score
        await client.query(`
          UPDATE preference_subcategories
          SET popularity_score = popularity_score + 1
          WHERE id = $1
        `, [pref.subcategoryId]);
      }

      // Update or create discovery settings
      const onboardingCompleted = source === 'onboarding';
      await client.query(`
        INSERT INTO user_discovery_settings (
          user_id,
          discovery_mode,
          onboarding_completed,
          onboarding_completed_at,
          preferences_set_count,
          last_preference_update
        )
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id)
        DO UPDATE SET
          discovery_mode = EXCLUDED.discovery_mode,
          onboarding_completed = CASE
            WHEN $3 THEN true
            ELSE user_discovery_settings.onboarding_completed
          END,
          onboarding_completed_at = CASE
            WHEN $3 AND user_discovery_settings.onboarding_completed_at IS NULL
            THEN EXCLUDED.onboarding_completed_at
            ELSE user_discovery_settings.onboarding_completed_at
          END,
          preferences_set_count = EXCLUDED.preferences_set_count,
          last_preference_update = EXCLUDED.last_preference_update,
          updated_at = CURRENT_TIMESTAMP
      `, [userId, discoveryMode, onboardingCompleted, onboardingCompleted ? new Date() : null, preferences.length]);

      // Check if preferences_onboarded column exists before updating
      let hasPreferencesOnboarded = false;
      try {
        const columnCheckQuery = `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'user_settings'
          AND column_name = 'preferences_onboarded'
          AND table_schema = 'public'
        `;
        const { rows: columnCheck } = await client.query(columnCheckQuery);
        hasPreferencesOnboarded = columnCheck.length > 0;
      } catch (checkErr) {
        logger.warn('Could not check for preferences_onboarded column:', checkErr.message);
      }

      // Update user_settings if onboarding completed and column exists
      if (onboardingCompleted && hasPreferencesOnboarded) {
        await client.query(`
          UPDATE user_settings
          SET
            preferences_onboarded = true,
            preferences_onboarded_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1
        `, [userId]);
      }

      // Generate preference embedding after saving preferences
      const embeddingId = await generatePreferenceEmbedding(userId, client);

      await client.query('COMMIT');

      // Emit socket event for real-time updates
      safeSocketService.notifyUser(userId, 'preferencesUpdated', {
        preferences,
        discoveryMode,
        source
      });

      res.json({
        success: true,
        message: source === 'onboarding' ? 'Preferences saved successfully' : 'Preferences updated',
        preferencesCount: preferences.length,
        embeddingGenerated: embeddingId !== null
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Error saving user preferences:', err);
      res.status(500).json({ error: 'Failed to save preferences' });
    } finally {
      client.release();
    }
  };

  /**
   * Update a single preference
   */
  const updatePreference = async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const userId = req.user.id;
      const { subcategoryId } = req.params;
      const { weight = 1.0, action = 'update' } = req.body;

      if (action === 'remove') {
        // Track removal in history
        await client.query(`
          INSERT INTO user_preference_history (user_id, subcategory_id, action, old_weight, reason)
          SELECT user_id, subcategory_id, 'removed', weight, 'User removed preference'
          FROM user_preferences
          WHERE user_id = $1 AND subcategory_id = $2
        `, [userId, subcategoryId]);

        // Delete the preference
        await client.query(
          'DELETE FROM user_preferences WHERE user_id = $1 AND subcategory_id = $2',
          [userId, subcategoryId]
        );
      } else {
        // Track update in history
        await client.query(`
          INSERT INTO user_preference_history (user_id, subcategory_id, action, old_weight, new_weight, reason)
          SELECT user_id, subcategory_id,
            CASE WHEN EXISTS (SELECT 1 FROM user_preferences WHERE user_id = $1 AND subcategory_id = $2)
              THEN 'weight_' || CASE WHEN weight < $3 THEN 'increased' ELSE 'decreased' END
              ELSE 'added'
            END,
            weight, $3, 'User manual update'
          FROM user_preferences
          WHERE user_id = $1 AND subcategory_id = $2
        `, [userId, subcategoryId, weight]);

        // Update or insert preference
        await client.query(`
          INSERT INTO user_preferences (user_id, subcategory_id, weight, source)
          VALUES ($1, $2, $3, 'manual')
          ON CONFLICT (user_id, subcategory_id)
          DO UPDATE SET
            weight = EXCLUDED.weight,
            source = 'manual',
            updated_at = CURRENT_TIMESTAMP
        `, [userId, subcategoryId, weight]);
      }

      // Update last preference update time
      await client.query(`
        UPDATE user_discovery_settings
        SET last_preference_update = CURRENT_TIMESTAMP
        WHERE user_id = $1
      `, [userId]);

      // Regenerate preference embedding after updating individual preference
      const embeddingId = await generatePreferenceEmbedding(userId, client);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: action === 'remove' ? 'Preference removed' : 'Preference updated',
        embeddingRegenerated: embeddingId !== null
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Error updating preference:', err);
      res.status(500).json({ error: 'Failed to update preference' });
    } finally {
      client.release();
    }
  };

  /**
   * Update discovery mode
   */
  const updateDiscoveryMode = async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const userId = req.user.id;
      const { discoveryMode } = req.body;

      if (!['focused', 'balanced', 'explorer'].includes(discoveryMode)) {
        return res.status(400).json({ error: 'Invalid discovery mode' });
      }

      await client.query(`
        INSERT INTO user_discovery_settings (user_id, discovery_mode)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET
          discovery_mode = EXCLUDED.discovery_mode,
          updated_at = CURRENT_TIMESTAMP
      `, [userId, discoveryMode]);

      // Regenerate preference embedding when discovery mode changes
      // since discovery mode is included in the composite text
      const embeddingId = await generatePreferenceEmbedding(userId, client);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Discovery mode updated',
        discoveryMode,
        embeddingRegenerated: embeddingId !== null
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Error updating discovery mode:', err);
      res.status(500).json({ error: 'Failed to update discovery mode' });
    } finally {
      client.release();
    }
  };

  /**
   * Regenerate preference embedding for the current user
   * Useful for users who saved preferences before embeddings were implemented
   */
  const regeneratePreferenceEmbedding = async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const userId = req.user.id;

      // Check if user has preferences
      const { rows: preferences } = await client.query(
        'SELECT COUNT(*) as count FROM user_preferences WHERE user_id = $1 AND weight > 0',
        [userId]
      );

      if (parseInt(preferences[0].count) === 0) {
        return res.status(400).json({
          success: false,
          error: 'No preferences found to generate embedding from'
        });
      }

      // Generate the embedding
      const embeddingId = await generatePreferenceEmbedding(userId, client);

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Preference embedding regenerated successfully',
        embeddingId,
        hasEmbedding: embeddingId !== null
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Error regenerating preference embedding:', err);
      res.status(500).json({ error: 'Failed to regenerate preference embedding' });
    } finally {
      client.release();
    }
  };

  /**
   * Check if user has completed preference onboarding
   */
  const checkOnboardingStatus = async (req, res) => {
    try {
      const userId = req.user.id;

      // First check if preferences_onboarded column exists
      let hasPreferencesOnboarded = false;
      try {
        const columnCheckQuery = `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'user_settings'
          AND column_name = 'preferences_onboarded'
          AND table_schema = 'public'
        `;
        const { rows: columnCheck } = await db.query(columnCheckQuery);
        hasPreferencesOnboarded = columnCheck.length > 0;
      } catch (checkErr) {
        logger.warn('Could not check for preferences_onboarded column:', checkErr.message);
      }

      // Build query based on whether column exists
      const statusQuery = hasPreferencesOnboarded ? `
        SELECT
          COALESCE(ds.onboarding_completed, false) as onboarding_completed,
          ds.onboarding_completed_at,
          ds.preferences_set_count,
          COALESCE(us.preferences_onboarded, false) as preferences_onboarded
        FROM users u
        LEFT JOIN user_discovery_settings ds ON ds.user_id = u.id
        LEFT JOIN user_settings us ON us.user_id = u.id
        WHERE u.id = $1
      ` : `
        SELECT
          COALESCE(ds.onboarding_completed, false) as onboarding_completed,
          ds.onboarding_completed_at,
          ds.preferences_set_count,
          false as preferences_onboarded
        FROM users u
        LEFT JOIN user_discovery_settings ds ON ds.user_id = u.id
        WHERE u.id = $1
      `;

      const { rows: [status] } = await db.query(statusQuery, [userId]);

      res.json({
        success: true,
        onboardingCompleted: status?.onboarding_completed || false,
        onboardingCompletedAt: status?.onboarding_completed_at,
        preferencesSetCount: status?.preferences_set_count || 0,
        preferencesOnboarded: status?.preferences_onboarded || false
      });
    } catch (err) {
      logger.error('Error checking onboarding status:', err);
      res.status(500).json({ error: 'Failed to check onboarding status' });
    }
  };

  return {
    getCategories,
    getUserPreferences,
    saveUserPreferences,
    updatePreference,
    updateDiscoveryMode,
    checkOnboardingStatus,
    regeneratePreferenceEmbedding
  };
}

module.exports = preferencesControllerFactory;