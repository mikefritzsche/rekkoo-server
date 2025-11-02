const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

function createGroupInvitationsController(socketService) {
  class GroupInvitationsController {
    constructor() {
      this.socketService = socketService;
    }

    // Send a group invitation to a connected user
    sendInvitation = async (req, res) => {
      const { groupId } = req.params;
      const { inviteeId, message } = req.body;
      const inviterId = req.user?.id;

      if (!inviteeId) {
        return res.status(400).json({ error: 'Invitee ID is required' });
      }

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        // Call the cascade function that handles both connected and non-connected users
        const result = await client.query(
          `SELECT * FROM invite_user_to_group_cascade($1, $2, $3, $4)`,
          [groupId, inviterId, inviteeId, message]
        );

        if (!result.rows[0].success) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: result.rows[0].message
          });
        }

        await client.query('COMMIT');

        // Get group and inviter details for the response
        const groupDetails = await client.query(
          `SELECT g.name, g.description, u.username as inviter_username, u.username as inviter_name
           FROM collaboration_groups g
           JOIN users u ON u.id = $2
           WHERE g.id = $1`,
          [groupId, inviterId]
        );

        const invitationResult = result.rows[0];
        const responseData = {
          invitation_type: invitationResult.invitation_type,
          invitation_id: invitationResult.invitation_id,
          group: {
            id: groupId,
            name: groupDetails.rows[0].name,
            description: groupDetails.rows[0].description
          },
          inviter: {
            id: inviterId,
            username: groupDetails.rows[0].inviter_username,
            name: groupDetails.rows[0].inviter_name
          },
          invitee_id: inviteeId
        };

        // Customize message based on invitation type
        let responseMessage = invitationResult.message;
        if (invitationResult.invitation_type === 'connection_request') {
          responseMessage = `Connection request sent. The user will be invited to ${groupDetails.rows[0].name} once they accept your connection.`;
        }

        // Emit socket event for real-time notification if it's a direct group invitation
        if (invitationResult.invitation_type === 'group_invitation' && this.socketService) {
          console.log(`[GroupInvitations] Emitting group:invitation event to user ${inviteeId}`);

          // Format the event data to match what the app expects
          const eventData = {
            invitation: {
              id: invitationResult.invitation_id,
              group_id: groupId,
              inviter_id: inviterId,
              invitee_id: inviteeId,
              status: 'pending',
              message: message,
              created_at: new Date().toISOString()
            },
            group: {
              id: groupId,
              name: groupDetails.rows[0].name
            },
            inviter: {
              id: inviterId,
              username: groupDetails.rows[0].inviter_username,
              full_name: groupDetails.rows[0].inviter_name
            }
          };

          this.socketService.notifyUser(inviteeId, 'group:invitation', eventData);
        }

        res.status(201).json({
          message: responseMessage,
          ...responseData
        });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error sending group invitation:', error);
        res.status(500).json({ error: 'Failed to send invitation' });
      } finally {
        client.release();
      }
    }

    // Get pending invitations for the current user
    getPendingInvitations = async (req, res) => {
      const userId = req.user?.id;

      try {
        const result = await db.pool.query(
          `SELECT
          gi.*,
          g.name as group_name,
          g.description as group_description,
          u.username as inviter_username,
          u.username as inviter_name,
          (SELECT COUNT(*) FROM collaboration_group_members WHERE group_id = gi.group_id) as member_count
         FROM group_invitations gi
         JOIN collaboration_groups g ON g.id = gi.group_id
         JOIN users u ON u.id = gi.inviter_id
         WHERE gi.invitee_id = $1
         AND gi.status = 'pending'
         AND gi.expires_at > CURRENT_TIMESTAMP
         ORDER BY gi.created_at DESC`,
          [userId]
        );

        res.json({
          invitations: result.rows
        });
      } catch (error) {
        console.error('Error fetching pending invitations:', error);
        res.status(500).json({ error: 'Failed to fetch pending invitations' });
      }
    }

    // Get invitations sent by the current user (both direct and pending)
    getSentInvitations = async (req, res) => {
      const userId = req.user?.id;

      try {
        // Query both group_invitations and pending_group_invitations
        const result = await db.pool.query(
          `WITH all_invitations AS (
          -- Direct invitations already sent
          SELECT
            gi.id,
            gi.group_id,
            gi.inviter_id,
            gi.invitee_id,
            gi.status,
            gi.message,
            gi.created_at,
            gi.expires_at,
            'sent' as invitation_type,
            NULL::UUID as connection_invitation_id
          FROM group_invitations gi
          WHERE gi.inviter_id = $1

          UNION ALL

          -- Pending invitations waiting for connection
          SELECT
            pgi.id,
            pgi.group_id,
            pgi.inviter_id,
            pgi.invitee_id,
            CASE
              WHEN pgi.status = 'waiting' THEN 'pending_connection'
              ELSE pgi.status
            END as status,
            pgi.message,
            pgi.created_at,
            CURRENT_TIMESTAMP + INTERVAL '30 days' as expires_at,
            'pending' as invitation_type,
            pgi.connection_invitation_id
          FROM pending_group_invitations pgi
          WHERE pgi.inviter_id = $1
            AND pgi.status != 'processed'
        )
        SELECT
          ai.*,
          g.name as group_name,
          g.description as group_description,
          u.username as invitee_username,
          u.username as invitee_name,
          CASE
            WHEN ai.invitation_type = 'pending' AND ci.id IS NOT NULL THEN
              CASE
                WHEN ci.status = 'pending' THEN 'Connection request pending'
                WHEN ci.status = 'declined' THEN 'Connection request declined'
                ELSE ci.status
              END
            ELSE NULL
          END as connection_status
        FROM all_invitations ai
        JOIN collaboration_groups g ON g.id = ai.group_id
        JOIN users u ON u.id = ai.invitee_id
        LEFT JOIN connection_invitations ci ON ci.id = ai.connection_invitation_id
        ORDER BY ai.created_at DESC
        LIMIT 50`,
          [userId]
        );

        res.json({
          invitations: result.rows
        });
      } catch (error) {
        console.error('Error fetching sent invitations:', error);
        res.status(500).json({ error: 'Failed to fetch sent invitations' });
      }
    }

    // Get invitations for a specific group
    getGroupInvitations = async (req, res) => {
      const { groupId } = req.params;
      const userId = req.user?.id;

      try {
        // First check if user is a member or owner of the group
        const accessCheck = await db.pool.query(
          `SELECT 1
           FROM collaboration_groups g
           LEFT JOIN collaboration_group_members m
             ON m.group_id = g.id
            AND m.user_id = $2
           WHERE g.id = $1
             AND (g.owner_id = $2 OR m.user_id IS NOT NULL)`,
          [groupId, userId]
        );

        if (accessCheck.rows.length === 0) {
          return res.status(403).json({
            error: 'You must be a member of the group to view invitations'
          });
        }

        const result = await db.pool.query(
          `SELECT
          gi.*,
          u.username as invitee_username,
          u.username as invitee_name,
          inviter.username as inviter_username,
          inviter.username as inviter_name
         FROM group_invitations gi
         JOIN users u ON u.id = gi.invitee_id
         JOIN users inviter ON inviter.id = gi.inviter_id
         WHERE gi.group_id = $1
         ORDER BY gi.created_at DESC`,
          [groupId]
        );

        res.json({
          invitations: result.rows
        });
      } catch (error) {
        console.error('Error fetching group invitations:', error);
        res.status(500).json({ error: 'Failed to fetch group invitations' });
      }
    }

    // Accept a group invitation
    acceptInvitation = async (req, res) => {
      const { invitationId } = req.params;
      const userId = req.user?.id;

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');

        // Get the invitation
        const invitation = await client.query(
          `SELECT * FROM group_invitations
           WHERE id = $1 AND invitee_id = $2 AND status = 'pending'`,
          [invitationId, userId]
        );

        if (invitation.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({
            error: 'Invitation not found or already processed'
          });
        }

        const inv = invitation.rows[0];

        // Add user to group
        await client.query(
          `INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
           VALUES ($1, $2, 'member', CURRENT_TIMESTAMP)
           ON CONFLICT (group_id, user_id) DO NOTHING`,
          [inv.group_id, userId]
        );

        // Update invitation status
        await client.query(
          `UPDATE group_invitations
           SET status = 'accepted', responded_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [invitationId]
        );

        await client.query('COMMIT');

        res.json({
          message: 'Successfully joined the group',
          group_id: inv.group_id
        });
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error accepting invitation:', error);
        res.status(500).json({ error: 'Failed to accept invitation' });
      } finally {
        client.release();
      }
    }

    // Decline a group invitation
    declineInvitation = async (req, res) => {
      const { invitationId } = req.params;
      const userId = req.user?.id;

      try {
        const result = await db.pool.query(
          `UPDATE group_invitations
           SET status = 'declined', responded_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
           RETURNING group_id`,
          [invitationId, userId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: 'Invitation not found or already processed'
          });
        }

        res.json({
          message: 'Invitation declined'
        });
      } catch (error) {
        console.error('Error declining invitation:', error);
        res.status(500).json({ error: 'Failed to decline invitation' });
      }
    }

    // Cancel a sent invitation
    cancelInvitation = async (req, res) => {
      const { invitationId } = req.params;
      const userId = req.user?.id;

      try {
        // First try to cancel from group_invitations
        let result = await db.pool.query(
          `UPDATE group_invitations
           SET status = 'cancelled', responded_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND inviter_id = $2 AND status = 'pending'
           RETURNING id, group_id, invitee_id`,
          [invitationId, userId]
        );

        // If not found in group_invitations, try pending_group_invitations
        if (result.rows.length === 0) {
          result = await db.pool.query(
            `DELETE FROM pending_group_invitations
             WHERE id = $1 AND inviter_id = $2
             RETURNING id, group_id, invitee_id`,
            [invitationId, userId]
          );

          if (result.rows.length === 0) {
            return res.status(404).json({
              error: 'Invitation not found or you are not authorized to cancel it'
            });
          }

          // Also cancel the associated connection invitation if exists
          const inv = result.rows[0];
          if (inv.connection_invitation_id) {
            await db.pool.query(
              `UPDATE connection_invitations
               SET status = 'cancelled'
               WHERE id = $1`,
              [inv.connection_invitation_id]
            );
          }
        }

        res.json({
          message: 'Invitation cancelled',
          invitation_id: result.rows[0].id
        });
      } catch (error) {
        console.error('Error cancelling invitation:', error);
        res.status(500).json({ error: 'Failed to cancel invitation' });
      }
    }

    // Get invitations that are expiring soon (for notifications)
    getExpiringInvitations = async (req, res) => {
      const userId = req.user?.id;

      try {
        const result = await db.pool.query(
          `SELECT
          gi.*,
          g.name as group_name,
          CASE
            WHEN gi.inviter_id = $1 THEN 'sent'
            ELSE 'received'
          END as invitation_type,
          EXTRACT(EPOCH FROM (gi.expires_at - CURRENT_TIMESTAMP)) / 86400 as days_until_expiry
         FROM group_invitations gi
         JOIN collaboration_groups g ON g.id = gi.group_id
         WHERE (gi.inviter_id = $1 OR gi.invitee_id = $1)
         AND gi.status = 'pending'
         AND gi.expires_at > CURRENT_TIMESTAMP
         AND gi.expires_at < (CURRENT_TIMESTAMP + INTERVAL '5 days')
         ORDER BY gi.expires_at ASC`,
          [userId]
        );

        res.json({
          expiring_invitations: result.rows
        });
      } catch (error) {
        console.error('Error fetching expiring invitations:', error);
        res.status(500).json({ error: 'Failed to fetch expiring invitations' });
      }
    }

    // Resend an invitation (creates a new one with fresh expiry)
    resendInvitation = async (req, res) => {
      const { invitationId } = req.params;
      const userId = req.user?.id;

      try {
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');

          // First check if it's a regular invitation
          let original = await client.query(
            `SELECT * FROM group_invitations
             WHERE id = $1 AND inviter_id = $2`,
            [invitationId, userId]
          );

          if (original.rows.length > 0) {
            // Handle regular group invitation resend without creating duplicates
            const orig = original.rows[0];

            if (orig.status === 'accepted') {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: 'This invitation was already accepted. The user is already a member of the group.'
              });
            }

            // Ensure the invitee is not already a member before resending
            const membershipCheck = await client.query(
              `SELECT 1
               FROM collaboration_group_members
               WHERE group_id = $1 AND user_id = $2
               LIMIT 1`,
              [orig.group_id, orig.invitee_id]
            );

            if (membershipCheck.rows.length > 0) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: 'The invitee is already a member of this group.'
              });
            }

            const updatedInvitation = await client.query(
              `UPDATE group_invitations
               SET status = 'pending',
                   created_at = CURRENT_TIMESTAMP,
                   responded_at = NULL,
                   expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days'
               WHERE id = $1
               RETURNING *`,
              [invitationId]
            );

            await client.query('COMMIT');

            return res.json({
              message: 'Invitation resent successfully',
              invitation: updatedInvitation.rows[0]
            });
          } else {
            // Check if it's a pending group invitation
            original = await client.query(
              `SELECT pgi.*, ci.status as connection_status
               FROM pending_group_invitations pgi
               LEFT JOIN connection_invitations ci ON ci.id = pgi.connection_invitation_id
               WHERE pgi.id = $1 AND pgi.inviter_id = $2`,
              [invitationId, userId]
            );

            if (original.rows.length === 0) {
              await client.query('ROLLBACK');
              return res.status(404).json({
                error: 'Invitation not found or you are not authorized to resend it'
              });
            }

            const orig = original.rows[0];

            // If connection was declined, create a new connection invitation
            if (orig.connection_status === 'declined' || !orig.connection_invitation_id) {
              // Create new connection invitation
              const newConnectionInvitation = await client.query(
                `INSERT INTO connection_invitations
                 (id, sender_id, recipient_id, message, status, invitation_context, metadata, created_at, expires_at)
                 VALUES ($1, $2, $3, $4, 'pending', 'group_invitation', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days')
                 RETURNING id`,
                [
                  uuidv4(),
                  orig.inviter_id,
                  orig.invitee_id,
                  orig.message || 'I would like to invite you to join a group',
                  JSON.stringify({
                    group_id: orig.group_id,
                    group_name: (await client.query('SELECT name FROM collaboration_groups WHERE id = $1', [orig.group_id])).rows[0].name
                  })
                ]
              );

              // Update pending group invitation with new connection invitation ID
              await client.query(
                `UPDATE pending_group_invitations
                 SET connection_invitation_id = $1, created_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [newConnectionInvitation.rows[0].id, invitationId]
              );

              await client.query('COMMIT');

              res.json({
                message: 'Connection request resent. The group invitation will be sent once they accept.',
                connection_invitation_id: newConnectionInvitation.rows[0].id
              });
            } else {
              await client.query('ROLLBACK');
              res.json({
                message: 'Connection request is still pending. Please wait for the user to respond.'
              });
            }
          }
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error resending invitation:', error);
        res.status(500).json({ error: 'Failed to resend invitation' });
      }
    }
  }

  return new GroupInvitationsController();
}

module.exports = createGroupInvitationsController;
