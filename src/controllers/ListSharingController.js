const db = require('../config/db');
const { logger } = require('../utils/logger');

/**
 * Controller for Phase 3: List Sharing with Groups
 * Handles list invitations, sharing, and permission management
 */
class ListSharingController {
  /**
   * Send a list invitation to a connected user
   * POST /api/lists/:listId/invitations
   */
  async sendListInvitation(req, res) {
    const userId = req.user.id;
    const { listId } = req.params;
    const { inviteeId, role = 'viewer', message } = req.body;

    try {
      // Validate required fields
      if (!inviteeId) {
        return res.status(400).json({
          error: 'Invitee ID is required'
        });
      }

      if (!['viewer', 'commenter', 'editor', 'admin', 'reserver'].includes(role)) {
        return res.status(400).json({
          error: 'Invalid role. Must be: viewer, commenter, editor, admin, or reserver'
        });
      }

      // Check if user can invite to this list
      const canInviteResult = await db.query(
        'SELECT can_invite_to_list($1, $2) as can_invite',
        [userId, listId]
      );

      if (!canInviteResult.rows[0]?.can_invite) {
        return res.status(403).json({
          error: 'You do not have permission to invite users to this list'
        });
      }

      // Check if users are connected
      const areConnectedResult = await db.query(
        'SELECT are_users_connected($1, $2) as connected',
        [userId, inviteeId]
      );

      if (!areConnectedResult.rows[0]?.connected) {
        return res.status(400).json({
          error: 'You can only invite connected users to collaborate on lists',
          requiresConnection: true,
          userId: inviteeId
        });
      }

      // Check if invitation already exists
      const existingInvitation = await db.query(
        `SELECT id, status, expires_at
         FROM list_invitations
         WHERE list_id = $1 AND invitee_id = $2`,
        [listId, inviteeId]
      );

      if (existingInvitation.rows.length > 0) {
        const invitation = existingInvitation.rows[0];

        if (invitation.status === 'pending') {
          return res.status(409).json({
            error: 'An invitation has already been sent to this user',
            expiresAt: invitation.expires_at
          });
        }

        if (invitation.status === 'accepted') {
          return res.status(409).json({
            error: 'This user has already accepted an invitation to this list'
          });
        }
      }

      // Get list details for the response
      const listResult = await db.query(
        'SELECT title, owner_id FROM lists WHERE id = $1',
        [listId]
      );

      if (listResult.rows.length === 0) {
        return res.status(404).json({
          error: 'List not found'
        });
      }

      const list = listResult.rows[0];

      // Create the invitation
      const invitationResult = await db.query(
        `INSERT INTO list_invitations
         (list_id, inviter_id, invitee_id, role, message)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [listId, userId, inviteeId, role, message]
      );

      const invitation = invitationResult.rows[0];

      // Get invitee details
      const inviteeResult = await db.query(
        'SELECT username, full_name FROM users WHERE id = $1',
        [inviteeId]
      );

      res.status(201).json({
        success: true,
        invitation: {
          id: invitation.id,
          listId: invitation.list_id,
          listTitle: list.title,
          inviteeId: invitation.invitee_id,
          inviteeName: inviteeResult.rows[0]?.full_name || inviteeResult.rows[0]?.username,
          role: invitation.role,
          message: invitation.message,
          invitationCode: invitation.invitation_code,
          expiresAt: invitation.expires_at,
          createdAt: invitation.created_at
        }
      });

    } catch (error) {
      logger.error('Error sending list invitation:', error);
      res.status(500).json({
        error: 'Failed to send list invitation'
      });
    }
  }

  /**
   * Get pending list invitations for the current user
   * Includes both group-based and individual invitations
   * GET /api/lists/invitations/pending
   */
  async getPendingInvitations(req, res) {
    const userId = req.user.id;

    try {
      // Get direct list invitations (not group-based)
      const groupInvitations = await db.query(
        `SELECT
          li.id,
          li.list_id,
          li.role,
          li.message,
          li.invitation_code,
          li.expires_at,
          li.created_at,
          l.title as list_title,
          l.description as list_description,
          l.list_type,
          u.username as inviter_username,
          u.full_name as inviter_name,
          u.profile_image_url as inviter_avatar,
          'direct' as invitation_type,
          NULL as group_id,
          NULL as group_name,
          EXTRACT(DAY FROM (li.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry
        FROM list_invitations li
        JOIN lists l ON l.id = li.list_id
        JOIN users u ON u.id = li.inviter_id
        WHERE li.invitee_id = $1
        AND li.status = 'pending'
        AND li.expires_at > CURRENT_TIMESTAMP`,
        [userId]
      );

      // Get individual pending list invitations
      const individualInvitations = await db.query(
        `SELECT
          pli.id,
          pli.list_id,
          pli.role,
          pli.message,
          pli.invitation_code,
          pli.expires_at,
          pli.created_at,
          l.title as list_title,
          l.description as list_description,
          l.list_type,
          u.username as inviter_username,
          u.full_name as inviter_name,
          u.profile_image_url as inviter_avatar,
          'individual' as invitation_type,
          pli.invitation_context,
          CASE WHEN pli.invitation_context = 'connection_required' THEN true ELSE false END as requires_connection,
          pli.connection_invitation_id,
          EXTRACT(DAY FROM (pli.expires_at - CURRENT_TIMESTAMP))::INTEGER as days_until_expiry
        FROM pending_list_invitations pli
        JOIN lists l ON l.id = pli.list_id
        JOIN users u ON u.id = pli.inviter_id
        WHERE pli.invitee_id = $1
        AND pli.status = 'pending'
        AND pli.expires_at > CURRENT_TIMESTAMP`,
        [userId]
      );

      // Combine both types of invitations
      const allInvitations = [
        ...groupInvitations.rows,
        ...individualInvitations.rows
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      res.json({
        success: true,
        invitations: allInvitations
      });

    } catch (error) {
      logger.error('Error getting pending invitations:', error);
      res.status(500).json({
        error: 'Failed to get pending invitations'
      });
    }
  }

  /**
   * Get sent list invitations
   * GET /api/lists/invitations/sent
   */
  async getSentInvitations(req, res) {
    const userId = req.user.id;

    try {
      const result = await db.query(
        `SELECT
          li.id,
          li.list_id,
          li.invitee_id,
          li.role,
          li.message,
          li.status,
          li.invitation_code,
          li.expires_at,
          li.created_at,
          li.accepted_at,
          li.declined_at,
          l.title as list_title,
          u.username as invitee_username,
          u.full_name as invitee_name,
          u.profile_image_url as invitee_avatar
        FROM list_invitations li
        JOIN lists l ON l.id = li.list_id
        JOIN users u ON u.id = li.invitee_id
        WHERE li.inviter_id = $1
        ORDER BY li.created_at DESC`,
        [userId]
      );

      res.json({
        success: true,
        invitations: result.rows
      });

    } catch (error) {
      logger.error('Error getting sent invitations:', error);
      res.status(500).json({
        error: 'Failed to get sent invitations'
      });
    }
  }

  /**
   * Accept a list invitation (both group-based and individual)
   * POST /api/lists/invitations/:id/accept
   */
  async acceptInvitation(req, res) {
    const userId = req.user.id;
    const { id } = req.params;

    try {
      // First check if it's a group-based invitation
      const groupInvitation = await db.query(
        `SELECT li.*, l.title as list_title
         FROM list_invitations li
         JOIN lists l ON l.id = li.list_id
         WHERE li.id = $1 AND li.invitee_id = $2`,
        [id, userId]
      );

      if (groupInvitation.rows.length > 0) {
        // Handle group-based invitation
        await db.query(
          'SELECT accept_list_invitation($1, $2)',
          [id, userId]
        );

        res.json({
          success: true,
          message: 'List invitation accepted successfully',
          invitation: groupInvitation.rows[0]
        });
      } else {
        // Check if it's an individual invitation
        const individualInvitation = await db.query(
          `SELECT pli.*, l.name as list_title
           FROM pending_list_invitations pli
           JOIN lists l ON l.id = pli.list_id
           WHERE pli.id = $1 AND pli.invitee_id = $2 AND pli.status = 'pending'`,
          [id, userId]
        );

        if (individualInvitation.rows.length === 0) {
          return res.status(404).json({
            error: 'Invitation not found or already processed'
          });
        }

        const invitation = individualInvitation.rows[0];

        // Apply the list share
        await db.query(
          `INSERT INTO list_user_overrides (list_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (list_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP`,
          [invitation.list_id, userId, invitation.role, invitation.permissions]
        );

        // Mark invitation as accepted
        await db.query(
          `UPDATE pending_list_invitations
           SET status = 'accepted', responded_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );

        // Create notifications
        await db.query(
          `INSERT INTO notifications (user_id, notification_type, title, body, data, is_read)
           VALUES ($1, 'list_share_accepted', 'List share accepted', $2, $3::jsonb, false)`,
          [
            invitation.inviter_id,
            `${req.user.username || 'Someone'} accepted your list share invitation`,
            JSON.stringify({
              list_id: invitation.list_id,
              invitee_id: userId,
              role: invitation.role
            })
          ]
        );

        res.json({
          success: true,
          message: 'List invitation accepted successfully',
          invitation: {
            ...invitation,
            list_title: invitation.list_title
          }
        });
      }

    } catch (error) {
      logger.error('Error accepting invitation:', error);

      if (error.message?.includes('Invalid or expired')) {
        return res.status(400).json({
          error: 'Invalid or expired invitation'
        });
      }

      res.status(500).json({
        error: 'Failed to accept invitation'
      });
    }
  }

  /**
   * Decline a list invitation (both group-based and individual)
   * POST /api/lists/invitations/:id/decline
   */
  async declineInvitation(req, res) {
    const userId = req.user.id;
    const { id } = req.params;

    try {
      // Try to decline group-based invitation first
      const groupResult = await db.query(
        `UPDATE list_invitations
         SET status = 'declined',
             declined_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         AND invitee_id = $2
         AND status = 'pending'
         RETURNING *`,
        [id, userId]
      );

      if (groupResult.rows.length > 0) {
        res.json({
          success: true,
          message: 'List invitation declined'
        });
      } else {
        // Try to decline individual invitation
        const individualResult = await db.query(
          `UPDATE pending_list_invitations
           SET status = 'declined',
               responded_at = CURRENT_TIMESTAMP
           WHERE id = $1
           AND invitee_id = $2
           AND status = 'pending'
           RETURNING *`,
          [id, userId]
        );

        if (individualResult.rows.length === 0) {
          return res.status(404).json({
            error: 'Invitation not found or already processed'
          });
        }

        // Notify the inviter
        const invitation = individualResult.rows[0];
        await db.query(
          `INSERT INTO notifications (user_id, notification_type, title, body, data, is_read)
           VALUES ($1, 'list_share_declined', 'List share declined', $2, $3::jsonb, false)`,
          [
            invitation.inviter_id,
            `${req.user.username || 'Someone'} declined your list share invitation`,
            JSON.stringify({
              list_id: invitation.list_id,
              invitee_id: userId
            })
          ]
        );

        res.json({
          success: true,
          message: 'List invitation declined'
        });
      }

    } catch (error) {
      logger.error('Error declining invitation:', error);
      res.status(500).json({
        error: 'Failed to decline invitation'
      });
    }
  }

  /**
   * Cancel a sent list invitation
   * DELETE /api/lists/invitations/:id/cancel
   */
  async cancelInvitation(req, res) {
    const userId = req.user.id;
    const { id } = req.params;

    try {
      const result = await db.query(
        `UPDATE list_invitations
         SET status = 'cancelled',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         AND inviter_id = $2
         AND status = 'pending'
         RETURNING *`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Invitation not found or cannot be cancelled'
        });
      }

      res.json({
        success: true,
        message: 'List invitation cancelled'
      });

    } catch (error) {
      logger.error('Error cancelling invitation:', error);
      res.status(500).json({
        error: 'Failed to cancel invitation'
      });
    }
  }

  /**
   * Share a list with a user directly
   * POST /api/lists/:listId/share/user
   */
  async shareWithUser(req, res) {
    const userId = req.user.id;
    const { listId } = req.params;
    const { targetUserId, role = 'viewer' } = req.body;

    try {
      // Validate role
      if (!['viewer', 'commenter', 'editor', 'admin', 'reserver'].includes(role)) {
        return res.status(400).json({
          error: 'Invalid role'
        });
      }

      // Check permission to share
      const canShareResult = await db.query(
        'SELECT can_invite_to_list($1, $2) as can_share',
        [userId, listId]
      );

      if (!canShareResult.rows[0]?.can_share) {
        return res.status(403).json({
          error: 'You do not have permission to share this list'
        });
      }

      // Check connection
      const areConnectedResult = await db.query(
        'SELECT are_users_connected($1, $2) as connected',
        [userId, targetUserId]
      );

      if (!areConnectedResult.rows[0]?.connected) {
        return res.status(400).json({
          error: 'You can only share lists with connected users',
          requiresConnection: true,
          userId: targetUserId
        });
      }

      // Create user override
      await db.query(
        `INSERT INTO list_user_overrides (list_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (list_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP`,
        [listId, targetUserId, role]
      );

      // Record the share
      await db.query(
        `INSERT INTO list_shares (list_id, shared_by, shared_with_type, shared_with_id, role)
         VALUES ($1, $2, 'user', $3, $4)
         ON CONFLICT (list_id, shared_with_type, shared_with_id)
         DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP`,
        [listId, userId, targetUserId, role]
      );

      res.json({
        success: true,
        message: 'List shared successfully',
        share: {
          listId,
          sharedWithUserId: targetUserId,
          role
        }
      });

    } catch (error) {
      logger.error('Error sharing list with user:', error);
      res.status(500).json({
        error: 'Failed to share list'
      });
    }
  }

  /**
   * Share a list with a group
   * POST /api/lists/:listId/share/group
   */
  async shareWithGroup(req, res) {
    const userId = req.user.id;
    const { listId } = req.params;
    const { groupId, role = 'viewer' } = req.body;

    try {
      // Validate role
      if (!['viewer', 'commenter', 'editor', 'admin', 'reserver'].includes(role)) {
        return res.status(400).json({
          error: 'Invalid role'
        });
      }

      // Check permission to share
      const canShareResult = await db.query(
        'SELECT can_invite_to_list($1, $2) as can_share',
        [userId, listId]
      );

      if (!canShareResult.rows[0]?.can_share) {
        return res.status(403).json({
          error: 'You do not have permission to share this list'
        });
      }

      // Check if user is a member of the group
      const membershipResult = await db.query(
        `SELECT role FROM group_members
         WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
      );

      if (membershipResult.rows.length === 0) {
        return res.status(403).json({
          error: 'You must be a member of the group to share lists with it'
        });
      }

      // Create or update group role
      await db.query(
        `INSERT INTO list_group_roles (list_id, group_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (list_id, group_id)
         DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP`,
        [listId, groupId, role]
      );

      // Record the share
      await db.query(
        `INSERT INTO list_shares (list_id, shared_by, shared_with_type, shared_with_id, role)
         VALUES ($1, $2, 'group', $3, $4)
         ON CONFLICT (list_id, shared_with_type, shared_with_id)
         DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP`,
        [listId, userId, groupId, role]
      );

      res.json({
        success: true,
        message: 'List shared with group successfully',
        share: {
          listId,
          sharedWithGroupId: groupId,
          role
        }
      });

    } catch (error) {
      logger.error('Error sharing list with group:', error);
      res.status(500).json({
        error: 'Failed to share list with group'
      });
    }
  }

  /**
   * Get all shares for a list
   * GET /api/lists/:listId/shares
   */
  async getListShares(req, res) {
    const userId = req.user.id;
    const { listId } = req.params;

    try {
      // Check if user has permission to view shares
      const permissionResult = await db.query(
        `SELECT
          CASE
            WHEN l.owner_id = $1 THEN TRUE
            WHEN EXISTS (
              SELECT 1 FROM list_user_overrides
              WHERE list_id = $2 AND user_id = $1 AND role IN ('admin', 'editor')
            ) THEN TRUE
            ELSE FALSE
          END as can_view_shares
        FROM lists l
        WHERE l.id = $2`,
        [userId, listId]
      );

      if (!permissionResult.rows[0]?.can_view_shares) {
        return res.status(403).json({
          error: 'You do not have permission to view shares for this list'
        });
      }

      // Get all shares
      const sharesResult = await db.query(
        `SELECT
          ls.*,
          CASE
            WHEN ls.shared_with_type = 'user' THEN u.username
            WHEN ls.shared_with_type = 'group' THEN g.name
          END as shared_with_name,
          CASE
            WHEN ls.shared_with_type = 'user' THEN u.full_name
            WHEN ls.shared_with_type = 'group' THEN g.description
          END as shared_with_description,
          sharer.username as shared_by_username,
          sharer.full_name as shared_by_name
        FROM list_shares ls
        LEFT JOIN users u ON ls.shared_with_type = 'user' AND u.id = ls.shared_with_id
        LEFT JOIN collaboration_groups g ON ls.shared_with_type = 'group' AND g.id = ls.shared_with_id
        JOIN users sharer ON sharer.id = ls.shared_by
        WHERE ls.list_id = $1 AND ls.revoked_at IS NULL
        ORDER BY ls.created_at DESC`,
        [listId]
      );

      res.json({
        success: true,
        shares: sharesResult.rows
      });

    } catch (error) {
      logger.error('Error getting list shares:', error);
      res.status(500).json({
        error: 'Failed to get list shares'
      });
    }
  }

  /**
   * Revoke a list share
   * DELETE /api/lists/:listId/shares/:shareId
   */
  async revokeShare(req, res) {
    const userId = req.user.id;
    const { listId, shareId } = req.params;

    try {
      // Check permission to revoke
      const canRevokeResult = await db.query(
        'SELECT can_invite_to_list($1, $2) as can_revoke',
        [userId, listId]
      );

      if (!canRevokeResult.rows[0]?.can_revoke) {
        return res.status(403).json({
          error: 'You do not have permission to revoke shares for this list'
        });
      }

      // Revoke the share
      const revokeResult = await db.query(
        `UPDATE list_shares
         SET revoked_at = CURRENT_TIMESTAMP,
             revoked_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND list_id = $3 AND revoked_at IS NULL
         RETURNING *`,
        [userId, shareId, listId]
      );

      if (revokeResult.rows.length === 0) {
        return res.status(404).json({
          error: 'Share not found or already revoked'
        });
      }

      const share = revokeResult.rows[0];

      // Remove the corresponding permission
      if (share.shared_with_type === 'user') {
        await db.query(
          'DELETE FROM list_user_overrides WHERE list_id = $1 AND user_id = $2',
          [listId, share.shared_with_id]
        );
      } else if (share.shared_with_type === 'group') {
        await db.query(
          'DELETE FROM list_group_roles WHERE list_id = $1 AND group_id = $2',
          [listId, share.shared_with_id]
        );
      }

      res.json({
        success: true,
        message: 'Share revoked successfully'
      });

    } catch (error) {
      logger.error('Error revoking share:', error);
      res.status(500).json({
        error: 'Failed to revoke share'
      });
    }
  }

  /**
   * Get lists shared with the current user
   * GET /api/lists/shared-with-me
   */
  async getSharedWithMe(req, res) {
    const userId = req.user.id;

    try {
      const result = await db.query(
        `SELECT DISTINCT
          l.*,
          COALESCE(luo.role, lgr.role) as my_role,
          owner.username as owner_username,
          owner.full_name as owner_name,
          owner.profile_image_url as owner_avatar
        FROM lists l
        JOIN users owner ON owner.id = l.owner_id
        LEFT JOIN list_user_overrides luo ON luo.list_id = l.id AND luo.user_id = $1
        LEFT JOIN list_group_roles lgr ON lgr.list_id = l.id
        LEFT JOIN group_members gm ON gm.group_id = lgr.group_id AND gm.user_id = $1
        WHERE (luo.user_id = $1 OR gm.user_id = $1)
        AND l.owner_id != $1
        AND l.deleted_at IS NULL
        ORDER BY l.updated_at DESC`,
        [userId]
      );

      res.json({
        success: true,
        lists: result.rows
      });

    } catch (error) {
      logger.error('Error getting shared lists:', error);
      res.status(500).json({
        error: 'Failed to get shared lists'
      });
    }
  }

  /**
   * Get user's permissions for a list
   * GET /api/lists/:listId/permissions
   */
  async getMyPermissions(req, res) {
    const userId = req.user.id;
    const { listId } = req.params;

    try {
      const result = await db.query(
        `SELECT
          l.id,
          l.title,
          l.owner_id,
          CASE
            WHEN l.owner_id = $1 THEN 'owner'
            WHEN luo.role IS NOT NULL THEN luo.role
            WHEN lgr.role IS NOT NULL THEN lgr.role
            ELSE NULL
          END as role,
          CASE
            WHEN l.owner_id = $1 THEN 'owner'
            WHEN luo.role IS NOT NULL THEN 'user_override'
            WHEN lgr.role IS NOT NULL THEN 'group_member'
            ELSE NULL
          END as permission_source
        FROM lists l
        LEFT JOIN list_user_overrides luo ON luo.list_id = l.id AND luo.user_id = $1
        LEFT JOIN list_group_roles lgr ON lgr.list_id = l.id
        LEFT JOIN group_members gm ON gm.group_id = lgr.group_id AND gm.user_id = $1
        WHERE l.id = $2`,
        [userId, listId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'List not found'
        });
      }

      const permissions = result.rows[0];

      if (!permissions.role) {
        return res.status(403).json({
          error: 'You do not have access to this list'
        });
      }

      res.json({
        success: true,
        permissions
      });

    } catch (error) {
      logger.error('Error getting permissions:', error);
      res.status(500).json({
        error: 'Failed to get permissions'
      });
    }
  }

  /**
   * Get list collaborators
   * GET /api/lists/:listId/collaborators
   */
  async getCollaborators(req, res) {
    const userId = req.user.id;
    const { listId } = req.params;

    try {
      // Check if user has access to view collaborators
      const accessResult = await db.query(
        `SELECT EXISTS (
          SELECT 1 FROM lists WHERE id = $1 AND owner_id = $2
          UNION
          SELECT 1 FROM list_user_overrides WHERE list_id = $1 AND user_id = $2
          UNION
          SELECT 1 FROM list_group_roles lgr
          JOIN group_members gm ON gm.group_id = lgr.group_id
          WHERE lgr.list_id = $1 AND gm.user_id = $2
        ) as has_access`,
        [listId, userId]
      );

      if (!accessResult.rows[0]?.has_access) {
        return res.status(403).json({
          error: 'You do not have access to view collaborators'
        });
      }

      // Get all collaborators
      const collaboratorsResult = await db.query(
        `SELECT
          u.id,
          u.username,
          u.full_name,
          u.profile_image_url,
          'direct' as access_type,
          luo.role,
          luo.created_at as granted_at
        FROM list_user_overrides luo
        JOIN users u ON u.id = luo.user_id
        WHERE luo.list_id = $1

        UNION

        SELECT DISTINCT
          u.id,
          u.username,
          u.full_name,
          u.profile_image_url,
          'group' as access_type,
          lgr.role,
          gm.created_at as granted_at
        FROM list_group_roles lgr
        JOIN group_members gm ON gm.group_id = lgr.group_id
        JOIN users u ON u.id = gm.user_id
        WHERE lgr.list_id = $1

        ORDER BY granted_at DESC`,
        [listId]
      );

      // Get owner info
      const ownerResult = await db.query(
        `SELECT
          u.id,
          u.username,
          u.full_name,
          u.profile_image_url
        FROM lists l
        JOIN users u ON u.id = l.owner_id
        WHERE l.id = $1`,
        [listId]
      );

      res.json({
        success: true,
        owner: ownerResult.rows[0],
        collaborators: collaboratorsResult.rows
      });

    } catch (error) {
      logger.error('Error getting collaborators:', error);
      res.status(500).json({
        error: 'Failed to get collaborators'
      });
    }
  }
}

module.exports = new ListSharingController();