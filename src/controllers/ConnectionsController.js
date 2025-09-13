const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * Factory function that creates a ConnectionsController
 * @param {Object} socketService - Socket service for real-time updates
 * @returns {Object} Controller object with connection methods
 */
function connectionsControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    notifyUser: () => {} // No-op function
  };

  const ConnectionsController = {
    /**
     * Send a connection request
     */
    sendConnectionRequest: async (req, res) => {
      const senderId = req.user.id;
      const { recipientId, message } = req.body;

      if (!recipientId) {
        return res.status(400).json({ error: 'Recipient ID is required' });
      }

      if (senderId === recipientId) {
        return res.status(400).json({ error: 'Cannot send connection request to yourself' });
      }

      try {
        // Check if connection already exists
        const existingConnection = await db.query(
          `SELECT * FROM connections
           WHERE (user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1)`,
          [senderId, recipientId]
        );

        if (existingConnection.rows.length > 0) {
          const status = existingConnection.rows[0].status;
          if (status === 'accepted') {
            return res.status(400).json({ error: 'Connection already exists' });
          }
          if (status === 'pending') {
            return res.status(400).json({ error: 'Connection request already pending' });
          }
          if (status === 'blocked') {
            return res.status(400).json({ error: 'Unable to send connection request' });
          }
        }

        // Check for existing invitation
        const existingInvitation = await db.query(
          `SELECT * FROM connection_invitations
           WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'`,
          [senderId, recipientId]
        );

        if (existingInvitation.rows.length > 0) {
          return res.status(400).json({ error: 'Invitation already sent' });
        }

        // Create connection invitation
        const invitation = await db.query(
          `INSERT INTO connection_invitations
           (sender_id, recipient_id, message, status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING *`,
          [senderId, recipientId, message]
        );

        // Create pending connection records for both users
        await db.query(
          `INSERT INTO connections
           (user_id, connection_id, status, initiated_by)
           VALUES ($1, $2, 'pending', $3)`,
          [senderId, recipientId, senderId]
        );

        await db.query(
          `INSERT INTO connections
           (user_id, connection_id, status, initiated_by)
           VALUES ($1, $2, 'pending', $3)`,
          [recipientId, senderId, senderId]
        );

        // Notify recipient via socket
        safeSocketService.notifyUser(recipientId, 'connection:request', {
          invitation: invitation.rows[0],
          sender: {
            id: req.user.id,
            username: req.user.username,
            full_name: req.user.full_name
          }
        });

        res.status(201).json({
          message: 'Connection request sent',
          invitation: invitation.rows[0]
        });
      } catch (error) {
        console.error('Error sending connection request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get pending connection requests for the current user
     */
    getPendingRequests: async (req, res) => {
      const userId = req.user.id;

      try {
        const result = await db.query(
          `SELECT ci.*,
                  u.username, u.full_name, u.profile_image_url,
                  ups.show_email_to_connections,
                  CASE WHEN ups.show_email_to_connections = true THEN u.email ELSE NULL END as email
           FROM connection_invitations ci
           JOIN users u ON u.id = ci.sender_id
           LEFT JOIN user_privacy_settings ups ON ups.user_id = u.id
           WHERE ci.recipient_id = $1
             AND ci.status = 'pending'
             AND ci.expires_at > NOW()
           ORDER BY ci.created_at DESC`,
          [userId]
        );

        res.json(result.rows);
      } catch (error) {
        console.error('Error fetching pending requests:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get sent connection requests
     */
    getSentRequests: async (req, res) => {
      const userId = req.user.id;

      try {
        const result = await db.query(
          `SELECT ci.*,
                  u.username, u.full_name, u.profile_image_url
           FROM connection_invitations ci
           JOIN users u ON u.id = ci.recipient_id
           WHERE ci.sender_id = $1
             AND ci.status = 'pending'
             AND ci.expires_at > NOW()
           ORDER BY ci.created_at DESC`,
          [userId]
        );

        res.json(result.rows);
      } catch (error) {
        console.error('Error fetching sent requests:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Accept a connection request
     */
    acceptRequest: async (req, res) => {
      const userId = req.user.id;
      const { requestId } = req.params;

      try {
        // Get the invitation
        const invitation = await db.query(
          `SELECT * FROM connection_invitations
           WHERE id = $1 AND recipient_id = $2 AND status = 'pending'`,
          [requestId, userId]
        );

        if (invitation.rows.length === 0) {
          return res.status(404).json({ error: 'Invitation not found' });
        }

        const { sender_id } = invitation.rows[0];

        // Begin transaction
        await db.query('BEGIN');

        // Update invitation status
        await db.query(
          `UPDATE connection_invitations
           SET status = 'accepted', responded_at = NOW()
           WHERE id = $1`,
          [requestId]
        );

        // Update both connection records to accepted
        await db.query(
          `UPDATE connections
           SET status = 'accepted', accepted_at = NOW()
           WHERE ((user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1))`,
          [userId, sender_id]
        );

        await db.query('COMMIT');

        // Notify sender via socket
        safeSocketService.notifyUser(sender_id, 'connection:accepted', {
          acceptedBy: {
            id: userId,
            username: req.user.username,
            full_name: req.user.full_name
          }
        });

        res.json({ message: 'Connection request accepted' });
      } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error accepting connection request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Cancel a sent connection request
     */
    cancelRequest: async (req, res) => {
      const userId = req.user.id;
      const { requestId } = req.params;

      try {
        // Begin transaction
        await db.query('BEGIN');

        // Update invitation status (only if sender is the current user)
        const result = await db.query(
          `UPDATE connection_invitations
           SET status = 'cancelled', responded_at = NOW()
           WHERE id = $1 AND sender_id = $2 AND status = 'pending'
           RETURNING recipient_id`,
          [requestId, userId]
        );

        if (result.rows.length === 0) {
          await db.query('ROLLBACK');
          return res.status(404).json({ error: 'Invitation not found or already processed' });
        }

        const recipientId = result.rows[0].recipient_id;

        // Remove pending connection records
        await db.query(
          `DELETE FROM connections
           WHERE ((user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1))
             AND status = 'pending'`,
          [userId, recipientId]
        );

        await db.query('COMMIT');

        // Notify recipient that request was cancelled
        safeSocketService.notifyUser(recipientId, 'connection:cancelled', {
          cancelledBy: {
            id: userId,
            username: req.user.username
          }
        });

        res.json({ message: 'Connection request cancelled' });
      } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error cancelling connection request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Decline a connection request
     */
    declineRequest: async (req, res) => {
      const userId = req.user.id;
      const { requestId } = req.params;

      try {
        // Begin transaction
        await db.query('BEGIN');

        // Update invitation status
        const result = await db.query(
          `UPDATE connection_invitations
           SET status = 'declined', responded_at = NOW()
           WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
           RETURNING sender_id`,
          [requestId, userId]
        );

        if (result.rows.length === 0) {
          await db.query('ROLLBACK');
          return res.status(404).json({ error: 'Invitation not found' });
        }

        const senderId = result.rows[0].sender_id;

        // Remove pending connection records
        await db.query(
          `DELETE FROM connections
           WHERE ((user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1))
             AND status = 'pending'`,
          [userId, senderId]
        );

        await db.query('COMMIT');

        res.json({ message: 'Connection request declined' });
      } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error declining connection request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get all connections for the current user
     */
    getConnections: async (req, res) => {
      const userId = req.user.id;

      try {
        const result = await db.query(
          `SELECT c.*,
                  u.username, u.full_name, u.profile_image_url,
                  ups.show_email_to_connections,
                  CASE WHEN ups.show_email_to_connections = true THEN u.email ELSE NULL END as email
           FROM connections c
           JOIN users u ON u.id = c.connection_id
           LEFT JOIN user_privacy_settings ups ON ups.user_id = u.id
           WHERE c.user_id = $1 AND c.status = 'accepted'
           ORDER BY c.accepted_at DESC`,
          [userId]
        );

        res.json(result.rows);
      } catch (error) {
        console.error('Error fetching connections:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Remove a connection
     */
    removeConnection: async (req, res) => {
      const userId = req.user.id;
      const { connectionId } = req.params;

      try {
        // Begin transaction for cascade deletion
        await db.query('BEGIN');

        // Update connection status to removed
        await db.query(
          `UPDATE connections
           SET status = 'removed', removed_at = NOW()
           WHERE ((user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1))
             AND status = 'accepted'`,
          [userId, connectionId]
        );

        // Remove from all shared groups
        await db.query(
          `DELETE FROM collaboration_group_members
           WHERE user_id = $2
             AND group_id IN (
               SELECT group_id FROM collaboration_group_members
               WHERE user_id = $1
             )`,
          [userId, connectionId]
        );

        // Revoke access to shared lists (update privacy_level if needed)
        // This would need more complex logic based on your sharing model

        await db.query('COMMIT');

        // Notify the removed connection
        safeSocketService.notifyUser(connectionId, 'connection:removed', {
          removedBy: {
            id: userId,
            username: req.user.username
          }
        });

        res.json({ message: 'Connection removed' });
      } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error removing connection:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Block a user
     */
    blockUser: async (req, res) => {
      const userId = req.user.id;
      const { userIdToBlock } = req.params;

      if (userId === userIdToBlock) {
        return res.status(400).json({ error: 'Cannot block yourself' });
      }

      try {
        await db.query('BEGIN');

        // Update or insert connection record as blocked
        await db.query(
          `INSERT INTO connections (user_id, connection_id, status, initiated_by)
           VALUES ($1, $2, 'blocked', $1)
           ON CONFLICT (user_id, connection_id)
           DO UPDATE SET status = 'blocked', updated_at = NOW()`,
          [userId, userIdToBlock]
        );

        // Cancel any pending invitations
        await db.query(
          `UPDATE connection_invitations
           SET status = 'cancelled'
           WHERE (sender_id = $1 AND recipient_id = $2)
              OR (sender_id = $2 AND recipient_id = $1)`,
          [userId, userIdToBlock]
        );

        await db.query('COMMIT');

        res.json({ message: 'User blocked' });
      } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error blocking user:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get user's privacy settings
     */
    getPrivacySettings: async (req, res) => {
      const userId = req.user.id;

      try {
        const result = await db.query(
          `SELECT * FROM user_privacy_settings WHERE user_id = $1`,
          [userId]
        );

        if (result.rows.length === 0) {
          // Create default settings if they don't exist
          const newSettings = await db.query(
            `INSERT INTO user_privacy_settings (user_id)
             VALUES ($1)
             RETURNING *`,
            [userId]
          );
          return res.json(newSettings.rows[0]);
        }

        res.json(result.rows[0]);
      } catch (error) {
        console.error('Error fetching privacy settings:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Update user's privacy settings
     */
    updatePrivacySettings: async (req, res) => {
      const userId = req.user.id;
      const updates = req.body;

      // Validate privacy_mode if provided
      if (updates.privacy_mode && !['private', 'standard', 'public'].includes(updates.privacy_mode)) {
        return res.status(400).json({ error: 'Invalid privacy mode' });
      }

      try {
        // Build dynamic update query
        const allowedFields = [
          'privacy_mode',
          'show_email_to_connections',
          'allow_connection_requests',
          'allow_group_invites_from_connections',
          'searchable_by_username',
          'searchable_by_email',
          'searchable_by_name',
          'show_mutual_connections'
        ];

        const updateFields = [];
        const values = [];
        let paramCount = 1;

        for (const field of allowedFields) {
          if (field in updates) {
            updateFields.push(`${field} = $${paramCount}`);
            values.push(updates[field]);
            paramCount++;
          }
        }

        if (updateFields.length === 0) {
          return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(userId);

        const result = await db.query(
          `UPDATE user_privacy_settings
           SET ${updateFields.join(', ')}, updated_at = NOW()
           WHERE user_id = $${paramCount}
           RETURNING *`,
          values
        );

        res.json(result.rows[0]);
      } catch (error) {
        console.error('Error updating privacy settings:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Check connection status between current user and another user
     */
    checkConnectionStatus: async (req, res) => {
      const userId = req.user.id;
      const { targetUserId } = req.params;

      if (!targetUserId) {
        return res.status(400).json({ error: 'Target user ID is required' });
      }

      try {
        // Check for existing connection
        const connectionResult = await db.query(
          `SELECT status FROM connections
           WHERE user_id = $1 AND connection_id = $2`,
          [userId, targetUserId]
        );

        // Check for pending invitation from current user
        const sentInvitationResult = await db.query(
          `SELECT id, status, created_at, message FROM connection_invitations
           WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
          [userId, targetUserId]
        );

        // Check for pending invitation to current user
        const receivedInvitationResult = await db.query(
          `SELECT id, status, created_at, message FROM connection_invitations
           WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1`,
          [targetUserId, userId]
        );

        const status = {
          isConnected: false,
          connectionStatus: null,
          hasSentRequest: false,
          hasReceivedRequest: false,
          sentInvitation: sentInvitationResult.rows[0] || null,
          receivedInvitation: receivedInvitationResult.rows[0] || null
        };

        if (connectionResult.rows.length > 0) {
          const connectionStatus = connectionResult.rows[0].status;
          status.connectionStatus = connectionStatus;
          status.isConnected = connectionStatus === 'accepted';
        }

        status.hasSentRequest = sentInvitationResult.rows.length > 0;
        status.hasReceivedRequest = receivedInvitationResult.rows.length > 0;

        res.json(status);
      } catch (error) {
        console.error('Error checking connection status:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Search for users (respecting privacy settings)
     */
    searchUsers: async (req, res) => {
      const userId = req.user.id;
      const { query, searchBy = 'username' } = req.query;

      if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
      }

      try {
        let searchQuery;
        let params = [`%${query}%`, userId];

        if (searchBy === 'username') {
          searchQuery = `
            SELECT u.id, u.username, u.full_name, u.profile_image_url,
                   ups.privacy_mode,
                   CASE
                     WHEN c.status = 'accepted' THEN true
                     ELSE false
                   END as is_connected,
                   CASE
                     WHEN ci.id IS NOT NULL THEN true
                     ELSE false
                   END as request_pending,
                   (SELECT COUNT(*)
                    FROM connections mc
                    WHERE mc.connection_id = u.id
                      AND mc.status = 'accepted'
                      AND mc.user_id IN (
                        SELECT connection_id FROM connections
                        WHERE user_id = $2 AND status = 'accepted'
                      )
                   ) as mutual_connections_count
            FROM users u
            LEFT JOIN user_privacy_settings ups ON ups.user_id = u.id
            LEFT JOIN connections c ON c.user_id = $2
              AND c.connection_id = u.id
              AND c.status = 'accepted'
            LEFT JOIN connection_invitations ci ON ci.sender_id = $2
              AND ci.recipient_id = u.id
              AND ci.status = 'pending'
            WHERE u.username ILIKE $1
              AND u.id != $2
              AND (ups.searchable_by_username = true OR ups.privacy_mode = 'public')
            LIMIT 20`;
        } else if (searchBy === 'email') {
          searchQuery = `
            SELECT u.id, u.username, u.full_name, u.profile_image_url,
                   ups.privacy_mode,
                   CASE
                     WHEN c.status = 'accepted' THEN true
                     ELSE false
                   END as is_connected
            FROM users u
            LEFT JOIN user_privacy_settings ups ON ups.user_id = u.id
            LEFT JOIN connections c ON c.user_id = $2
              AND c.connection_id = u.id
            WHERE u.email = $1
              AND u.id != $2
              AND (ups.searchable_by_email = true OR ups.privacy_mode = 'public')
            LIMIT 20`;
          params = [query, userId]; // Exact match for email
        } else {
          return res.status(400).json({ error: 'Invalid search type' });
        }

        const result = await db.query(searchQuery, params);

        // Filter sensitive information based on connection status
        const sanitizedResults = result.rows.map(user => {
          if (!user.is_connected && user.privacy_mode === 'private') {
            // Don't show private users unless connected
            return null;
          }

          // Remove email unless connected and allowed
          if (!user.is_connected) {
            delete user.email;
          }

          return user;
        }).filter(u => u !== null);

        res.json(sanitizedResults);
      } catch (error) {
        console.error('Error searching users:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  return ConnectionsController;
}

module.exports = connectionsControllerFactory;