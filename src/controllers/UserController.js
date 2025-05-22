const db = require('../config/db');
const bcrypt = require("bcrypt");
const saltRounds = 12;

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
        'SELECT id, username, email, full_name, is_active, is_verified FROM users ORDER BY id LIMIT $1 OFFSET $2',
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
    try {
      const { id } = req.params;

      const { rows } = await db.query(
        'SELECT id, username, email, full_name, is_active, is_verified FROM users WHERE id = $1',
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
    const { username, email, password, full_name, is_active, is_verified } = req.body;
    const password_hash = await bcrypt.hash(password, saltRounds);
    console.log('create user: ', { username, email, password, password_hash, full_name, is_active, is_verified });
    
    try {
      const result = await db.query(
        'INSERT INTO users (username, email, password_hash, full_name, is_active, is_verified) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [username, email, password_hash, full_name, is_active, is_verified]
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

  // Return all controller methods
  return {
    getUsers,
    getUserById,
    createUser,
    deleteUser,
    deleteMultipleUsers
  };
}

module.exports = userControllerFactory; 