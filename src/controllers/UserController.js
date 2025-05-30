const db = require('../config/db');
const bcrypt = require("bcrypt");
const saltRounds = 12;
const { logger } = require('../utils/logger');

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
   * Get a user by ID
   */
  const getUserById = async (req, res) => {
    console.log('!!!!!!!!!!!!!!!!! USERCONTROLLER.GETUSERBYID CALLED !!!!!!!!!!!!!!!!!');
    console.log('!!!!!!!!!!!!!!!!! req.params: ', JSON.stringify(req.params));
    console.log('!!!!!!!!!!!!!!!!! req.originalUrl: ', req.originalUrl);
    try {
      const { id } = req.params;

      const { rows } = await db.query(
        'SELECT id, username, email, full_name, email_verified FROM users WHERE id = $1',
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

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
      await db.query(
        `INSERT INTO public.sync_tracking (table_name, record_id, operation) 
         VALUES ($1, $2, $3)
         ON CONFLICT (table_name, record_id) DO NOTHING`,
        ['users', result.rows[0].id, 'create']
      );
      
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

      // Add sync tracking
      await db.query(
        `INSERT INTO public.sync_tracking (table_name, record_id, operation) 
         VALUES ($1, $2, $3)
         ON CONFLICT (table_name, record_id) DO NOTHING`,
        ['users', result.rows[0].id, 'delete']
      );

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

      // Add sync tracking for each deleted user
      for (const user of result.rows) {
        await db.query(
          `INSERT INTO public.sync_tracking (table_name, record_id, operation) 
           VALUES ($1, $2, $3)
           ON CONFLICT (table_name, record_id) DO NOTHING`,
          ['users', user.id, 'delete']
        );
      }

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

    logger.info(`[UserController] Request to get followers for user ${userId}`);

    try {
      // Query to get users who are following 'userId'
      // We select details of the follower from the 'users' table
      const query = `
        SELECT u.id, u.username, u.profile_picture_url, u.full_name 
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

    logger.info(`[UserController] Request to get users followed by user ${userId}`);

    try {
      // Query to get users whom 'userId' is following
      // We select details of the followed user from the 'users' table
      const query = `
        SELECT u.id, u.username, u.profile_picture_url, u.full_name
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

  // Get public lists of a specific user
  const getUserPublicLists = async (req, res) => {
    const { targetUserId } = req.params; // The ID of the user whose public lists we want to get
    // const requestingUserId = req.user?.id; // ID of the user making the request, to potentially show more if they have special access

    logger.info(`[UserController] Request to get public lists for user ${targetUserId}`);

    try {
      // Query to get lists owned by 'targetUserId' that are marked as public
      const query = `
        SELECT l.id, l.name, l.description, l.created_at, l.updated_at, l.is_public, l.owner_id,
               (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count,
               u.username as owner_username, u.profile_picture_url as owner_profile_picture_url
        FROM lists l
        JOIN users u ON l.owner_id = u.id
        WHERE l.owner_id = $1 AND l.is_public = TRUE AND l.deleted_at IS NULL
        ORDER BY l.updated_at DESC;
      `;
      const { rows } = await db.query(query, [targetUserId]);
      res.status(200).json(rows);
    } catch (error) {
      logger.error(`[UserController] Error getting public lists for user ${targetUserId}:`, error);
      res.status(500).json({ error: 'Failed to get public lists', details: error.message });
    }
  };

  // Placeholder for getUserSuggestions
  const getUserSuggestions = async (req, res) => {
    console.log('!!!!!!!!!!!!!!!!! USERCONTROLLER.GETUSERSUGGESTIONS CALLED !!!!!!!!!!!!!!!!!');
    console.log('!!!!!!!!!!!!!!!!! req.params: ', JSON.stringify(req.params));
    console.log('!!!!!!!!!!!!!!!!! req.originalUrl: ', req.originalUrl);
    const requestingUserId = req.user?.id;
    logger.info(`[UserController] Request to get user suggestions for user ${requestingUserId}`);

    try {
      // Simple suggestion logic: Get a few users (e.g., 5) that the current user is not already following,
      // are not the current user themselves, and are verified (if you have such a flag).
      // This is a basic example and can be significantly improved (e.g., mutual friends, interests, etc.)
      const query = `
        SELECT u.id, u.username, u.full_name, u.profile_image_url
        FROM users u
        WHERE u.id != $1  -- Not the requesting user
          AND u.email_verified = TRUE -- Example: suggest only verified users
          AND u.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM followers f
            WHERE f.follower_id = $1 AND f.followed_id = u.id AND f.deleted_at IS NULL
          )
        ORDER BY u.created_at DESC -- Or randomize, or by popularity etc.
        LIMIT 5;
      `;
      const { rows } = await db.query(query, [requestingUserId]);
      res.status(200).json(rows);
    } catch (error) {
      logger.error(`[UserController] Error getting user suggestions for user ${requestingUserId}:`, error);
      res.status(500).json({ error: 'Failed to get user suggestions', details: error.message });
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
    getUserSuggestions
  };
}

module.exports = userControllerFactory; 