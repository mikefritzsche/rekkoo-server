const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { DEFAULT_NOTIFICATION_PREFERENCES } = require('../utils/notificationPreferences');

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
     * Send a connection request (for mutual connections)
     */
    sendConnectionRequest: async (req, res) => {
      const senderId = req.user.id;
      const { recipientId, message, connectionType = 'mutual', invitation_context, metadata } = req.body;

      if (!recipientId) {
        return res.status(400).json({ error: 'Recipient ID is required' });
      }

      if (senderId === recipientId) {
        return res.status(400).json({ error: 'Cannot send connection request to yourself' });
      }

      try {
        // Check if user can send a connection request (rate limiting and history check)
        const canSendCheck = await db.query(
          `SELECT * FROM public.can_send_connection_request($1, $2)`,
          [senderId, recipientId]
        );

        const canSend = canSendCheck.rows[0];
        if (!canSend.can_send) {
          return res.status(400).json({
            error: canSend.reason,
            retryAfter: canSend.retry_after,
            attemptCount: canSend.attempt_count,
            declinedCount: canSend.declined_count
          });
        }

        // Check if connection already exists
        const existingConnection = await db.query(
          `SELECT * FROM connections
           WHERE (user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1)`,
          [senderId, recipientId]
        );

        if (existingConnection.rows.length > 0) {
          const status = existingConnection.rows[0].status;
          const existingType = existingConnection.rows[0].connection_type;

          if (status === 'accepted' && existingType === 'mutual') {
            return res.status(400).json({ error: 'Mutual connection already exists' });
          }
          if (status === 'following' && connectionType === 'following') {
            return res.status(400).json({ error: 'Already following this user' });
          }
          if (status === 'pending' && existingType === 'mutual') {
            return res.status(400).json({ error: 'Connection request already pending' });
          }
          if (status === 'blocked') {
            return res.status(400).json({ error: 'Unable to send connection request' });
          }
          if (status === 'removed') {
            // Allow new connection request when connection was previously removed
            console.log(`Recreating removed connection between ${senderId} and ${recipientId}`);
          }
          // Special case: If user has a 'following' relationship but wants mutual connection,
          // we should allow it and upgrade the relationship
          else if (status === 'following' && connectionType === 'mutual') {
            // Continue - we'll update the existing connection to mutual
            console.log(`Upgrading following relationship to mutual between ${senderId} and ${recipientId}`);
          } else {
            // For any other existing connection, return a specific error
            return res.status(400).json({
              error: `Connection already exists with status: ${status}`,
              existingStatus: status,
              existingType: existingType
            });
          }
        }

        // For following connections, create them immediately without invitation
        if (connectionType === 'following') {
          await db.query(
            `INSERT INTO connections
             (user_id, connection_id, status, connection_type, initiated_by, auto_accepted, visibility_level, accepted_at)
             VALUES ($1, $2, 'following', 'following', $3, true, 'public', NOW())
             ON CONFLICT (user_id, connection_id)
             DO UPDATE SET status = 'following', connection_type = 'following', auto_accepted = true`,
            [senderId, recipientId, senderId]
          );

          // Notify user they have a new follower
          safeSocketService.notifyUser(recipientId, 'connection:new_follower', {
            follower: {
              id: req.user.id,
              username: req.user.username,
              full_name: req.user.full_name
            }
          });

          return res.status(201).json({
            message: 'Now following user',
            connectionType: 'following'
          });
        }

        // For mutual connections, first update any existing non-pending invitations
      await db.query(
        `UPDATE connection_invitations
         SET status = 'pending',
             message = $3,
             invitation_context = $4,
             metadata = $5,
             created_at = CURRENT_TIMESTAMP,
             expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days'
         WHERE sender_id = $1 AND recipient_id = $2
         AND status IN ('rejected', 'expired')
         RETURNING *`,
        [senderId, recipientId, message, invitation_context || null, metadata || null]
      );

      // Check if we updated an existing invitation
      const updatedInvitation = await db.query(
        `SELECT * FROM connection_invitations
         WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'
         AND expires_at > NOW()`,
        [senderId, recipientId]
      );

      if (updatedInvitation.rows.length > 0) {
        // Use the updated invitation
        const invitation = updatedInvitation.rows[0];

        // Notify recipient via socket
        safeSocketService.notifyUser(recipientId, 'connection:request', {
          invitation,
          sender: {
            id: req.user.id,
            username: req.user.username,
            full_name: req.user.full_name,
            profile_image_url: req.user.profile_image_url
          }
        });

        return res.status(201).json({
          message: 'Connection request resent',
          invitation,
          connectionType: 'mutual'
        });
      }

      // Check for existing pending invitation
      const existingInvitation = await db.query(
        `SELECT * FROM connection_invitations
         WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'
         AND expires_at > NOW()`,
        [senderId, recipientId]
      );

      if (existingInvitation.rows.length > 0) {
        return res.status(400).json({ error: 'Invitation already sent' });
      }

      // Create new connection invitation for mutual connections
      const invitation = await db.query(
        `INSERT INTO connection_invitations
         (sender_id, recipient_id, message, status, invitation_context, metadata)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         RETURNING *`,
        [senderId, recipientId, message, invitation_context || null, metadata || null]
      );

        // Create pending connection records for both users (mutual type)
        // Use ON CONFLICT to handle cases where records already exist
        // If upgrading from following to mutual, or recreating removed connection, update the status and type
        await db.query(
          `INSERT INTO connections
           (user_id, connection_id, status, connection_type, initiated_by, visibility_level)
           VALUES ($1, $2, 'pending', 'mutual', $3, 'friends')
           ON CONFLICT (user_id, connection_id) DO UPDATE SET
             status = CASE
               WHEN connections.connection_type = 'following' THEN 'pending'
               WHEN connections.status = 'removed' THEN 'pending'
               ELSE connections.status
             END,
             connection_type = 'mutual',
             updated_at = CURRENT_TIMESTAMP`,
          [senderId, recipientId, senderId]
        );

        await db.query(
          `INSERT INTO connections
           (user_id, connection_id, status, connection_type, initiated_by, visibility_level)
           VALUES ($1, $2, 'pending', 'mutual', $3, 'friends')
           ON CONFLICT (user_id, connection_id) DO UPDATE SET
             status = CASE
               WHEN connections.connection_type = 'following' THEN 'pending'
               WHEN connections.status = 'removed' THEN 'pending'
               ELSE connections.status
             END,
             connection_type = 'mutual',
             updated_at = CURRENT_TIMESTAMP`,
          [recipientId, senderId, senderId]
        );

        // Notify recipient via socket
        safeSocketService.notifyUser(recipientId, 'connection:request', {
          invitation: invitation.rows[0],
          sender: {
            id: req.user.id,
            username: req.user.username,
            full_name: req.user.full_name,
            profile_image_url: req.user.profile_image_url
          }
        });

        // Check if the invitation was auto-accepted by the trigger
        const wasAutoAccepted = invitation.rows[0].status === 'accepted';

        res.status(201).json({
          message: wasAutoAccepted ? 'Connection automatically accepted' : 'Connection request sent',
          invitation: invitation.rows[0],
          connectionType: 'mutual',
          autoAccepted: wasAutoAccepted
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
                  ci.invitation_context,
                  ci.metadata,
                  u.username,
                  -- Only show full_name if sender's privacy mode is not 'private'
                  CASE
                    WHEN us.privacy_settings->>'privacy_mode' = 'private' THEN NULL
                    ELSE u.full_name
                  END as full_name,
                  -- Only show profile image if privacy mode is not 'private'
                  CASE
                    WHEN us.privacy_settings->>'privacy_mode' = 'private' THEN NULL
                    ELSE u.profile_image_url
                  END as profile_image_url,
                  us.privacy_settings->>'privacy_mode' as privacy_mode,
                  (us.privacy_settings->>'show_email_to_connections')::boolean as show_email_to_connections,
                  -- Never show email to non-connections
                  NULL as email
           FROM connection_invitations ci
           JOIN users u ON u.id = ci.sender_id
           LEFT JOIN user_settings us ON us.user_id = u.id
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
                  u.username,
                  -- Only show full_name if recipient's privacy mode is not 'private'
                  CASE
                    WHEN us.privacy_settings->>'privacy_mode' = 'private' THEN NULL
                    ELSE u.full_name
                  END as full_name,
                  -- Only show profile image if privacy mode is not 'private'
                  CASE
                    WHEN us.privacy_settings->>'privacy_mode' = 'private' THEN NULL
                    ELSE u.profile_image_url
                  END as profile_image_url,
                  us.privacy_settings->>'privacy_mode' as privacy_mode
           FROM connection_invitations ci
           JOIN users u ON u.id = ci.recipient_id
           LEFT JOIN user_settings us ON us.user_id = u.id
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
        // Get the invitation with group context
        const invitation = await db.query(
          `SELECT ci.*,
                  cg.id as group_id,
                  cg.name as group_name,
                  u_sender.username as sender_username,
                  u_sender.full_name as sender_full_name
           FROM connection_invitations ci
           LEFT JOIN collaboration_groups cg ON ci.context_id = cg.id
           LEFT JOIN users u_sender ON ci.sender_id = u_sender.id
           WHERE ci.id = $1 AND ci.recipient_id = $2 AND ci.status = 'pending'`,
          [requestId, userId]
        );

        if (invitation.rows.length === 0) {
          return res.status(404).json({ error: 'Invitation not found' });
        }

        const inv = invitation.rows[0];
        const hasGroupContext = inv.invitation_context === 'group_invitation' && inv.group_id;

        // Begin transaction
        await db.query('BEGIN');

        // Update invitation status - this will trigger the auto-group addition
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
          [userId, inv.sender_id]
        );

        // Check if user was auto-added to group (if group context exists)
        let groupNotificationData = null;
        if (hasGroupContext) {
          // Check if user is now a member of the group
          const memberCheck = await db.query(
            `SELECT 1 FROM collaboration_group_members
             WHERE group_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [inv.group_id, userId]
          );

          if (memberCheck.rows.length > 0) {
            // User was auto-added to the group
            groupNotificationData = {
              groupId: inv.group_id,
              groupName: inv.group_name,
              memberId: userId,
              memberUsername: req.user.username,
              autoAdded: true
            };

            // Send group membership notification to the sender (User A)
            safeSocketService.notifyUser(inv.sender_id, 'group:member-auto-added', {
              group: {
                id: inv.group_id,
                name: inv.group_name
              },
              member: {
                id: userId,
                username: req.user.username,
                full_name: req.user.full_name
              }
            });
          }
        }

        await db.query('COMMIT');

        // Notify sender via socket
        safeSocketService.notifyUser(inv.sender_id, 'connection:accepted', {
          acceptedBy: {
            id: userId,
            username: req.user.username,
            full_name: req.user.full_name
          },
          groupContext: hasGroupContext ? {
            groupId: inv.group_id,
            groupName: inv.group_name,
            autoAdded: !!groupNotificationData
          } : null
        });

        res.json({
          message: 'Connection request accepted',
          groupContext: hasGroupContext ? {
            groupId: inv.group_id,
            groupName: inv.group_name,
            autoAdded: !!groupNotificationData
          } : null
        });
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
      const { declineType = 'standard', declineMessage, notifySender = false } = req.body;

      try {
        // Begin transaction
        await db.query('BEGIN');

        // Update invitation status with decline details
        const result = await db.query(
          `UPDATE connection_invitations
           SET status = 'declined',
               responded_at = NOW(),
               decline_type = $3,
               decline_message = $4
           WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
           RETURNING sender_id`,
          [requestId, userId, declineType, declineMessage]
        );

        if (result.rows.length === 0) {
          await db.query('ROLLBACK');
          return res.status(404).json({ error: 'Invitation not found' });
        }

        const senderId = result.rows[0].sender_id;

        // Record the decline in history (with soft block if requested)
        await db.query(
          `SELECT public.record_connection_decline($1, $2, $3, $4)`,
          [senderId, userId, declineType, declineType === 'soft_block' ? 90 : null]
        );

        // Remove pending connection records
        await db.query(
          `DELETE FROM connections
           WHERE ((user_id = $1 AND connection_id = $2)
              OR (user_id = $2 AND connection_id = $1))
             AND status = 'pending'`,
          [userId, senderId]
        );

        await db.query('COMMIT');

        // Check if sender should be notified (based on their privacy settings)
        const senderSettings = await db.query(
          `SELECT privacy_settings->>'notify_on_request_declined' as notify_declined
           FROM user_settings WHERE user_id = $1`,
          [senderId]
        );

        const shouldNotify = notifySender ||
          (senderSettings.rows[0] && senderSettings.rows[0].notify_declined === 'true');

        if (shouldNotify) {
          // Notify sender that request was declined
          safeSocketService.notifyUser(senderId, 'connection:declined', {
            declinedBy: {
              id: userId,
              username: req.user.username
            },
            declineType,
            message: declineType === 'soft_block'
              ? 'Your connection request was declined. You cannot send another request to this user at this time.'
              : 'Your connection request was declined.'
          });
        }

        res.json({
          message: 'Connection request declined',
          declineType
        });
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
      const { type = 'all' } = req.query; // 'all', 'mutual', 'following', 'followers'

      try {
        let whereClause = `c.user_id = $1 AND (c.status = 'accepted' OR c.status = 'following')`;

        if (type === 'mutual') {
          whereClause = `c.user_id = $1 AND c.status = 'accepted' AND c.connection_type = 'mutual'`;
        } else if (type === 'following') {
          whereClause = `c.user_id = $1 AND c.status = 'following' AND c.connection_type = 'following'`;
        } else if (type === 'followers') {
          // Get users who are following the current user
          const followersResult = await db.query(
            `SELECT c.*,
                    u.username, u.full_name, u.profile_image_url,
                    (us.privacy_settings->>'show_email_to_connections')::boolean as show_email_to_connections,
                    CASE WHEN (us.privacy_settings->>'show_email_to_connections')::boolean = true THEN u.email ELSE NULL END as email,
                    c.connection_type, c.visibility_level, c.auto_accepted
             FROM connections c
             JOIN users u ON u.id = c.user_id
             LEFT JOIN user_settings us ON us.user_id = u.id
             WHERE c.connection_id = $1 AND c.status = 'following' AND c.connection_type = 'following'
             ORDER BY c.accepted_at DESC`,
            [userId]
          );
          return res.json(followersResult.rows);
        }

        const result = await db.query(
          `SELECT c.*,
                  u.username, u.full_name, u.profile_image_url,
                  (us.privacy_settings->>'show_email_to_connections')::boolean as show_email_to_connections,
                  CASE WHEN (us.privacy_settings->>'show_email_to_connections')::boolean = true THEN u.email ELSE NULL END as email,
                  c.connection_type, c.visibility_level, c.auto_accepted
           FROM connections c
           JOIN users u ON u.id = c.connection_id
           LEFT JOIN user_settings us ON us.user_id = u.id
           WHERE ${whereClause}
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
     * Follow a user (unidirectional connection)
     */
    followUser: async (req, res) => {
      const followerId = req.user.id;
      const { userId: followedId } = req.params;

      if (followerId === followedId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
      }

      try {
        // Check if already following or has mutual connection
        const existingConnection = await db.query(
          `SELECT * FROM connections
           WHERE user_id = $1 AND connection_id = $2`,
          [followerId, followedId]
        );

        if (existingConnection.rows.length > 0) {
          const { status, connection_type } = existingConnection.rows[0];
          if (status === 'following' || (status === 'accepted' && connection_type === 'mutual')) {
            return res.status(400).json({ error: 'Already connected with this user' });
          }
          if (status === 'blocked') {
            return res.status(400).json({ error: 'Unable to follow this user' });
          }
        }

        // Create following connection (auto-accepted)
        await db.query(
          `INSERT INTO connections
           (user_id, connection_id, status, connection_type, initiated_by, auto_accepted, visibility_level, accepted_at)
           VALUES ($1, $2, 'following', 'following', $3, true, 'public', NOW())
           ON CONFLICT (user_id, connection_id)
           DO UPDATE SET status = 'following', connection_type = 'following', auto_accepted = true, accepted_at = NOW()`,
          [followerId, followedId, followerId]
        );

        // Notify user they have a new follower
        safeSocketService.notifyUser(followedId, 'connection:new_follower', {
          follower: {
            id: req.user.id,
            username: req.user.username,
            full_name: req.user.full_name,
            profile_image_url: req.user.profile_image_url
          }
        });

        res.status(201).json({
          message: 'Successfully followed user',
          connectionType: 'following'
        });
      } catch (error) {
        console.error('Error following user:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Unfollow a user
     */
    unfollowUser: async (req, res) => {
      const followerId = req.user.id;
      const { userId: followedId } = req.params;

      try {
        const result = await db.query(
          `DELETE FROM connections
           WHERE user_id = $1 AND connection_id = $2
           AND connection_type = 'following' AND status = 'following'
           RETURNING *`,
          [followerId, followedId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Not following this user' });
        }

        // Notify user they lost a follower
        safeSocketService.notifyUser(followedId, 'connection:unfollowed', {
          unfollowedBy: {
            id: req.user.id,
            username: req.user.username
          }
        });

        res.json({ message: 'Successfully unfollowed user' });
      } catch (error) {
        console.error('Error unfollowing user:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get followers of the current user
     */
    getFollowers: async (req, res) => {
      const userId = req.user.id;

      try {
        const result = await db.query(
          `SELECT c.*,
                  u.username, u.full_name, u.profile_image_url,
                  c.connection_type, c.visibility_level,
                  EXISTS(
                    SELECT 1 FROM connections fc
                    WHERE fc.user_id = $1 AND fc.connection_id = u.id
                    AND (fc.status = 'following' OR fc.status = 'accepted')
                  ) as is_following_back
           FROM connections c
           JOIN users u ON u.id = c.user_id
           WHERE c.connection_id = $1
           AND c.status = 'following'
           AND c.connection_type = 'following'
           ORDER BY c.accepted_at DESC`,
          [userId]
        );

        res.json(result.rows);
      } catch (error) {
        console.error('Error fetching followers:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get users the current user is following
     */
    getFollowing: async (req, res) => {
      const userId = req.user.id;

      try {
        const result = await db.query(
          `SELECT c.*,
                  u.username, u.full_name, u.profile_image_url,
                  c.connection_type, c.visibility_level,
                  EXISTS(
                    SELECT 1 FROM connections fc
                    WHERE fc.user_id = u.id AND fc.connection_id = $1
                    AND (fc.status = 'following' OR fc.status = 'accepted')
                  ) as follows_back
           FROM connections c
           JOIN users u ON u.id = c.connection_id
           WHERE c.user_id = $1
           AND c.status = 'following'
           AND c.connection_type = 'following'
           ORDER BY c.accepted_at DESC`,
          [userId]
        );

        res.json(result.rows);
      } catch (error) {
        console.error('Error fetching following list:', error);
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
          `SELECT privacy_settings FROM user_settings WHERE user_id = $1`,
          [userId]
        );

        if (result.rows.length === 0) {
          // Generate connection code for private mode
          const codeResult = await db.query(`SELECT public.generate_user_connection_code() as code`);

          // Create default settings if they don't exist (default to private mode)
          const defaultSettings = {
            privacy_mode: 'private',
            show_email_to_connections: false,
            allow_connection_requests: true,
            allow_group_invites_from_connections: true,
            searchable_by_username: false,
            searchable_by_email: false,
            searchable_by_name: false,
            show_mutual_connections: false,
            connection_code: codeResult.rows[0].code
          };

          const newSettings = await db.query(
            `INSERT INTO user_settings (user_id, privacy_settings, notification_preferences, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (user_id) DO UPDATE
             SET privacy_settings = $2, updated_at = NOW()
             RETURNING privacy_settings`,
            [userId, JSON.stringify(defaultSettings), DEFAULT_NOTIFICATION_PREFERENCES]
          );
          return res.json(newSettings.rows[0].privacy_settings);
        }

        res.json(result.rows[0].privacy_settings || {});
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
        // Get current settings
        const currentResult = await db.query(
          `SELECT privacy_settings FROM user_settings WHERE user_id = $1`,
          [userId]
        );

        const currentSettings = currentResult.rows[0]?.privacy_settings || {};

        // Build updated settings object
        const allowedFields = [
          'privacy_mode',
          'show_email_to_connections',
          'allow_connection_requests',
          'allow_group_invites_from_connections',
          'searchable_by_username',
          'searchable_by_email',
          'searchable_by_name',
          'show_mutual_connections',
          'autoAddPreferences'
        ];

        const updatedSettings = { ...currentSettings };

        for (const field of allowedFields) {
          if (field in updates) {
            updatedSettings[field] = updates[field];
          }
        }

        // Generate connection code if switching to private mode
        if (updatedSettings.privacy_mode === 'private' && !updatedSettings.connection_code) {
          const codeResult = await db.query(`SELECT public.generate_user_connection_code() as code`);
          updatedSettings.connection_code = codeResult.rows[0].code;
        }

        // Update searchable settings based on privacy mode
        if (updatedSettings.privacy_mode === 'private') {
          updatedSettings.searchable_by_username = false;
          updatedSettings.searchable_by_email = false;
          updatedSettings.searchable_by_name = false;
        } else if (updatedSettings.privacy_mode === 'public') {
          updatedSettings.searchable_by_username = true;
          updatedSettings.searchable_by_name = true;
        }

        // Update the database
        const result = await db.query(
          `INSERT INTO user_settings (user_id, privacy_settings, notification_preferences, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE
           SET privacy_settings = $2, updated_at = NOW()
           RETURNING privacy_settings`,
          [userId, JSON.stringify(updatedSettings), DEFAULT_NOTIFICATION_PREFERENCES]
        );

        res.json(result.rows[0].privacy_settings);
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
            SELECT u.id, u.username,
                   -- Only show full_name based on privacy settings and connection status
                   CASE
                     WHEN us.privacy_settings->>'privacy_mode' = 'private' AND c.status != 'accepted' THEN NULL
                     ELSE u.full_name
                   END as full_name,
                   -- Only show profile image based on privacy settings
                   CASE
                     WHEN us.privacy_settings->>'privacy_mode' = 'private' AND c.status != 'accepted' THEN NULL
                     ELSE u.profile_image_url
                   END as profile_image_url,
                   us.privacy_settings->>'privacy_mode' as privacy_mode,
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
            LEFT JOIN user_settings us ON us.user_id = u.id
            LEFT JOIN connections c ON c.user_id = $2
              AND c.connection_id = u.id
              AND c.status = 'accepted'
            LEFT JOIN connection_invitations ci ON ci.sender_id = $2
              AND ci.recipient_id = u.id
              AND ci.status = 'pending'
            WHERE u.username ILIKE $1
              AND u.id != $2
              AND ((us.privacy_settings->>'searchable_by_username')::boolean = true OR us.privacy_settings->>'privacy_mode' = 'public')
            LIMIT 20`;
        } else if (searchBy === 'email') {
          searchQuery = `
            SELECT u.id, u.username,
                   -- Only show full_name based on privacy settings and connection status
                   CASE
                     WHEN us.privacy_settings->>'privacy_mode' = 'private' AND c.status != 'accepted' THEN NULL
                     ELSE u.full_name
                   END as full_name,
                   -- Only show profile image based on privacy settings
                   CASE
                     WHEN us.privacy_settings->>'privacy_mode' = 'private' AND c.status != 'accepted' THEN NULL
                     ELSE u.profile_image_url
                   END as profile_image_url,
                   us.privacy_settings->>'privacy_mode' as privacy_mode,
                   CASE
                     WHEN c.status = 'accepted' THEN true
                     ELSE false
                   END as is_connected
            FROM users u
            LEFT JOIN user_settings us ON us.user_id = u.id
            LEFT JOIN connections c ON c.user_id = $2
              AND c.connection_id = u.id
            WHERE u.email = $1
              AND u.id != $2
              AND ((us.privacy_settings->>'searchable_by_email')::boolean = true OR us.privacy_settings->>'privacy_mode' = 'public')
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
    },

    /**
     * Get expiring connection invitations (expiring within 5 days)
     */
    getExpiringInvitations: async (req, res) => {
      const userId = req.user.id;

      try {
        // Get invitations that are expiring within 5 days
        // Both sent and received invitations
        const expiringInvitations = await db.query(
          `SELECT
            ci.*,
            sender.username as sender_username,
            sender.full_name as sender_full_name,
            sender.profile_image_url as sender_profile_image,
            recipient.username as recipient_username,
            recipient.full_name as recipient_full_name,
            recipient.profile_image_url as recipient_profile_image,
            EXTRACT(DAY FROM (ci.expires_at - NOW())) as days_until_expiry,
            CASE
              WHEN ci.sender_id = $1 THEN 'sent'
              WHEN ci.recipient_id = $1 THEN 'received'
            END as invitation_type
          FROM connection_invitations ci
          JOIN users sender ON sender.id = ci.sender_id
          JOIN users recipient ON recipient.id = ci.recipient_id
          WHERE (ci.sender_id = $1 OR ci.recipient_id = $1)
            AND ci.status = 'pending'
            AND ci.expires_at <= NOW() + INTERVAL '5 days'
            AND ci.expires_at > NOW()
          ORDER BY ci.expires_at ASC`,
          [userId]
        );

        // Group invitations by how soon they expire
        const grouped = {
          expiring_today: [],
          expiring_tomorrow: [],
          expiring_soon: [] // 2-5 days
        };

        expiringInvitations.rows.forEach(invitation => {
          const daysLeft = Math.floor(invitation.days_until_expiry);

          // Format the invitation data
          const formattedInvitation = {
            id: invitation.id,
            type: invitation.invitation_type,
            message: invitation.message,
            created_at: invitation.created_at,
            expires_at: invitation.expires_at,
            days_until_expiry: daysLeft,
            sender: {
              id: invitation.sender_id,
              username: invitation.sender_username,
              full_name: invitation.sender_full_name,
              profile_image_url: invitation.sender_profile_image
            },
            recipient: {
              id: invitation.recipient_id,
              username: invitation.recipient_username,
              full_name: invitation.recipient_full_name,
              profile_image_url: invitation.recipient_profile_image
            }
          };

          if (daysLeft === 0) {
            grouped.expiring_today.push(formattedInvitation);
          } else if (daysLeft === 1) {
            grouped.expiring_tomorrow.push(formattedInvitation);
          } else {
            grouped.expiring_soon.push(formattedInvitation);
          }
        });

        res.json({
          total: expiringInvitations.rows.length,
          invitations: grouped
        });
      } catch (error) {
        console.error('Error fetching expiring invitations:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Connect with a user using their connection code
     */
    connectByCode: async (req, res) => {
      const senderId = req.user.id;
      const { connection_code, message } = req.body;

      if (!connection_code) {
        return res.status(400).json({ error: 'Connection code is required' });
      }

      // Normalize the code (uppercase, trim whitespace)
      const normalizedCode = connection_code.toUpperCase().trim();

      try {
        // Find user with this connection code
        const userResult = await db.query(
          `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url,
                  us.privacy_settings
           FROM users u
           JOIN user_settings us ON u.id = us.user_id
           WHERE UPPER(us.privacy_settings->>'connection_code') = $1
             AND u.id != $2`,
          [normalizedCode, senderId]
        );

        if (userResult.rows.length === 0) {
          return res.status(404).json({
            error: 'Invalid connection code or code not found',
            code: 'INVALID_CODE'
          });
        }

        const recipientUser = userResult.rows[0];
        const recipientId = recipientUser.id;

        // Check if the recipient's privacy mode allows connections
        const privacySettings = recipientUser.privacy_settings || {};
        if (privacySettings.privacy_mode === 'ghost') {
          return res.status(403).json({
            error: 'This user is not accepting connection requests',
            code: 'USER_UNAVAILABLE'
          });
        }

        // Check if connection already exists
        const existingConnection = await db.query(
          `SELECT * FROM connections
           WHERE (user_id = $1 AND connected_user_id = $2)
              OR (user_id = $2 AND connected_user_id = $1)`,
          [senderId, recipientId]
        );

        if (existingConnection.rows.length > 0) {
          const connection = existingConnection.rows[0];
          if (connection.status === 'accepted') {
            return res.status(400).json({
              error: 'You are already connected with this user',
              code: 'ALREADY_CONNECTED'
            });
          } else if (connection.status === 'pending') {
            return res.status(400).json({
              error: 'A connection request is already pending',
              code: 'REQUEST_PENDING'
            });
          } else if (connection.status === 'blocked') {
            return res.status(403).json({
              error: 'Unable to send connection request',
              code: 'CONNECTION_BLOCKED'
            });
          }
        }

        // Create connection request
        const connectionResult = await db.query(
          `INSERT INTO connections (user_id, connected_user_id, status, initiated_by, message, created_at, updated_at)
           VALUES ($1, $2, 'pending', $1, $3, NOW(), NOW())
           RETURNING *`,
          [senderId, recipientId, message || `Connection request sent using your connection code: ${normalizedCode}`]
        );

        // Get sender details for the response
        const senderResult = await db.query(
          `SELECT id, username, email, full_name, avatar_url FROM users WHERE id = $1`,
          [senderId]
        );

        // Create notification for the recipient
        await db.query(
          `INSERT INTO notifications (user_id, type, title, message, data, created_at)
           VALUES ($1, 'connection_request', 'New Connection Request', $2, $3, NOW())`,
          [
            recipientId,
            `${senderResult.rows[0].full_name || senderResult.rows[0].username} used your connection code to send you a connection request`,
            JSON.stringify({
              connection_id: connectionResult.rows[0].id,
              sender_id: senderId,
              sender_name: senderResult.rows[0].full_name || senderResult.rows[0].username,
              sender_username: senderResult.rows[0].username,
              sender_avatar: senderResult.rows[0].avatar_url,
              used_connection_code: true,
              message: message
            })
          ]
        );

        res.status(201).json({
          success: true,
          message: 'Connection request sent successfully',
          connection: {
            id: connectionResult.rows[0].id,
            status: 'pending',
            recipient: {
              id: recipientUser.id,
              username: recipientUser.username,
              full_name: recipientUser.full_name,
              avatar_url: recipientUser.avatar_url
            },
            created_at: connectionResult.rows[0].created_at
          }
        });
      } catch (error) {
        console.error('Error connecting by code:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Get connection request history for the current user
     */
    getRequestHistory: async (req, res) => {
      const userId = req.user.id;
      const { type = 'sent' } = req.query; // 'sent', 'received', 'all'

      try {
        let query;
        let params = [userId];

        if (type === 'sent') {
          // Get requests sent by the user with history
          query = `
            SELECT
              ucr.id,
              ucr.recipient_id as user_id,
              u.username,
              u.full_name,
              u.profile_image_url,
              ucr.status,
              ucr.message,
              ucr.created_at,
              ucr.responded_at,
              ucr.decline_type,
              ucr.decline_message,
              ucr.total_attempts,
              ucr.declined_count,
              ucr.is_soft_blocked,
              ucr.show_declined_status,
              ucr.can_retry_after
            FROM user_connection_requests ucr
            JOIN users u ON u.id = ucr.recipient_id
            WHERE ucr.sender_id = $1
            ORDER BY ucr.created_at DESC
            LIMIT 50`;
        } else if (type === 'received') {
          // Get requests received by the user
          query = `
            SELECT
              ucr.id,
              ucr.sender_id as user_id,
              u.username,
              u.full_name,
              u.profile_image_url,
              ucr.status,
              ucr.message,
              ucr.created_at,
              ucr.responded_at,
              ucr.decline_type,
              ucr.total_attempts,
              ucr.declined_count
            FROM user_connection_requests ucr
            JOIN users u ON u.id = ucr.sender_id
            WHERE ucr.recipient_id = $1
            ORDER BY ucr.created_at DESC
            LIMIT 50`;
        } else {
          // Get all request history
          query = `
            SELECT * FROM (
              SELECT
                ucr.id,
                'sent' as direction,
                ucr.recipient_id as user_id,
                u.username,
                u.full_name,
                ucr.status,
                ucr.created_at,
                ucr.total_attempts,
                ucr.declined_count,
                ucr.can_retry_after
              FROM user_connection_requests ucr
              JOIN users u ON u.id = ucr.recipient_id
              WHERE ucr.sender_id = $1

              UNION ALL

              SELECT
                ucr.id,
                'received' as direction,
                ucr.sender_id as user_id,
                u.username,
                u.full_name,
                ucr.status,
                ucr.created_at,
                ucr.total_attempts,
                ucr.declined_count,
                NULL as can_retry_after
              FROM user_connection_requests ucr
              JOIN users u ON u.id = ucr.sender_id
              WHERE ucr.recipient_id = $1
            ) combined
            ORDER BY created_at DESC
            LIMIT 100`;
        }

        const result = await db.query(query, params);

        res.json({
          history: result.rows,
          type
        });
      } catch (error) {
        console.error('Error fetching request history:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    /**
     * Check if a user can send a connection request
     */
    canSendRequest: async (req, res) => {
      const senderId = req.user.id;
      const { recipientId } = req.params;

      if (!recipientId) {
        return res.status(400).json({ error: 'Recipient ID is required' });
      }

      try {
        const result = await db.query(
          `SELECT * FROM public.can_send_connection_request($1, $2)`,
          [senderId, recipientId]
        );

        const canSend = result.rows[0];

        res.json({
          canSend: canSend.can_send,
          reason: canSend.reason,
          retryAfter: canSend.retry_after,
          attemptCount: canSend.attempt_count,
          declinedCount: canSend.declined_count
        });
      } catch (error) {
        console.error('Error checking if can send request:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  };

  return ConnectionsController;
}

module.exports = connectionsControllerFactory;
