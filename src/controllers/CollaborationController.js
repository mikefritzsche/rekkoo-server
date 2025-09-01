const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const CollaborationController = {
  // Get groups attached to a list with roles
  getListGroupsWithRoles: async (req, res) => {
    const { listId } = req.params;
    const requester_id = req.user.id;
    try {
      // First check if the list exists and get owner
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      
      const isOwner = listRows[0].owner_id === requester_id;
      
      // If not owner, check if user has group access to this list
      if (!isOwner) {
        const { rows: accessRows } = await db.query(
          `SELECT 1 FROM list_sharing ls
           JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
           WHERE ls.list_id = $1 AND cgm.user_id = $2 AND ls.deleted_at IS NULL
           LIMIT 1`,
          [listId, requester_id]
        );
        
        if (accessRows.length === 0) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }

      const { rows } = await db.query(
        `SELECT ls.shared_with_group_id as group_id,
                cg.name, cg.description,
                lgr.role, lgr.permissions
         FROM list_sharing ls
         JOIN collaboration_groups cg ON cg.id = ls.shared_with_group_id
         LEFT JOIN list_group_roles lgr ON lgr.list_id = ls.list_id AND lgr.group_id = ls.shared_with_group_id AND lgr.deleted_at IS NULL
         WHERE ls.list_id = $1 AND ls.deleted_at IS NULL
         ORDER BY cg.name ASC`,
        [listId]
      );
      return res.json(rows);
    } catch (e) {
      console.error('Error fetching list groups:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Attach group to list with role
  attachGroupToList: async (req, res) => {
    const { listId, groupId } = req.params;
    const { role = 'editor', permissions = null } = req.body || {};
    const requester_id = req.user.id;
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      if (listRows[0].owner_id !== requester_id) return res.status(403).json({ error: 'Insufficient permissions' });

      // Ensure list_sharing link exists
      await db.query(
        `INSERT INTO list_sharing (list_id, shared_with_group_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [listId, groupId]
      );

      // Upsert role
      const upsert = await db.query(
        `INSERT INTO list_group_roles (list_id, group_id, role, permissions)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (list_id, group_id)
         DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [listId, groupId, role, permissions ? JSON.stringify(permissions) : null]
      );
      return res.status(201).json(upsert.rows[0]);
    } catch (e) {
      console.error('Error attaching group to list:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Update group role on list
  updateGroupRoleOnList: async (req, res) => {
    const { listId, groupId } = req.params;
    const { role, permissions = null } = req.body || {};
    const requester_id = req.user.id;
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      if (listRows[0].owner_id !== requester_id) return res.status(403).json({ error: 'Insufficient permissions' });
      if (!role) return res.status(400).json({ error: 'role is required' });

      const { rows } = await db.query(
        `UPDATE list_group_roles SET role = $3, permissions = $4::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE list_id = $1 AND group_id = $2
         RETURNING *`,
        [listId, groupId, role, permissions ? JSON.stringify(permissions) : null]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Group not attached to list' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('Error updating group role:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Detach group from list (and soft-delete role mapping)
  detachGroupFromList: async (req, res) => {
    const { listId, groupId } = req.params;
    const requester_id = req.user.id;
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      if (listRows[0].owner_id !== requester_id) return res.status(403).json({ error: 'Insufficient permissions' });

      await db.query('UPDATE list_sharing SET deleted_at = CURRENT_TIMESTAMP WHERE list_id = $1 AND shared_with_group_id = $2 AND deleted_at IS NULL', [listId, groupId]);
      await db.query('UPDATE list_group_roles SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE list_id = $1 AND group_id = $2 AND deleted_at IS NULL', [listId, groupId]);
      return res.status(204).send();
    } catch (e) {
      console.error('Error detaching group from list:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // List: get per-user overrides (owner/admin only)
  getListUserOverrides: async (req, res) => {
    const { listId } = req.params;
    const requester_id = req.user.id;
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      if (listRows[0].owner_id !== requester_id) return res.status(403).json({ error: 'Insufficient permissions' });

      const { rows } = await db.query(
        `SELECT luo.list_id, luo.user_id, luo.role, luo.permissions, u.username, u.email, u.full_name
         FROM public.list_user_overrides luo
         JOIN public.users u ON u.id = luo.user_id
         WHERE luo.list_id = $1 AND luo.deleted_at IS NULL
         ORDER BY u.username ASC NULLS LAST, u.email ASC NULLS LAST`,
        [listId]
      );
      return res.json(rows);
    } catch (e) {
      console.error('Error fetching list user overrides:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // List: set/remove per-user override
  setUserRoleOverrideOnList: async (req, res) => {
    const { listId, userId } = req.params;
    const { role, permissions = null } = req.body || {};
    const requester_id = req.user.id;
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      if (listRows[0].owner_id !== requester_id) return res.status(403).json({ error: 'Insufficient permissions' });

      if (!role) return res.status(400).json({ error: 'role is required (or use "inherit" to remove override)' });

      if (role === 'inherit') {
        const { rowCount } = await db.query(
          `UPDATE public.list_user_overrides
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [listId, userId]
        );
        return rowCount > 0 ? res.status(204).send() : res.status(204).send();
      }

      const upsert = await db.query(
        `INSERT INTO public.list_user_overrides (list_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (list_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [listId, userId, role, permissions ? JSON.stringify(permissions) : null]
      );
      return res.status(201).json(upsert.rows[0]);
    } catch (e) {
      console.error('Error setting user override:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // List + Group: set/remove per-user role within a group on a list
  setUserRoleForGroupOnList: async (req, res) => {
    const { listId, groupId, userId } = req.params;
    const { role, permissions = null } = req.body || {};
    const requester_id = req.user.id;
    try {
      // Only list owner can set roles per group for now
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      if (listRows[0].owner_id !== requester_id) return res.status(403).json({ error: 'Insufficient permissions' });

      if (!role) return res.status(400).json({ error: 'role is required (or use "inherit" to remove)' });

      if (role === 'inherit') {
        const { rowCount } = await db.query(
          `UPDATE public.list_group_user_roles
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE list_id = $1 AND group_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
          [listId, groupId, userId]
        );
        return rowCount > 0 ? res.status(204).send() : res.status(204).send();
      }

      const upsert = await db.query(
        `INSERT INTO public.list_group_user_roles (list_id, group_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (list_id, group_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [listId, groupId, userId, role, permissions ? JSON.stringify(permissions) : null]
      );
      return res.status(201).json(upsert.rows[0]);
    } catch (e) {
      console.error('Error setting user role for group on list:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },
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

  // Get all groups for a user (owned and member of)
  getGroupsForUser: async (req, res) => {
    // Allow fetching groups for a specific user via query param (for collaboration checking)
    // Default to the authenticated user if no userId is provided
    const user_id = req.query.userId || req.user.id;

    try {
      const { rows } = await db.query(
        `SELECT DISTINCT g.*, 
          (g.owner_id = $1) as is_owner,
          m.role
         FROM collaboration_groups g
         LEFT JOIN collaboration_group_members m ON g.id = m.group_id
         WHERE (g.owner_id = $1 OR m.user_id = $1) 
           AND g.deleted_at IS NULL`,
        [user_id]
      );
      
      console.log(`[CollaborationController] Found ${rows.length} groups for user ${user_id}`);
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

  // Get members of a group (owner or group members can view)
  getGroupMembers: async (req, res) => {
    const { groupId } = req.params;
    const requester_id = req.user.id;
    try {
      // First check if the group exists and get owner
      const groupResult = await db.query('SELECT owner_id FROM collaboration_groups WHERE id = $1', [groupId]);
      if (groupResult.rows.length === 0) {
        return res.status(404).json({ error: 'Group not found' });
      }
      
      const isOwner = groupResult.rows[0].owner_id === requester_id;
      
      // If not owner, check if user is a member of this group
      if (!isOwner) {
        const { rows: memberRows } = await db.query(
          'SELECT 1 FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1',
          [groupId, requester_id]
        );
        
        if (memberRows.length === 0) {
          return res.status(403).json({ error: 'Only group members can view the member list' });
        }
      }

      const { rows } = await db.query(
        `SELECT m.group_id, m.user_id, m.role, m.joined_at, u.username, u.email, u.full_name,
                u.profile_image_url AS avatar_url
         FROM collaboration_group_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.group_id = $1
         ORDER BY m.joined_at ASC`,
        [groupId]
      );
      res.status(200).json(rows);
    } catch (error) {
      console.error('Error fetching group members:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // List + Group: get per-user roles for members (and any user) within a group on a list
  getGroupUserRolesOnList: async (req, res) => {
    const { listId, groupId } = req.params;
    const requester_id = req.user.id;
    try {
      // First check if the list exists and get owner
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      
      const isOwner = listRows[0].owner_id === requester_id;
      
      // If not owner, check if user is a member of this specific group and has access to the list
      if (!isOwner) {
        const { rows: accessRows } = await db.query(
          `SELECT 1 FROM list_sharing ls
           JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
           WHERE ls.list_id = $1 AND ls.shared_with_group_id = $2 AND cgm.user_id = $3 AND ls.deleted_at IS NULL
           LIMIT 1`,
          [listId, groupId, requester_id]
        );
        
        if (accessRows.length === 0) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
      }

      const { rows } = await db.query(
        `SELECT lgur.list_id, lgur.group_id, lgur.user_id, lgur.role, lgur.permissions,
                u.username, u.email, u.full_name
           FROM public.list_group_user_roles lgur
           JOIN public.users u ON u.id = lgur.user_id
          WHERE lgur.list_id = $1 AND lgur.group_id = $2 AND lgur.deleted_at IS NULL
          ORDER BY u.username ASC NULLS LAST, u.email ASC NULLS LAST`,
        [listId, groupId]
      );
      return res.json(rows);
    } catch (e) {
      console.error('Error fetching per-group user roles:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
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
        // Use invitationService to create and email the invite
        const invitationService = require('../services/invitationService');
        const metadata = { invite_type: 'group', group_id: groupId };
        const invite = await invitationService.createInvitation(inviter_id, email, metadata);
        res.status(201).json(invite);
    } catch (error) {
      console.error('Error inviting user to group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Share a list with a group
  shareListWithGroup: async (req, res) => {
    const { listId, groupId } = req.params;
    const { permissions } = req.body || {};
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

      // If a share already exists, update permissions; else insert
      const existing = await db.query(
        `SELECT id FROM list_sharing 
         WHERE list_id = $1 AND shared_with_group_id = $2 AND deleted_at IS NULL 
         LIMIT 1`,
        [listId, groupId]
      );

      if (existing.rows.length > 0) {
        const { rows } = await db.query(
          `UPDATE list_sharing 
           SET permissions = COALESCE($3, permissions), updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1 
           RETURNING *`,
          [existing.rows[0].id, owner_id, permissions || null]
        );
        return res.status(200).json(rows[0]);
      }

      const { rows } = await db.query(
        'INSERT INTO list_sharing (list_id, shared_with_group_id, permissions) VALUES ($1, $2, $3) RETURNING *',
        [listId, groupId, permissions || 'edit']
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

    // Get current shares for a list (groups and users)
    getListShares: async (req, res) => {
        const { listId } = req.params;
        const owner_id = req.user.id;

        try {
            // Verify the current user owns the list
            const listResult = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
            if (listResult.rows.length === 0 || listResult.rows[0].owner_id !== owner_id) {
                return res.status(403).json({ error: 'You can only view shares for lists you own' });
            }

            const { rows } = await db.query(
              `SELECT ls.*, cg.name as group_name
               FROM list_sharing ls
               LEFT JOIN collaboration_groups cg ON cg.id = ls.shared_with_group_id
               WHERE ls.list_id = $1 AND ls.deleted_at IS NULL
               ORDER BY ls.created_at ASC`,
              [listId]
            );
            res.status(200).json(rows);
        } catch (error) {
            console.error('Error fetching list shares:', error);
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