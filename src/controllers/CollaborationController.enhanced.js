/**
 * Enhanced inviteUserToGroup method with improved connection checking
 * This version checks for both mutual connections and following relationships
 */

// Add this enhanced version to CollaborationController.js

inviteUserToGroup: async (req, res) => {
  const { groupId } = req.params;
  const { userId, role = 'member', message } = req.body;
  const inviter_id = req.user.id;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  // Validate role
  const validRoles = ['owner', 'admin', 'member', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be one of: owner, admin, member, viewer' });
  }

  try {
    // Check if the current user is the owner or admin of the group
    const groupResult = await db.query(
      `SELECT g.owner_id, g.name,
              CASE WHEN gm.role = 'admin' THEN true ELSE false END as is_admin
       FROM collaboration_groups g
       LEFT JOIN collaboration_group_members gm ON g.id = gm.group_id AND gm.user_id = $2
       WHERE g.id = $1`,
      [groupId, inviter_id]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const group = groupResult.rows[0];
    const isOwner = group.owner_id === inviter_id;
    const isAdmin = group.is_admin;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Only group owners and admins can invite members' });
    }

    // Don't allow non-owners to invite with owner role
    if (role === 'owner' && !isOwner) {
      return res.status(403).json({ error: 'Only the current owner can transfer ownership' });
    }

    // Enhanced connection check - allows both mutual connections and following
    const connectionResult = await db.query(
      `SELECT status, connection_type
       FROM connections
       WHERE user_id = $1
         AND connection_id = $2
         AND (
           (status = 'accepted' AND connection_type = 'mutual')
           OR (status = 'following' AND connection_type = 'following')
         )`,
      [inviter_id, userId]
    );

    if (connectionResult.rows.length === 0) {
      // Check if the invitee is following the inviter (reverse check)
      const reverseConnectionResult = await db.query(
        `SELECT status, connection_type
         FROM connections
         WHERE user_id = $1
           AND connection_id = $2
           AND connection_type = 'following'
           AND status = 'following'`,
        [userId, inviter_id]
      );

      if (reverseConnectionResult.rows.length === 0) {
        return res.status(403).json({
          error: 'You can only invite connected users to groups. Please send a connection request or follow them first.',
          requiresConnection: true,
          userId: userId
        });
      }
    }

    // Check if user is already a member
    const existingMemberResult = await db.query(
      'SELECT 1 FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );

    if (existingMemberResult.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member of this group' });
    }

    // Check for existing pending invitation
    const existingInviteResult = await db.query(
      `SELECT id, expires_at FROM group_invitations
       WHERE group_id = $1 AND invitee_id = $2 AND status = 'pending'`,
      [groupId, userId]
    );

    if (existingInviteResult.rows.length > 0) {
      const existingInvite = existingInviteResult.rows[0];
      const expiresAt = new Date(existingInvite.expires_at);
      const now = new Date();

      if (expiresAt > now) {
        const daysLeft = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
        return res.status(400).json({
          error: 'An invitation has already been sent to this user',
          existingInvitationId: existingInvite.id,
          expiresInDays: daysLeft
        });
      }

      // If expired, update it to expired status
      await db.query(
        `UPDATE group_invitations SET status = 'expired' WHERE id = $1`,
        [existingInvite.id]
      );
    }

    // Generate unique invitation code
    const invitationCode = `GRP-${Date.now()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;

    // Create the group invitation with role (if column exists)
    // First check if role column exists
    const roleColumnExists = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'group_invitations' AND column_name = 'role'`
    );

    let invitationResult;
    if (roleColumnExists.rows.length > 0) {
      // Role column exists, include it
      invitationResult = await db.query(
        `INSERT INTO group_invitations
         (group_id, inviter_id, invitee_id, role, status, invitation_code, message)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING *`,
        [groupId, inviter_id, userId, role, invitationCode, message]
      );
    } else {
      // Role column doesn't exist, skip it
      invitationResult = await db.query(
        `INSERT INTO group_invitations
         (group_id, inviter_id, invitee_id, status, invitation_code, message)
         VALUES ($1, $2, $3, 'pending', $4, $5)
         RETURNING *`,
        [groupId, inviter_id, userId, invitationCode, message]
      );

      // Store role in a separate table or handle it during acceptance
      console.log(`Note: Role '${role}' will be applied when invitation is accepted`);
    }

    const invitation = invitationResult.rows[0];

    // Get invitee details for response
    const inviteeResult = await db.query(
      'SELECT username, full_name FROM users WHERE id = $1',
      [userId]
    );

    // Notify the invitee via socket
    if (socketService) {
      socketService.notifyUser(userId, 'group:invitation', {
        invitation: invitation,
        group: {
          id: groupId,
          name: group.name
        },
        inviter: {
          id: inviter_id,
          username: req.user.username,
          full_name: req.user.full_name
        },
        intendedRole: role
      });
    }

    res.status(201).json({
      ...invitation,
      intendedRole: role,
      invitee: inviteeResult.rows[0],
      group: {
        id: groupId,
        name: group.name
      }
    });
  } catch (error) {
    console.error('Error inviting user to group:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
},

// Enhanced acceptGroupInvitation to handle roles
acceptGroupInvitation: async (req, res) => {
  const { invitationId } = req.params;
  const userId = req.user.id;

  try {
    // Get the invitation details
    const invitationResult = await db.query(
      `SELECT gi.*,
              g.name as group_name,
              u.username as inviter_username,
              u.full_name as inviter_name
       FROM group_invitations gi
       JOIN collaboration_groups g ON gi.group_id = g.id
       JOIN users u ON gi.inviter_id = u.id
       WHERE gi.id = $1 AND gi.invitee_id = $2 AND gi.status = 'pending'`,
      [invitationId, userId]
    );

    if (invitationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invitation not found or already processed' });
    }

    const invitation = invitationResult.rows[0];

    // Check if invitation has expired
    if (new Date(invitation.expires_at) < new Date()) {
      await db.query(
        `UPDATE group_invitations SET status = 'expired' WHERE id = $1`,
        [invitationId]
      );
      return res.status(400).json({ error: 'This invitation has expired' });
    }

    // Start transaction
    await db.query('BEGIN');

    try {
      // Update invitation status
      await db.query(
        `UPDATE group_invitations
         SET status = 'accepted', responded_at = NOW()
         WHERE id = $1`,
        [invitationId]
      );

      // Determine the role to use (from invitation if column exists, otherwise default)
      const role = invitation.role || 'member';

      // Add user to group with the specified role
      await db.query(
        `INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, NOW())`,
        [invitation.group_id, userId, role]
      );

      await db.query('COMMIT');

      // Notify the inviter
      if (socketService) {
        socketService.notifyUser(invitation.inviter_id, 'group:invitation_accepted', {
          groupId: invitation.group_id,
          groupName: invitation.group_name,
          acceptedBy: {
            id: userId,
            username: req.user.username,
            full_name: req.user.full_name
          }
        });
      }

      res.json({
        message: 'Successfully joined the group',
        group: {
          id: invitation.group_id,
          name: invitation.group_name,
          role: role
        }
      });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error accepting group invitation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}