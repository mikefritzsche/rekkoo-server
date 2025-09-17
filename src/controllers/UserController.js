const db = require('../config/db');
const bcrypt = require("bcrypt");
const saltRounds = 12;
const { logger } = require('../utils/logger');
const embeddingService = require('../services/embeddingService');

/**
 * Factory function that creates a UserController
 * @param {Object} socketService - Optional socket service for real-time updates
 * @returns {Object} Controller object with user management methods
 */
function userControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    emitToUser: () => {} // No-op function
  };

  /**
   * Get a list of users with pagination
   */
  const getUsers = async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;

      const { rows, rowCount } = await db.query(
        'SELECT id, username, email, full_name, email_verified FROM users ORDER BY id LIMIT $1 OFFSET $2',
        [limit, offset]
      );

      // Get total count for pagination
      const totalCount = parseInt((await db.query('SELECT COUNT(*) FROM users')).rows[0].count);

      res.json({
        users: rows,
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit),
          totalItems: totalCount,
          itemsPerPage: limit
        }
      });
    } catch (err) {
      console.error('Error fetching users:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * Get a user by ID - respects ghost mode privacy
   */
  const getUserById = async (req, res) => {
    try {
      const { id } = req.params;
      const requesterId = req.user?.id; // May be undefined for public access

      // First check if the viewer can see this user (ghost mode check)
      const privacyCheck = await db.query(
        `SELECT
          us.privacy_settings->>'privacy_mode' as privacy_mode,
          u.id,
          u.deleted_at
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id = $1`,
        [id]
      );

      if (privacyCheck.rows.length === 0 || privacyCheck.rows[0].deleted_at) {
        return res.status(404).json({ error: 'User not found' });
      }

      const privacy_mode = privacyCheck.rows[0].privacy_mode || 'private';

      // Check if users are connected (for ghost/private mode checks)
      let canViewFullProfile = false;
      if (requesterId) {
        if (requesterId === id) {
          canViewFullProfile = true; // Users can always see their own profile
        } else if (privacy_mode === 'ghost' || privacy_mode === 'private') {
          // Check connection status
          const connectionCheck = await db.query(
            `SELECT EXISTS (
              SELECT 1 FROM connections c1
              WHERE c1.user_id = $1 AND c1.connection_id = $2
                AND c1.status = 'accepted'
                AND EXISTS (
                  SELECT 1 FROM connections c2
                  WHERE c2.user_id = $2 AND c2.connection_id = $1
                    AND c2.status = 'accepted'
                )
            ) as are_connected`,
            [requesterId, id]
          );
          canViewFullProfile = connectionCheck.rows[0].are_connected;
        } else {
          canViewFullProfile = true; // Standard/public users are viewable
        }
      }

      // Ghost users are completely invisible except to connections
      if (privacy_mode === 'ghost' && !canViewFullProfile) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Fetch user data with privacy-aware fields
      const { rows } = await db.query(
        `SELECT
          u.id,
          CASE
            WHEN $2 = 'ghost' AND NOT $3 THEN 'Hidden User'
            ELSE u.username
          END as username,
          CASE
            WHEN $2 IN ('ghost', 'private') AND NOT $3 THEN NULL
            ELSE u.email
          END as email,
          CASE
            WHEN $2 IN ('ghost', 'private') AND NOT $3 THEN NULL
            ELSE u.full_name
          END as full_name,
          u.email_verified,
          CASE
            WHEN $2 = 'ghost' AND NOT $3 THEN NULL
            ELSE u.profile_image_url
          END as profile_image_url,
          u.created_at,
          u.updated_at,
          -- Include user_settings fields for profile header (only if viewable)
          CASE
            WHEN $2 = 'ghost' AND NOT $3 THEN NULL
            ELSE us.lists_header_background_type
          END as lists_header_background_type,
          CASE
            WHEN $2 = 'ghost' AND NOT $3 THEN NULL
            ELSE us.lists_header_background_value
          END as lists_header_background_value,
          CASE
            WHEN $2 = 'ghost' AND NOT $3 THEN NULL
            ELSE us.lists_header_image_url
          END as lists_header_image_url,
          -- Map lists_header_image_url to profile_header_image_url for client compatibility
          CASE
            WHEN $2 = 'ghost' AND NOT $3 THEN NULL
            ELSE us.lists_header_image_url
          END as profile_header_image_url,
          -- Include privacy mode for frontend handling
          $2 as privacy_mode,
          $3 as is_connected
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id = $1`,
        [id, privacy_mode, canViewFullProfile]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Commented out verbose logging to reduce server spam
      // logger.info(`[UserController] getUserById returning user data:`, {
      //   id: rows[0].id,
      //   username: rows[0].username,
      //   profile_image_url: rows[0].profile_image_url,
      //   profile_header_image_url: rows[0].profile_header_image_url,
      //   lists_header_background_type: rows[0].lists_header_background_type,
      //   lists_header_background_value: rows[0].lists_header_background_value,
      //   lists_header_image_url: rows[0].lists_header_image_url
      // });

      res.json(rows[0]);
    } catch (err) {
      console.error('Error fetching user:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * Create a new user
   */
  const createUser = async (req, res) => {
    const { username, email, password, full_name, email_verified } = req.body;
    const password_hash = await bcrypt.hash(password, saltRounds);
    console.log('create user: ', { username, email, password, password_hash, full_name, email_verified });
    
    try {
      const result = await db.query(
        'INSERT INTO users (username, email, password_hash, full_name, email_verified) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [username, email, password_hash, full_name, email_verified]
      );
      
      // Add sync tracking
      // Sync tracking is now handled automatically by database triggers
      
      // Emit real-time update if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function') {
        // You can emit to admin users or other interested parties
        // This is just a placeholder for potential future use
      }
      
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * Delete a user by ID
   */
  const deleteUser = async (req, res) => {
    try {
      const { id } = req.params;

      const result = await db.query(
        'DELETE FROM users WHERE id = $1 RETURNING username, id',
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Sync tracking is now handled automatically by database triggers

      // Emit real-time update if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function') {
        // You can emit to admin users or other interested parties
        // This is just a placeholder for potential future use
      }

      res.json({
        message: `User ${result.rows[0].username} successfully deleted`,
        deleted: true
      });
    } catch (err) {
      console.error('Error deleting user:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * Delete multiple users
   */
  const deleteMultipleUsers = async (req, res) => {
    const { ids } = req.body; // Expect array of IDs

    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Please provide an array of user IDs' });
      }

      const result = await db.query(
        'DELETE FROM users WHERE id = ANY($1) RETURNING id, username',
        [ids]
      );

      // Sync tracking is now handled automatically by database triggers

      // Emit real-time update if socket service is available
      if (safeSocketService && typeof safeSocketService.emitToUser === 'function') {
        // You can emit to admin users or other interested parties
        // This is just a placeholder for potential future use
      }

      res.json({
        message: `Successfully deleted ${result.rowCount} users`,
        deletedUsers: result.rows
      });
    } catch (err) {
      console.error('Error deleting users:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  // Get users who follow a specific user
  const getUserFollowers = async (req, res) => {
    const { userId } = req.params; // The ID of the user whose followers we want to get
    // const requestingUserId = req.user?.id; // ID of the user making the request, for permission checks if needed

    // logger.info(`[UserController] Request to get followers for user ${userId}`);

    try {
      // Query to get users who are following 'userId'
      // We select details of the follower from the 'users' table
      const query = `
        SELECT u.id, u.username, u.profile_image_url, u.full_name 
        FROM users u
        JOIN followers f ON u.id = f.follower_id
        WHERE f.followed_id = $1 AND f.deleted_at IS NULL
        ORDER BY f.created_at DESC;
      `;
      const { rows } = await db.query(query, [userId]);
      res.status(200).json(rows);
    } catch (error) {
      logger.error(`[UserController] Error getting followers for user ${userId}:`, error);
      res.status(500).json({ error: 'Failed to get followers', details: error.message });
    }
  };

  // Get users whom a specific user is following
  const getUserFollowing = async (req, res) => {
    const { userId } = req.params; // The ID of the user whose followed list we want to get
    // const requestingUserId = req.user?.id; // ID of the user making the request

    // logger.info(`[UserController] Request to get users followed by user ${userId}`);

    try {
      // Query to get users whom 'userId' is following
      // We select details of the followed user from the 'users' table
      const query = `
        SELECT u.id, u.username, u.profile_image_url, u.full_name
        FROM users u
        JOIN followers f ON u.id = f.followed_id
        WHERE f.follower_id = $1 AND f.deleted_at IS NULL
        ORDER BY f.created_at DESC;
      `;
      const { rows } = await db.query(query, [userId]);
      res.status(200).json(rows);
    } catch (error) {
      logger.error(`[UserController] Error getting users followed by ${userId}:`, error);
      res.status(500).json({ error: 'Failed to get followed users', details: error.message });
    }
  };

  // Get public lists of a specific user - respects privacy settings and connection status
  const getUserPublicLists = async (req, res) => {
    const { targetUserId } = req.params; // The ID of the user whose public lists we want to get
    const requestingUserId = req.user?.id; // ID of the user making the request

    // logger.info(`[UserController] Request to get public lists for user ${targetUserId} from ${requestingUserId || 'anonymous'}`);

    try {
      // First check the target user's privacy settings
      const privacyCheck = await db.query(
        `SELECT us.privacy_settings->>'privacy_mode' as privacy_mode,
                u.id, u.username
         FROM users u
         LEFT JOIN user_settings us ON u.id = us.user_id
         WHERE u.id = $1`,
        [targetUserId]
      );

      if (privacyCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const targetUser = privacyCheck.rows[0];
      const privacyMode = targetUser.privacy_mode || 'private'; // Default to private if not set

      // Check if users are connected (if needed)
      let areConnected = false;
      if (requestingUserId && requestingUserId !== targetUserId) {
        const connectionCheck = await db.query(
          `SELECT EXISTS (
            SELECT 1 FROM connections c1
            WHERE c1.user_id = $1 AND c1.connection_id = $2
              AND c1.status = 'accepted'
              AND EXISTS (
                SELECT 1 FROM connections c2
                WHERE c2.user_id = $2 AND c2.connection_id = $1
                  AND c2.status = 'accepted'
              )
          ) as are_connected`,
          [requestingUserId, targetUserId]
        );
        areConnected = connectionCheck.rows[0].are_connected;
      }

      // Determine what lists to show based on privacy mode
      let query;
      let queryParams;

      if (requestingUserId === targetUserId) {
        // User viewing their own lists - show all
        query = `
          SELECT l.id, l.title, l.description, l.created_at, l.updated_at, l.is_public, l.owner_id,
                 l.background, l.image_url, l.list_type, l.occasion, l.sort_order,
                 (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
                 u.username as owner_username, u.profile_image_url as owner_profile_picture_url
          FROM lists l
          JOIN users u ON l.owner_id = u.id
          WHERE l.owner_id = $1 AND l.deleted_at IS NULL
          ORDER BY l.updated_at DESC;
        `;
        queryParams = [targetUserId];
      } else if (privacyMode === 'private' && !areConnected) {
        // Private mode and not connected - no lists visible
        // logger.info(`[UserController] User ${targetUserId} is private and not connected to ${requestingUserId}`);
        return res.status(200).json([]);
      } else if (privacyMode === 'standard' && !areConnected) {
        // Standard mode and not connected - only show explicitly public lists
        query = `
          SELECT l.id, l.title, l.description, l.created_at, l.updated_at, l.is_public, l.owner_id,
                 l.background, l.image_url, l.list_type, l.occasion, l.sort_order,
                 (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
                 u.username as owner_username, u.profile_image_url as owner_profile_picture_url
          FROM lists l
          JOIN users u ON l.owner_id = u.id
          WHERE l.owner_id = $1 AND l.is_public = TRUE AND l.deleted_at IS NULL
          ORDER BY l.updated_at DESC;
        `;
        queryParams = [targetUserId];
      } else if (privacyMode === 'public' || areConnected) {
        // Public mode OR connected users - show all public lists
        query = `
          SELECT l.id, l.title, l.description, l.created_at, l.updated_at, l.is_public, l.owner_id,
                 l.background, l.image_url, l.list_type, l.occasion, l.sort_order,
                 (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
                 u.username as owner_username, u.profile_image_url as owner_profile_picture_url
          FROM lists l
          JOIN users u ON l.owner_id = u.id
          WHERE l.owner_id = $1 AND l.is_public = TRUE AND l.deleted_at IS NULL
          ORDER BY l.updated_at DESC;
        `;
        queryParams = [targetUserId];
      } else {
        // Default case - only public lists
        query = `
          SELECT l.id, l.title, l.description, l.created_at, l.updated_at, l.is_public, l.owner_id,
                 l.background, l.image_url, l.list_type, l.occasion, l.sort_order,
                 (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
                 u.username as owner_username, u.profile_image_url as owner_profile_picture_url
          FROM lists l
          JOIN users u ON l.owner_id = u.id
          WHERE l.owner_id = $1 AND l.is_public = TRUE AND l.deleted_at IS NULL
          ORDER BY l.updated_at DESC;
        `;
        queryParams = [targetUserId];
      }

      const { rows } = await db.query(query, queryParams);
      res.status(200).json(rows);
    } catch (error) {
      logger.error(`[UserController] Error getting public lists for user ${targetUserId}:`, error);
      res.status(500).json({ error: 'Failed to get public lists', details: error.message });
    }
  };

  // Get all lists for a user (with proper privacy values for access control)
  /**
   * Get lists for a user with LIVE access checks (no caching, always fresh)
   * This endpoint is specifically designed for viewing other users' lists
   * and ensures real-time group membership verification
   */
  const getUserListsLive = async (req, res) => {
    const { targetUserId } = req.params;
    const viewingUserId = req.query.viewerId || req.user?.id;
    
    // logger.info(`[UserController] LIVE access check for user ${targetUserId}, viewer ${viewingUserId || 'anonymous'}`);
    
    // Validate that this is for viewing another user's lists
    if (!viewingUserId || viewingUserId === targetUserId) {
      return res.status(400).json({ 
        error: 'This endpoint is for viewing other users\' lists only. Use /lists-with-access for own lists.' 
      });
    }
    
    try {
      // Convert usernames to IDs if needed
      let actualTargetUserId = targetUserId;
      let actualViewingUserId = viewingUserId;
      
      if (!targetUserId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const result = await db.query('SELECT id FROM users WHERE username = $1', [targetUserId]);
        if (result.rows.length > 0) {
          actualTargetUserId = result.rows[0].id;
        }
      }
      
      if (!viewingUserId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const result = await db.query('SELECT id FROM users WHERE username = $1', [viewingUserId]);
        if (result.rows.length > 0) {
          actualViewingUserId = result.rows[0].id;
        }
      }
      
      // Real-time query with explicit group membership verification
      const query = `
        WITH viewer_active_groups AS (
          -- Only get ACTIVE group memberships (non-deleted groups)
          SELECT DISTINCT cgm.group_id, cg.name as group_name
          FROM collaboration_group_members cgm
          INNER JOIN collaboration_groups cg ON cgm.group_id = cg.id
          WHERE cgm.user_id = $2 
            AND cgm.deleted_at IS NULL
            AND cg.deleted_at IS NULL
        ),
        list_permissions AS (
          SELECT 
            l.id,
            l.title,
            l.description,
            l.is_public,
            l.owner_id,
            l.background,
            l.image_url,
            l.list_type,
            l.occasion,
            l.sort_order,
            l.created_at,
            l.updated_at,
            -- Determine access type
            CASE 
              WHEN l.is_public = true THEN 'public'
              WHEN lgr.id IS NOT NULL THEN 'group_member'
              WHEN ls.id IS NOT NULL THEN 'group_shared'
              WHEN luo.id IS NOT NULL THEN 'individual_override'
              ELSE 'no_access'
            END as access_type,
            COALESCE(vag.group_name, vag2.group_name) as access_group_name
          FROM lists l
          LEFT JOIN list_group_roles lgr ON l.id = lgr.list_id 
            AND lgr.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM viewer_active_groups vag WHERE vag.group_id = lgr.group_id)
          LEFT JOIN viewer_active_groups vag ON lgr.group_id = vag.group_id
          LEFT JOIN list_sharing ls ON l.id = ls.list_id 
            AND ls.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM viewer_active_groups vag2 WHERE vag2.group_id = ls.shared_with_group_id)
          LEFT JOIN viewer_active_groups vag2 ON ls.shared_with_group_id = vag2.group_id
          LEFT JOIN list_user_overrides luo ON l.id = luo.list_id 
            AND luo.user_id = $2 
            AND luo.deleted_at IS NULL 
            AND luo.role != 'blocked'
            AND luo.role != 'inherit'
          WHERE l.owner_id = $1 
            AND l.deleted_at IS NULL
        )
        SELECT 
          lp.*,
          (SELECT COUNT(*) FROM list_items li WHERE li.list_id = lp.id AND li.deleted_at IS NULL) as item_count,
          u.username as owner_username,
          u.profile_image_url as owner_profile_picture_url
        FROM list_permissions lp
        JOIN users u ON lp.owner_id = u.id
        WHERE lp.access_type != 'no_access'
        ORDER BY lp.updated_at DESC;
      `;
      
      const { rows } = await db.query(query, [actualTargetUserId, actualViewingUserId]);
      
      // Debug: Check for individual shares specifically
      const individualSharesQuery = `
        SELECT luo.*, l.title, l.is_public
        FROM list_user_overrides luo
        JOIN lists l ON l.id = luo.list_id
        WHERE l.owner_id = $1 
          AND luo.user_id = $2
          AND luo.deleted_at IS NULL
          AND luo.role != 'blocked'
          AND luo.role != 'inherit'
          AND l.deleted_at IS NULL
      `;
      const { rows: individualShares } = await db.query(individualSharesQuery, [actualTargetUserId, actualViewingUserId]);
      
      // Debug: Check specifically why individual shares might not be showing
      if (individualShares.length > 0 && rows.length === 0) {
        logger.warn(`[UserController] WARNING: Found ${individualShares.length} individual shares but main query returned 0 lists!`);
        
        // Run a diagnostic query to understand the issue
        const diagnosticQuery = `
          SELECT 
            l.id,
            l.title,
            l.is_public,
            l.owner_id,
            luo.id as override_id,
            luo.role as override_role,
            luo.user_id as override_user,
            luo.deleted_at as override_deleted,
            CASE 
              WHEN luo.id IS NOT NULL AND luo.role != 'blocked' AND luo.role != 'inherit' THEN 'should_have_access'
              ELSE 'no_access'
            END as diagnostic_result
          FROM lists l
          LEFT JOIN list_user_overrides luo ON l.id = luo.list_id 
            AND luo.user_id = $2 
            AND luo.deleted_at IS NULL
          WHERE l.owner_id = $1 
            AND l.deleted_at IS NULL
            AND l.id IN (SELECT list_id FROM list_user_overrides WHERE user_id = $2 AND deleted_at IS NULL)
        `;
        const { rows: diagnosticRows } = await db.query(diagnosticQuery, [actualTargetUserId, actualViewingUserId]);
        logger.info(`[UserController] Diagnostic query results for individual shares:`);
        diagnosticRows.forEach(row => {
          logger.info(`  - List: "${row.title}" (${row.id})`);
          logger.info(`    Override: ID=${row.override_id}, Role=${row.override_role}, User=${row.override_user}`);
          logger.info(`    Result: ${row.diagnostic_result}`);
        });
      }
      
      // logger.info(`[UserController] LIVE check returned ${rows.length} lists`);
      // logger.info(`[UserController] Individual shares check found ${individualShares.length} direct shares`);
      
      // Log individual shares in detail
      if (individualShares.length > 0) {
        logger.info(`[UserController] Individual shares details:`);
        individualShares.forEach(share => {
          logger.info(`  - List: "${share.title}" (ID: ${share.list_id})`);
          logger.info(`    Role: ${share.role}, Deleted: ${share.deleted_at}, Public: ${share.is_public}`);
          // Check if this list appears in the main results
          const inMainResults = rows.find(r => r.id === share.list_id);
          if (inMainResults) {
            logger.info(`    ✓ INCLUDED in main results with access_type: ${inMainResults.access_type}`);
          } else {
            logger.info(`    ✗ MISSING from main results!`);
          }
        });
      }
      
      // Log all lists with their access types
      // logger.info(`[UserController] All returned lists with access types:`);
      rows.forEach(row => {
        logger.info(`  - "${row.title}" (${row.id}): ${row.access_type}${row.is_public ? ' [PUBLIC]' : ' [PRIVATE]'}`);
      });
      
      res.status(200).json({
        lists: rows,
        metadata: {
          viewer_id: actualViewingUserId,
          target_user_id: actualTargetUserId,
          timestamp: new Date().toISOString(),
          is_live: true
        }
      });
      
    } catch (error) {
      logger.error('[UserController] Error in getUserListsLive:', error);
      res.status(500).json({ error: 'Failed to fetch lists with live access check' });
    }
  };
  
  const getUserListsWithAccess = async (req, res) => {
    const { targetUserId } = req.params;
    // Accept both viewerId and viewingUserId for backward compatibility
    const viewingUserId = req.query.viewerId || req.query.viewingUserId || req.user?.id; // Use query param or authenticated user
    
    // Reduced verbose logging
    // logger.info(`[UserController] Getting lists with access for user ${targetUserId}, viewed by ${viewingUserId || 'anonymous'}`);
    // logger.info(`[UserController] Query params:`, req.query);
    // logger.info(`[UserController] Authenticated user:`, req.user?.id);
    
    // Declare these outside try block so they're accessible in catch
    let actualTargetUserId = targetUserId;
    let actualViewingUserId = viewingUserId;
    
    try {
      // Check if targetUserId is a username (not a UUID)
      if (targetUserId && !targetUserId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const targetUserQuery = await db.query('SELECT id FROM users WHERE username = $1', [targetUserId]);
        if (targetUserQuery.rows.length > 0) {
          actualTargetUserId = targetUserQuery.rows[0].id;
          // logger.info(`[UserController] Converted target username ${targetUserId} to ID ${actualTargetUserId}`);
        }
      }
      
      // Check if viewingUserId is a username (not a UUID)
      if (viewingUserId && !viewingUserId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const viewingUserQuery = await db.query('SELECT id FROM users WHERE username = $1', [viewingUserId]);
        if (viewingUserQuery.rows.length > 0) {
          actualViewingUserId = viewingUserQuery.rows[0].id;
          // logger.info(`[UserController] Converted viewing username ${viewingUserId} to ID ${actualViewingUserId}`);
        } else {
          logger.warn(`[UserController] Could not find user with username ${viewingUserId}`);
        }
      }
      
      // logger.info(`[UserController] Final IDs - Target: ${actualTargetUserId}, Viewer: ${actualViewingUserId}`);
      
      // If viewing own lists, return all owned lists AND lists shared with them
      if (actualViewingUserId === actualTargetUserId) {
        const query = `
          WITH viewer_groups AS (
            -- Get all groups the user is a member of
            SELECT DISTINCT cgm.group_id, cg.name as group_name
            FROM collaboration_group_members cgm
            JOIN collaboration_groups cg ON cgm.group_id = cg.id
            WHERE cgm.user_id = $1 
              AND cgm.deleted_at IS NULL
              AND cg.deleted_at IS NULL
            UNION
            -- Include groups the user owns
            SELECT DISTINCT cg.id as group_id, cg.name as group_name
            FROM collaboration_groups cg
            WHERE cg.owner_id = $1 
              AND cg.deleted_at IS NULL
          )
          SELECT DISTINCT
            l.id, 
            l.title, 
            l.description, 
            l.created_at, 
            l.updated_at, 
            l.is_public,
            l.is_collaborative,
            l.owner_id,
            l.background, 
            l.image_url, 
            l.list_type, 
            l.occasion, 
            l.sort_order,
            (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
            u.username as owner_username, 
            u.profile_image_url as owner_profile_picture_url,
            -- Mark if this is a shared list (not owned by viewer)
            CASE 
              WHEN l.owner_id = $1 THEN false
              ELSE true
            END as shared_with_me,
            -- Determine share type for shared lists
            CASE 
              WHEN l.owner_id = $1 THEN null
              WHEN EXISTS (
                SELECT 1 FROM list_group_roles lgr
                JOIN viewer_groups vg ON lgr.group_id = vg.group_id
                WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL
              ) OR EXISTS (
                SELECT 1 FROM list_sharing ls
                JOIN viewer_groups vg ON ls.shared_with_group_id = vg.group_id
                WHERE ls.list_id = l.id AND ls.deleted_at IS NULL
              ) THEN 'group_shared'
              WHEN EXISTS (
                SELECT 1 FROM list_user_overrides luo
                WHERE luo.list_id = l.id 
                  AND luo.user_id = $1 
                  AND luo.role NOT IN ('blocked', 'inherit')
                  AND luo.deleted_at IS NULL
              ) THEN 'individual_shared'
              ELSE null
            END as share_type,
            -- Get the group that provides access (if any)
            COALESCE(
              (SELECT vg.group_name FROM list_group_roles lgr
               JOIN viewer_groups vg ON lgr.group_id = vg.group_id
               WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL
               LIMIT 1),
              (SELECT vg.group_name FROM list_sharing ls
               JOIN viewer_groups vg ON ls.shared_with_group_id = vg.group_id
               WHERE ls.list_id = l.id AND ls.deleted_at IS NULL
               LIMIT 1)
            ) as access_via_group,
            -- Add sort order expression for ORDER BY clause
            CASE WHEN l.owner_id = $1 THEN 0 ELSE 1 END as sort_priority
          FROM lists l
          JOIN users u ON l.owner_id = u.id
          WHERE l.deleted_at IS NULL
            AND (
              -- Lists owned by the user
              l.owner_id = $1
              OR
              -- Lists shared with user through groups (list_group_roles)
              EXISTS (
                SELECT 1 FROM list_group_roles lgr
                JOIN viewer_groups vg ON lgr.group_id = vg.group_id
                WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL
              )
              OR
              -- Lists shared with user through groups (list_sharing - legacy)
              EXISTS (
                SELECT 1 FROM list_sharing ls
                JOIN viewer_groups vg ON ls.shared_with_group_id = vg.group_id
                WHERE ls.list_id = l.id AND ls.deleted_at IS NULL
              )
              OR
              -- Lists shared with user individually
              EXISTS (
                SELECT 1 FROM list_user_overrides luo
                WHERE luo.list_id = l.id 
                  AND luo.user_id = $1 
                  AND luo.role NOT IN ('blocked', 'inherit')
                  AND luo.deleted_at IS NULL
              )
            )
          ORDER BY 
            -- Show owned lists first, then shared lists
            sort_priority,
            l.updated_at DESC;
        `;
        
        const { rows } = await db.query(query, [actualTargetUserId]);
        
        // Log the breakdown
        const ownedLists = rows.filter(r => !r.shared_with_me);
        const sharedLists = rows.filter(r => r.shared_with_me);
        const groupShared = sharedLists.filter(r => r.share_type === 'group_shared');
        const individualShared = sharedLists.filter(r => r.share_type === 'individual_shared');
        
        logger.info(`[UserController] Returning ${rows.length} total lists for user ${actualTargetUserId}:`);
        logger.info(`  - ${ownedLists.length} owned lists`);
        logger.info(`  - ${sharedLists.length} shared lists (${groupShared.length} via groups, ${individualShared.length} individual)`);
        
        return res.status(200).json(rows);
      }
      
      // Debug: Check viewer's groups
      if (actualViewingUserId) {
        const groupCheckQuery = `
          SELECT DISTINCT group_id 
          FROM collaboration_group_members 
          WHERE user_id = $1
          UNION
          SELECT id as group_id 
          FROM collaboration_groups 
          WHERE owner_id = $1 AND deleted_at IS NULL
        `;
        const { rows: groupRows } = await db.query(groupCheckQuery, [actualViewingUserId]);
        logger.info(`[UserController] Viewer ${actualViewingUserId} is in ${groupRows.length} groups:`, groupRows.map(r => r.group_id));
        
        // First check what ALL lists have groups attached (to debug)
        const allListGroupsQuery = `
          SELECT DISTINCT list_id, COUNT(*) as group_count
          FROM list_group_roles
          WHERE deleted_at IS NULL
          GROUP BY list_id
        `;
        const { rows: allListGroups } = await db.query(allListGroupsQuery);
        logger.info(`[UserController] Lists with groups in list_group_roles:`, allListGroups);
        
        // Check Birthday 2025 list groups in multiple tables
        const birthdayGroupsQuery = `
          SELECT lgr.group_id, lgr.role, 'list_group_roles' as source
          FROM list_group_roles lgr
          WHERE lgr.list_id = '66184640-2290-4e78-9cdf-2c2c2343f195' 
            AND lgr.deleted_at IS NULL
        `;
        const { rows: birthdayGroups } = await db.query(birthdayGroupsQuery);
        logger.info(`[UserController] Birthday 2025 list has ${birthdayGroups.length} groups in list_group_roles:`, birthdayGroups);
        
        // Also check list_sharing table (legacy)
        const listSharingQuery = `
          SELECT shared_with_group_id as group_id, 'list_sharing' as source
          FROM list_sharing
          WHERE list_id = '66184640-2290-4e78-9cdf-2c2c2343f195' 
            AND shared_with_group_id IS NOT NULL
            AND deleted_at IS NULL
        `;
        const { rows: sharingGroups } = await db.query(listSharingQuery);
        logger.info(`[UserController] Birthday 2025 list has ${sharingGroups.length} groups in list_sharing:`, sharingGroups);
        
        // Check ALL entries (including deleted) for debugging
        const allGroupRolesQuery = `
          SELECT list_id, group_id, role, deleted_at
          FROM list_group_roles
          WHERE list_id = '66184640-2290-4e78-9cdf-2c2c2343f195'
        `;
        const { rows: allGroupRoles } = await db.query(allGroupRolesQuery);
        logger.info(`[UserController] ALL entries for Birthday 2025 in list_group_roles (including deleted):`, allGroupRoles);
        
        // Combine groups from both tables
        const allBirthdayGroups = [...birthdayGroups, ...sharingGroups];
        
        // Check if there's overlap
        const viewerGroupIds = groupRows.map(r => r.group_id);
        const birthdayGroupIds = allBirthdayGroups.map(r => r.group_id);
        const hasOverlap = birthdayGroupIds.some(g => viewerGroupIds.includes(g));
        logger.info(`[UserController] Combined: Birthday 2025 has ${birthdayGroupIds.length} total groups`);
        logger.info(`[UserController] Does viewer have access to Birthday 2025? ${hasOverlap ? 'YES' : 'NO'}`);
      }
      
      // For other viewers, filter based on privacy and group access
      let query;
      if (!actualViewingUserId) {
        // Anonymous users only see public lists
        query = `
          SELECT DISTINCT
            l.id, 
            l.title, 
            l.description, 
            l.created_at, 
            l.updated_at, 
            l.is_public,
            l.owner_id,
            l.background, 
            l.image_url, 
            l.list_type, 
            l.occasion, 
            l.sort_order,
            (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
            u.username as owner_username, 
            u.profile_image_url as owner_profile_picture_url
          FROM lists l
          JOIN users u ON l.owner_id = u.id
          WHERE 
            l.owner_id = $1 
            AND l.deleted_at IS NULL
            AND l.is_public = true
          ORDER BY l.updated_at DESC;
        `;
      } else {
        // Logged in users see public lists and private lists they have access to
        // FIXED: Proper group membership verification with access reason tracking
        query = `
          WITH viewer_groups AS (
            -- Get all groups the viewer is a member of (must be active member)
            SELECT DISTINCT cgm.group_id, cg.name as group_name
            FROM collaboration_group_members cgm
            JOIN collaboration_groups cg ON cgm.group_id = cg.id
            WHERE cgm.user_id = $2 
              AND cgm.deleted_at IS NULL
              AND cg.deleted_at IS NULL
            UNION
            -- Include groups the viewer owns
            SELECT DISTINCT cg.id as group_id, cg.name as group_name
            FROM collaboration_groups cg
            WHERE cg.owner_id = $2 
              AND cg.deleted_at IS NULL
          ),
          list_access AS (
            SELECT 
              l.*,
              CASE 
                WHEN l.is_public = true THEN 'public'
                WHEN EXISTS (
                  SELECT 1 FROM list_group_roles lgr
                  JOIN viewer_groups vg ON lgr.group_id = vg.group_id
                  WHERE lgr.list_id = l.id 
                    AND lgr.deleted_at IS NULL
                ) THEN 'group_access_via_list_group_roles'
                WHEN EXISTS (
                  SELECT 1 FROM list_sharing ls
                  JOIN viewer_groups vg ON ls.shared_with_group_id = vg.group_id
                  WHERE ls.list_id = l.id 
                    AND ls.deleted_at IS NULL
                ) THEN 'group_access_via_list_sharing'
                WHEN EXISTS (
                  SELECT 1 FROM list_user_overrides luo
                  WHERE luo.list_id = l.id 
                    AND luo.user_id = $2 
                    AND luo.role != 'blocked'
                    AND luo.role != 'inherit'
                    AND luo.deleted_at IS NULL
                ) THEN 'individual_access'
                ELSE 'no_access'
              END as access_reason,
              -- Get the group that provides access (if any)
              COALESCE(
                (SELECT vg.group_name FROM list_group_roles lgr
                 JOIN viewer_groups vg ON lgr.group_id = vg.group_id
                 WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL
                 LIMIT 1),
                (SELECT vg.group_name FROM list_sharing ls
                 JOIN viewer_groups vg ON ls.shared_with_group_id = vg.group_id
                 WHERE ls.list_id = l.id AND ls.deleted_at IS NULL
                 LIMIT 1)
              ) as access_via_group
            FROM lists l
            WHERE l.owner_id = $1 
              AND l.deleted_at IS NULL
          )
          SELECT DISTINCT
            la.id, 
            la.title, 
            la.description, 
            la.created_at, 
            la.updated_at, 
            la.is_public,
            la.owner_id,
            la.background, 
            la.image_url, 
            la.list_type, 
            la.occasion, 
            la.sort_order,
            la.access_reason,
            la.access_via_group,
            (SELECT COUNT(*) FROM list_items li WHERE li.list_id = la.id AND li.deleted_at IS NULL) as item_count,
            u.username as owner_username, 
            u.profile_image_url as owner_profile_picture_url
          FROM list_access la
          JOIN users u ON la.owner_id = u.id
          WHERE la.access_reason != 'no_access'
          ORDER BY la.updated_at DESC;
        `;
      }
      
      // Debug: Before executing main query, check individual shares directly
      if (actualViewingUserId && actualViewingUserId !== actualTargetUserId) {
        const directShareCheck = `
          SELECT 
            luo.list_id,
            luo.user_id,
            luo.role,
            luo.deleted_at,
            l.title,
            l.is_public,
            l.owner_id
          FROM list_user_overrides luo
          JOIN lists l ON l.id = luo.list_id
          WHERE l.owner_id = $1 
            AND luo.user_id = $2
            AND l.deleted_at IS NULL
          ORDER BY luo.role
        `;
        const { rows: directShares } = await db.query(directShareCheck, [actualTargetUserId, actualViewingUserId]);
        
        logger.info(`[UserController] Direct share check for viewer ${actualViewingUserId} on owner ${actualTargetUserId}'s lists:`);
        logger.info(`[UserController] Found ${directShares.length} total override entries`);
        directShares.forEach(share => {
          logger.info(`  - List: "${share.title}" (${share.list_id})`);
          logger.info(`    Role: ${share.role}, Deleted: ${share.deleted_at}, Public: ${share.is_public}`);
          logger.info(`    Should be included: ${share.role !== 'blocked' && share.role !== 'inherit' && !share.deleted_at ? 'YES' : 'NO'}`);
        });
        
        // Test the EXISTS clause directly for each individual share
        const validShares = directShares.filter(s => s.role !== 'blocked' && s.role !== 'inherit' && !s.deleted_at);
        if (validShares.length > 0) {
          logger.info(`[UserController] Testing EXISTS clause for ${validShares.length} valid shares:`);
          for (const share of validShares) {
            const existsTest = `
              SELECT EXISTS (
                SELECT 1 FROM list_user_overrides luo
                WHERE luo.list_id = $1 
                  AND luo.user_id = $2 
                  AND luo.role != 'blocked'
                  AND luo.role != 'inherit'
                  AND luo.deleted_at IS NULL
              ) as should_exist
            `;
            const { rows: existsResult } = await db.query(existsTest, [share.list_id, actualViewingUserId]);
            logger.info(`    List "${share.title}": EXISTS clause returns ${existsResult[0].should_exist}`);
          }
        }
      }
      
      // Execute query with appropriate parameters
      const queryParams = actualViewingUserId 
        ? [actualTargetUserId, actualViewingUserId]
        : [actualTargetUserId];
      
      const { rows } = await db.query(query, queryParams);
      
      logger.info(`[UserController] Main query returned ${rows.length} accessible lists for viewer ${actualViewingUserId || 'anonymous'}`);
      
      // Check if individually shared lists made it to the results
      if (actualViewingUserId && actualViewingUserId !== actualTargetUserId) {
        const directShareCheck = `
          SELECT luo.list_id
          FROM list_user_overrides luo
          JOIN lists l ON l.id = luo.list_id
          WHERE l.owner_id = $1 
            AND luo.user_id = $2
            AND luo.role != 'blocked'
            AND luo.role != 'inherit'
            AND luo.deleted_at IS NULL
            AND l.deleted_at IS NULL
        `;
        const { rows: expectedShares } = await db.query(directShareCheck, [actualTargetUserId, actualViewingUserId]);
        
        if (expectedShares.length > 0) {
          logger.info(`[UserController] Checking if ${expectedShares.length} individual shares are in results:`);
          expectedShares.forEach(share => {
            const inResults = rows.find(r => r.id === share.list_id);
            if (inResults) {
              logger.info(`  ✓ List ${share.list_id} IS in results with access_reason: ${inResults.access_reason}`);
            } else {
              logger.error(`  ✗ List ${share.list_id} MISSING from results!`);
            }
          });
        }
      }
      
      // Log privacy distribution and access reasons for debugging
      const publicCount = rows.filter(l => l.is_public === true).length;
      const privateCount = rows.filter(l => l.is_public === false).length;
      logger.info(`[UserController] Privacy distribution: ${publicCount} public, ${privateCount} private with access`);
      
      // Log access reasons for private lists
      if (actualViewingUserId) {
        const privateLists = rows.filter(l => l.is_public === false);
        if (privateLists.length > 0) {
          logger.info(`[UserController] Private list access reasons for viewer ${actualViewingUserId}:`);
          privateLists.forEach(list => {
            logger.info(`  - "${list.title}": ${list.access_reason}${list.access_via_group ? ` (via group: ${list.access_via_group})` : ''}`);
          });
        }
      }
      
      // Log list IDs for debugging
      logger.info(`[UserController] List IDs returned:`, rows.map(l => ({ id: l.id, title: l.title, is_public: l.is_public })));
      
      // Debug: Check Birthday 2025 list specifically
      const birthdayList = rows.find(l => l.id === '66184640-2290-4e78-9cdf-2c2c2343f195');
      if (!birthdayList && actualViewingUserId) {
        // Check why Birthday 2025 is not included
        const debugQuery = `
          SELECT 
            l.id,
            l.title,
            l.is_public,
            (SELECT COUNT(*) FROM list_group_roles lgr WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL) as group_count,
            (SELECT array_agg(lgr.group_id) FROM list_group_roles lgr WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL) as list_groups,
            (SELECT array_agg(vg.group_id) FROM collaboration_group_members vg WHERE vg.user_id = $1) as viewer_groups
          FROM lists l
          WHERE l.id = '66184640-2290-4e78-9cdf-2c2c2343f195' AND l.deleted_at IS NULL;
        `;
        const { rows: debugRows } = await db.query(debugQuery, [actualViewingUserId]);
        if (debugRows.length > 0) {
          logger.info(`[UserController] DEBUG - Birthday 2025 list not included for viewer ${actualViewingUserId}:`, {
            list: debugRows[0].title,
            is_public: debugRows[0].is_public,
            list_has_groups: debugRows[0].group_count > 0,
            list_groups: debugRows[0].list_groups,
            viewer_groups: debugRows[0].viewer_groups,
            has_overlap: debugRows[0].list_groups && debugRows[0].viewer_groups && 
                        debugRows[0].list_groups.some(g => debugRows[0].viewer_groups.includes(g))
          });
        }
      } else if (birthdayList) {
        logger.info(`[UserController] Birthday 2025 list IS included for viewer ${actualViewingUserId}`);
      }
      
      res.status(200).json(rows);
    } catch (error) {
      logger.error(`[UserController] Error getting lists with access for user ${actualTargetUserId}:`, error);
      res.status(500).json({ error: 'Failed to get user lists', details: error.message });
    }
  };

  // Get user suggestions - excludes ghost and private users unless connected
  const getUserSuggestions = async (req, res) => {
    const requestingUserId = req.user?.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    logger.info(`[UserController] getUserSuggestions - Request from user ${requestingUserId}, page ${page}, limit ${limit}`);

    try {
      // Get users that are active and not in ghost mode (unless connected)
      // Don't require email verification or user_settings to exist
      const query = `
        WITH active_follows AS (
          SELECT followed_id
          FROM followers
          WHERE follower_id = $1
            AND deleted_at IS NULL  -- Only consider active follows
        ),
        connected_users AS (
          SELECT c1.connection_id as user_id
          FROM connections c1
          WHERE c1.user_id = $1
            AND c1.status = 'accepted'
            AND EXISTS (
              SELECT 1 FROM connections c2
              WHERE c2.user_id = c1.connection_id
                AND c2.connection_id = $1
                AND c2.status = 'accepted'
            )
        )
        SELECT DISTINCT ON (u.id)
          u.id,
          u.username,
          u.full_name,
          u.profile_image_url,
          CASE WHEN f.id IS NOT NULL AND f.deleted_at IS NULL THEN TRUE ELSE FALSE END as is_followed,
          random() as sort_key  -- Include random() in SELECT for ORDER BY
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        LEFT JOIN followers f ON u.id = f.followed_id AND f.follower_id = $1
        WHERE u.id != $1  -- Not the requesting user
          AND u.deleted_at IS NULL  -- Only active users
          -- Exclude only ghost users completely unless connected
          -- Users without settings are included by default
          AND (
            us.user_id IS NULL  -- Include users without settings
            OR COALESCE(us.privacy_settings->>'privacy_mode', 'standard') != 'ghost'
            OR u.id IN (SELECT user_id FROM connected_users)
          )
          -- Respect show_in_suggestions setting (default to true if not set or no settings)
          AND (
            us.user_id IS NULL  -- Include users without settings
            OR us.privacy_settings->>'show_in_suggestions' IS NULL
            OR COALESCE((us.privacy_settings->>'show_in_suggestions')::boolean, true) = true
            OR u.id IN (SELECT user_id FROM connected_users)
          )
        ORDER BY u.id, sort_key  -- Order by ID first to make DISTINCT ON work, then by random
        OFFSET $2
        LIMIT $3;
      `;
      
      // Get total count for pagination (respecting privacy)
      const countQuery = `
        WITH connected_users AS (
          SELECT c1.connection_id as user_id
          FROM connections c1
          WHERE c1.user_id = $1
            AND c1.status = 'accepted'
            AND EXISTS (
              SELECT 1 FROM connections c2
              WHERE c2.user_id = c1.connection_id
                AND c2.connection_id = $1
                AND c2.status = 'accepted'
            )
        )
        SELECT COUNT(DISTINCT u.id) as total
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id != $1
          AND u.deleted_at IS NULL
          -- Exclude only ghost users unless connected
          -- Users without settings are included by default
          AND (
            us.user_id IS NULL  -- Include users without settings
            OR COALESCE(us.privacy_settings->>'privacy_mode', 'standard') != 'ghost'
            OR u.id IN (SELECT user_id FROM connected_users)
          )
          -- Respect show_in_suggestions setting (default to true if not set or no settings)
          AND (
            us.user_id IS NULL  -- Include users without settings
            OR us.privacy_settings->>'show_in_suggestions' IS NULL
            OR COALESCE((us.privacy_settings->>'show_in_suggestions')::boolean, true) = true
            OR u.id IN (SELECT user_id FROM connected_users)
          );
      `;
      
      const [{ rows }, countResult] = await Promise.all([
        db.query(query, [requestingUserId, offset, limit]),
        db.query(countQuery, [requestingUserId])
      ]);

      logger.info(`[UserController] getUserSuggestions - Found ${rows.length} suggestions for user ${requestingUserId} (page ${page}, limit ${limit}, offset ${offset})`);
      logger.info(`[UserController] getUserSuggestions - Total eligible users: ${countResult.rows[0].total}`);

      if (rows.length > 0) {
        logger.info(`[UserController] getUserSuggestions - First suggestion: ${JSON.stringify(rows[0])}`);
      }

      // Remove the sort_key from the response
      const suggestions = rows.map(({ sort_key, ...user }) => user);

      res.status(200).json({
        data: suggestions,
        pagination: {
          total: parseInt(countResult.rows[0].total),
          page,
          limit,
          has_more: offset + suggestions.length < parseInt(countResult.rows[0].total)
        }
      });
    } catch (error) {
      logger.error(`[UserController] Error getting user suggestions for user ${requestingUserId}:`, error);
      res.status(500).json({ error: 'Failed to get user suggestions', details: error.message });
    }
  };

  /**
   * Get user suggestions based on preference embeddings
   * Includes ALL users, with similarity scores for those with embeddings
   */
  const getUserSuggestionsWithPreferences = async (req, res) => {
    const requestingUserId = req.user?.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    logger.info(`[UserController] getUserSuggestionsWithPreferences - Request from user ${requestingUserId}, page ${page}, limit ${limit}`);

    try {
      // First get the user's discovery mode
      const { rows: [settings] } = await db.query(`
        SELECT discovery_mode
        FROM user_discovery_settings
        WHERE user_id = $1
      `, [requestingUserId]);

      const discoveryMode = settings?.discovery_mode || 'balanced';

      // Get users with preference embeddings for similarity scoring
      const similarUsers = await embeddingService.findSimilarUsersByPreferences(requestingUserId, {
        limit: 100, // Get more to have good variety
        threshold: 0.1 // Low threshold to get more candidates
      });

      // Create a map of user IDs to similarity scores
      const similarityMap = new Map();
      similarUsers.forEach(u => {
        similarityMap.set(u.id, u.similarity);
      });

      // Get ALL eligible users (not just those with embeddings)
      const allUsersQuery = `
        WITH connected_users AS (
          SELECT c1.connection_id as user_id
          FROM connections c1
          WHERE c1.user_id = $1
            AND c1.status = 'accepted'
            AND EXISTS (
              SELECT 1 FROM connections c2
              WHERE c2.user_id = c1.connection_id
                AND c2.connection_id = $1
                AND c2.status = 'accepted'
            )
        )
        SELECT
          u.id,
          u.username,
          u.full_name,
          u.profile_image_url,
          FALSE as is_followed  -- No more followers concept
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id != $1  -- Not the requesting user
          AND u.deleted_at IS NULL
          -- Exclude already connected users
          AND u.id NOT IN (SELECT user_id FROM connected_users)
          -- Exclude only ghost users unless connected
          AND (
            us.user_id IS NULL
            OR COALESCE(us.privacy_settings->>'privacy_mode', 'standard') != 'ghost'
          )
          -- Respect show_in_suggestions setting
          AND (
            us.user_id IS NULL
            OR us.privacy_settings->>'show_in_suggestions' IS NULL
            OR COALESCE((us.privacy_settings->>'show_in_suggestions')::boolean, true) = true
          )
        ORDER BY random()  -- Random order for now, will sort by similarity later
        LIMIT $2 OFFSET $3
      `;

      const { rows: allUsers } = await db.query(allUsersQuery, [requestingUserId, limit * 2, 0]);

      // Add similarity scores to users who have them
      const suggestions = allUsers.map(user => {
        const similarity = similarityMap.get(user.id);
        return {
          ...user,
          preference_similarity: similarity || undefined
        };
      });

      // Sort by similarity (users with embeddings first, then random)
      suggestions.sort((a, b) => {
        if (a.preference_similarity && b.preference_similarity) {
          return b.preference_similarity - a.preference_similarity; // Higher similarity first
        }
        if (a.preference_similarity) return -1; // Users with similarity come first
        if (b.preference_similarity) return 1;
        return 0; // Keep random order for users without similarity
      });

      // Apply pagination
      const paginatedSuggestions = suggestions.slice(offset, offset + limit);

      // Get total count of eligible users (not just those with embeddings)
      const countQuery = `
        WITH connected_users AS (
          SELECT c1.connection_id as user_id
          FROM connections c1
          WHERE c1.user_id = $1
            AND c1.status = 'accepted'
            AND EXISTS (
              SELECT 1 FROM connections c2
              WHERE c2.user_id = c1.connection_id
                AND c2.connection_id = $1
                AND c2.status = 'accepted'
            )
        )
        SELECT COUNT(*) as total
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id != $1
          AND u.deleted_at IS NULL
          AND u.id NOT IN (SELECT user_id FROM connected_users)
          AND (
            us.user_id IS NULL
            OR COALESCE(us.privacy_settings->>'privacy_mode', 'standard') != 'ghost'
          )
          AND (
            us.user_id IS NULL
            OR us.privacy_settings->>'show_in_suggestions' IS NULL
            OR COALESCE((us.privacy_settings->>'show_in_suggestions')::boolean, true) = true
          )
      `;
      const { rows: [countResult] } = await db.query(countQuery, [requestingUserId]);

      logger.info(`[UserController] getUserSuggestionsWithPreferences - Returning ${paginatedSuggestions.length} suggestions (${similarUsers.length} with embeddings)`);

      res.status(200).json({
        data: paginatedSuggestions,
        pagination: {
          total: parseInt(countResult.total),
          page,
          limit,
          has_more: offset + paginatedSuggestions.length < parseInt(countResult.total)
        },
        mode: 'preference-based',
        discovery_mode: discoveryMode
      });
    } catch (error) {
      logger.error(`[UserController] Error getting preference-based suggestions for user ${requestingUserId}:`, error);
      // Fall back to regular suggestions on error
      return getUserSuggestions(req, res);
    }
  };

  /**
   * Get preference similarity score between the current user and another user
   */
  const getPreferenceSimilarity = async (req, res) => {
    try {
      const currentUserId = req.user.id;
      const { targetUserId } = req.params;

      if (!targetUserId) {
        return res.status(400).json({ error: 'Target user ID is required' });
      }

      const similarity = await embeddingService.getPreferenceSimilarity(currentUserId, targetUserId);

      res.json({
        success: true,
        similarity,
        hasPreferences: similarity !== null
      });
    } catch (error) {
      logger.error('Error getting preference similarity:', error);
      res.status(500).json({ error: 'Failed to get preference similarity' });
    }
  };

  /**
   * Get multiple users by their IDs
   */
  const getUsersByIds = async (req, res) => {
    try {
      const ids = req.query.ids ? req.query.ids.split(',') : [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Please provide an array of user IDs' });
      }

      // logger.info(`[UserController] Fetching users by IDs: ${ids.join(', ')}`);

      const { rows } = await db.query(
        'SELECT id, username, email, full_name, profile_image_url FROM users WHERE id = ANY($1) AND deleted_at IS NULL',
        [ids]
      );

      // logger.info(`[UserController] Found ${rows.length} users`);
      res.json({ users: rows });
    } catch (err) {
      logger.error('Error fetching users by IDs:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * Search for users by username, email, or display name
   * Respects privacy settings - only shows public info for non-connected users
   */
  const searchUsers = async (req, res) => {
    const { q: query, limit = 20 } = req.query;
    const currentUserId = req.user.id;

    if (!query || query.length < 2) {
      return res.json({ users: [] });
    }

    try {
      const searchQuery = `%${query}%`;

      // Search all users, include connection status
      const { rows } = await db.query(
        `SELECT DISTINCT
          u.id,
          u.username,
          u.email,
          u.full_name as display_name,
          u.profile_image_url as avatar_url,
          CASE
            WHEN c.id IS NOT NULL THEN true
            ELSE false
          END as is_connected,
          CASE
            WHEN ci.id IS NOT NULL THEN true
            ELSE false
          END as has_pending_connection,
          CASE WHEN c.id IS NOT NULL THEN 0 ELSE 1 END as connection_sort
        FROM users u
        LEFT JOIN connections c ON
          ((c.user_id = $1 AND c.connection_id = u.id) OR
           (c.user_id = u.id AND c.connection_id = $1))
          AND c.status = 'accepted'
          AND c.removed_at IS NULL
        LEFT JOIN connection_invitations ci ON
          ((ci.sender_id = $1 AND ci.recipient_id = u.id) OR
           (ci.sender_id = u.id AND ci.recipient_id = $1))
          AND ci.status = 'pending'
        WHERE u.id != $1
          AND (u.username ILIKE $2 OR u.email ILIKE $2 OR u.full_name ILIKE $2)
          AND u.deleted_at IS NULL
        ORDER BY
          connection_sort, -- Connected users first
          u.username
        LIMIT $3`,
        [currentUserId, searchQuery, parseInt(limit)]
      );

      // Apply privacy settings for non-connected users
      const processedUsers = rows.map(user => {
        // Remove the connection_sort field as it's only for ordering
        const { connection_sort, ...userWithoutSort } = user;

        if (!user.is_connected) {
          // For non-connected users, hide email and display name based on privacy settings
          // For now, we'll show basic info but you can enhance this with actual privacy settings
          return {
            ...userWithoutSort,
            email: null, // Hide email for non-connected users
            display_name: user.display_name || user.username // Show display name if available
          };
        }
        return userWithoutSort;
      });

      return res.json({ users: processedUsers });
    } catch (error) {
      console.error('Error searching users:', error);
      return res.status(500).json({ error: 'Failed to search users' });
    }
  };

  // Debug endpoint to check user eligibility for suggestions
  const debugUserSuggestions = async (req, res) => {
    const requestingUserId = req.user?.id;

    try {
      // Get all users with their privacy settings
      const query = `
        SELECT
          u.id,
          u.username,
          u.email_verified,
          u.deleted_at,
          us.user_id as has_settings,
          us.privacy_settings->>'privacy_mode' as privacy_mode,
          us.privacy_settings->>'show_in_suggestions' as show_in_suggestions,
          CASE
            WHEN u.deleted_at IS NOT NULL THEN 'deleted'
            WHEN us.user_id IS NULL THEN 'eligible (no settings)'
            WHEN COALESCE(us.privacy_settings->>'privacy_mode', 'standard') = 'ghost' THEN 'ghost (hidden)'
            WHEN us.privacy_settings->>'show_in_suggestions' = 'false' THEN 'hidden by preference'
            ELSE 'eligible'
          END as suggestion_status,
          (SELECT COUNT(*) FROM followers f WHERE f.follower_id = $1 AND f.followed_id = u.id AND f.deleted_at IS NULL) as is_following
        FROM users u
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE u.id != $1
        ORDER BY u.created_at DESC
        LIMIT 30;
      `;

      const { rows } = await db.query(query, [requestingUserId]);

      // Get counts by status
      const statusCounts = {};
      rows.forEach(row => {
        statusCounts[row.suggestion_status] = (statusCounts[row.suggestion_status] || 0) + 1;
      });

      // Count users with and without settings
      const withSettings = rows.filter(r => r.has_settings).length;
      const withoutSettings = rows.filter(r => !r.has_settings).length;

      logger.info(`[UserController] debugUserSuggestions - Found ${rows.length} users total`);
      const eligible = rows.filter(r => r.suggestion_status.includes('eligible'));
      logger.info(`[UserController] debugUserSuggestions - ${eligible.length} are eligible for suggestions`);
      logger.info(`[UserController] debugUserSuggestions - ${withSettings} have settings, ${withoutSettings} don't have settings`);

      res.status(200).json({
        total_users: rows.length,
        eligible_count: eligible.length,
        users_with_settings: withSettings,
        users_without_settings: withoutSettings,
        status_counts: statusCounts,
        users: rows
      });
    } catch (error) {
      logger.error(`[UserController] Error in debugUserSuggestions:`, error);
      res.status(500).json({ error: 'Failed to debug user suggestions', details: error.message });
    }
  };

  // Return all controller methods
  return {
    getUsers,
    getUserById,
    createUser,
    deleteUser,
    deleteMultipleUsers,
    getUserFollowers,
    getUserFollowing,
    getUserPublicLists,
    getUserListsWithAccess,
    getUserListsLive,
    getUserSuggestions,
    getUserSuggestionsWithPreferences,
    getPreferenceSimilarity,
    debugUserSuggestions,
    getUsersByIds,
    searchUsers
  };
}

module.exports = userControllerFactory; 