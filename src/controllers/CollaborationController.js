const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const CollaborationController = {
  // Create a new collaboration group
  createGroup: async (req, res) => {
    const { name, description } = req.body;
    const owner_id = req.user.id;

    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    try {
      const { rows } = await db.query(
        'INSERT INTO collaboration_groups (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
        [name, description, owner_id]
      );
      res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Error creating group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Get all groups for the current user (owned and member of)
  getGroupsForUser: async (req, res) => {
    const user_id = req.user.id;

    try {
      const { rows } = await db.query(
        `SELECT DISTINCT g.*, 
          (g.owner_id = $1) as is_owner,
          m.role
         FROM collaboration_groups g
         LEFT JOIN collaboration_group_members m ON g.id = m.group_id
         WHERE g.owner_id = $1 OR m.user_id = $1`,
        [user_id]
      );
      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching groups for user:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Add a member to a group
  addMemberToGroup: async (req, res) => {
    const { groupId } = req.params;
    const { userId, role } = req.body;
    const owner_id = req.user.id;

    try {
      // Check if the current user is the owner of the group
      const groupResult = await db.query('SELECT owner_id FROM collaboration_groups WHERE id = $1', [groupId]);
      if (groupResult.rows.length === 0 || groupResult.rows[0].owner_id !== owner_id) {
        return res.status(403).json({ error: 'Only the group owner can add members' });
      }

      const { rows } = await db.query(
        'INSERT INTO collaboration_group_members (group_id, user_id, role) VALUES ($1, $2, $3) RETURNING *',
        [groupId, userId, role || 'member']
      );
      res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Error adding member to group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Remove a member from a group
  removeMemberFromGroup: async (req, res) => {
    const { groupId, userId } = req.params;
    const owner_id = req.user.id;

    try {
      // Check if the current user is the owner of the group
      const groupResult = await db.query('SELECT owner_id FROM collaboration_groups WHERE id = $1', [groupId]);
      if (groupResult.rows.length === 0 || groupResult.rows[0].owner_id !== owner_id) {
        return res.status(403).json({ error: 'Only the group owner can remove members' });
      }

      await db.query('DELETE FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
      res.status(204).send();
    } catch (error) {
      console.error('Error removing member from group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Invite a user to a group
  inviteUserToGroup: async (req, res) => {
    const { groupId } = req.params;
    const { email } = req.body;
    const inviter_id = req.user.id;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    try {
        // We will add the logic to send an email with the invitation link later
        // For now, we will just create the invitation in the database

        const expires_at = new Date();
        expires_at.setDate(expires_at.getDate() + 7); // Invitation expires in 7 days

        const invitation_token = uuidv4();
        const invitation_code = Math.random().toString(36).substring(2, 8).toUpperCase();

        const metadata = {
            invite_type: 'group',
            group_id: groupId,
        };

        const { rows } = await db.query(
            'INSERT INTO invitations (inviter_id, email, invitation_code, invitation_token, status, metadata, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [inviter_id, email, invitation_code, invitation_token, 'pending', metadata, expires_at]
        );

        res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Error inviting user to group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Share a list with a group
  shareListWithGroup: async (req, res) => {
    const { listId, groupId } = req.params;
    const owner_id = req.user.id;

    try {
      // Verify the current user owns the list
      const listResult = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listResult.rows.length === 0 || listResult.rows[0].owner_id !== owner_id) {
        return res.status(403).json({ error: 'You can only share lists you own' });
      }

      // Verify the current user owns the group
      const groupResult = await db.query('SELECT owner_id FROM collaboration_groups WHERE id = $1', [groupId]);
        if (groupResult.rows.length === 0 || groupResult.rows[0].owner_id !== owner_id) {
            return res.status(403).json({ error: 'You can only share lists with groups you own' });
        }

      const { rows } = await db.query(
        'INSERT INTO list_sharing (list_id, shared_with_group_id) VALUES ($1, $2) RETURNING *',
        [listId, groupId]
      );
      res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Error sharing list with group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Unshare a list from a group
    unshareListFromGroup: async (req, res) => {
        const { listId, groupId } = req.params;
        const owner_id = req.user.id;

        try {
            // Verify the current user owns the list
            const listResult = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
            if (listResult.rows.length === 0 || listResult.rows[0].owner_id !== owner_id) {
                return res.status(403).json({ error: 'You can only unshare lists you own' });
            }

            await db.query('DELETE FROM list_sharing WHERE list_id = $1 AND shared_with_group_id = $2', [listId, groupId]);
            res.status(204).send();
        } catch (error) {
            console.error('Error unsharing list from group:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    },

    // Claim a gift item
    claimGift: async (req, res) => {
        const { itemId } = req.params;
        const reserved_by = req.user.id;

        try {
            // Fetch the list owner to ensure the claimer is not the owner
            const itemResult = await db.query('SELECT owner_id, list_id FROM list_items WHERE id = $1', [itemId]);
            if (itemResult.rows.length === 0) {
                return res.status(404).json({ error: 'Item not found' });
            }
            if (itemResult.rows[0].owner_id === reserved_by) {
                return res.status(403).json({ error: 'You cannot claim items on your own list' });
            }

            const reserved_for = itemResult.rows[0].owner_id;

            const { rows } = await db.query(
                'INSERT INTO gift_reservations (item_id, reserved_by, reserved_for) VALUES ($1, $2, $3) RETURNING *',
                [itemId, reserved_by, reserved_for]
            );
            res.status(201).json(rows[0]);
        } catch (error) {
            console.error('Error claiming gift:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    },

    // Unclaim a gift item
    unclaimGift: async (req, res) => {
        const { itemId } = req.params;
        const reserved_by = req.user.id;

        try {
            await db.query('DELETE FROM gift_reservations WHERE item_id = $1 AND reserved_by = $2', [itemId, reserved_by]);
            res.status(204).send();
        } catch (error) {
            console.error('Error unclaiming gift:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    },
};

module.exports = CollaborationController; 