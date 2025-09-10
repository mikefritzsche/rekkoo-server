const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * Factory function that creates a CollaborationController
 * @param {Object} socketService - Socket service for real-time updates
 * @returns {Object} Controller object with collaboration methods
 */
function collaborationControllerFactory(socketService = null) {
  // Create a dummy socket service if none is provided
  const safeSocketService = socketService || {
    notifyUser: () => {} // No-op function
  };

const CollaborationController = {
  // Search users for collaboration
  searchUsers: async (req, res) => {
    const { q: query, limit = 10 } = req.query;
    
    if (!query || query.length < 2) {
      return res.json([]);
    }

    try {
      const searchQuery = `%${query}%`;
      const { rows } = await db.query(
        `SELECT id, username, email, full_name
         FROM users 
         WHERE (username ILIKE $1 OR email ILIKE $1 OR full_name ILIKE $1)
           AND deleted_at IS NULL
         LIMIT $2`,
        [searchQuery, parseInt(limit)]
      );
      
      return res.json(rows);
    } catch (error) {
      console.error('Error searching users:', error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Get groups attached to a list with roles
  getListGroupsWithRoles: async (req, res) => {
    const { listId } = req.params;
    const requester_id = req.user.id;
    console.log(`[getListGroupsWithRoles] Called by user ${requester_id} for list ${listId}`);
    try {
      // First check if the list exists and get owner
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      
      const isOwner = listRows[0].owner_id === requester_id;
      
      // If not owner, check if user has any access to this list (group or individual)
      if (!isOwner) {
        // Debug: Check group access separately
        const { rows: groupAccessRows } = await db.query(
          `SELECT ls.shared_with_group_id, cg.name as group_name
           FROM list_sharing ls
           JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
           JOIN collaboration_groups cg ON cg.id = ls.shared_with_group_id
           WHERE ls.list_id = $1 AND cgm.user_id = $2 AND ls.deleted_at IS NULL`,
          [listId, requester_id]
        );
        console.log(`[getListGroupsWithRoles] Group access check for user ${requester_id} on list ${listId}: found ${groupAccessRows.length} groups`);
        
        // Debug: Check individual access separately  
        const { rows: individualAccessRows } = await db.query(
          `SELECT luo.role, luo.deleted_at
           FROM list_user_overrides luo
           WHERE luo.list_id = $1 AND luo.user_id = $2`,
          [listId, requester_id]
        );
        console.log(`[getListGroupsWithRoles] Individual access check for user ${requester_id} on list ${listId}: found ${individualAccessRows.length} overrides`);
        if (individualAccessRows.length > 0) {
          console.log(`[getListGroupsWithRoles] Individual override details:`, individualAccessRows[0]);
        }
        
        const { rows: accessRows } = await db.query(
          `SELECT EXISTS (
             -- Check for group access
             SELECT 1 FROM list_sharing ls
             JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
             WHERE ls.list_id = $1 AND cgm.user_id = $2 AND ls.deleted_at IS NULL
           ) OR EXISTS (
             -- Check for individual user access
             SELECT 1 FROM list_user_overrides luo
             WHERE luo.list_id = $1 
               AND luo.user_id = $2 
               AND luo.deleted_at IS NULL
               AND luo.role != 'blocked'
               AND luo.role != 'inherit'
           ) AS has_access`,
          [listId, requester_id]
        );
        
        console.log(`[getListGroupsWithRoles] Combined access check result for user ${requester_id} on list ${listId}:`, accessRows[0]);
        
        if (!accessRows[0]?.has_access) {
          console.log(`[getListGroupsWithRoles] Access denied for user ${requester_id} on list ${listId}`);
          return res.status(403).json({ error: 'Insufficient permissions' });
        } else {
          console.log(`[getListGroupsWithRoles] Access granted for user ${requester_id} on list ${listId} (non-owner with access)`);
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
        `INSERT INTO list_sharing (id, list_id, shared_with_group_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [uuidv4(), listId, groupId]
      );

      // Upsert role
      const upsert = await db.query(
        `INSERT INTO list_group_roles (id, list_id, group_id, role, permissions)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (list_id, group_id)
         DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [uuidv4(), listId, groupId, role, permissions ? JSON.stringify(permissions) : null]
      );

      // Notify all group members about the new list access
      try {
        console.log(`[CollaborationController] Notifying group members about list ${listId} access (group: ${groupId}, role: ${role})`);
        
        const { rows: groupMembers } = await db.query(
          `SELECT DISTINCT cgm.user_id 
           FROM collaboration_group_members cgm 
           WHERE cgm.group_id = $1 
             AND cgm.deleted_at IS NULL
             AND cgm.user_id != $2
           UNION
           SELECT DISTINCT cg.owner_id as user_id
           FROM collaboration_groups cg
           WHERE cg.id = $1 
             AND cg.deleted_at IS NULL
             AND cg.owner_id != $2`,
          [groupId, requester_id]
        );

        for (const member of groupMembers) {
          console.log(`[CollaborationController] Notifying user ${member.user_id} about list access granted`);
          safeSocketService.notifyUser(member.user_id, 'list_access_granted', {
            listId: listId,
            updatedBy: requester_id,
            accessType: 'group',
            groupId: groupId,
            role: role,
            timestamp: Date.now()
          });
        }
        
        console.log(`[CollaborationController] Notified ${groupMembers.length} group members about list access`);
      } catch (notifyError) {
        console.error('[CollaborationController] Failed to notify group members:', notifyError);
        // Don't fail the request if notifications fail
      }

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

      // Get group members before removing access
      const { rows: groupMembers } = await db.query(
        `SELECT DISTINCT cgm.user_id 
         FROM collaboration_group_members cgm 
         WHERE cgm.group_id = $1 
           AND cgm.deleted_at IS NULL
           AND cgm.user_id != $2
         UNION
         SELECT DISTINCT cg.owner_id as user_id
         FROM collaboration_groups cg
         WHERE cg.id = $1 
           AND cg.deleted_at IS NULL
           AND cg.owner_id != $2`,
        [groupId, requester_id]
      );

      await db.query('UPDATE list_sharing SET deleted_at = CURRENT_TIMESTAMP WHERE list_id = $1 AND shared_with_group_id = $2 AND deleted_at IS NULL', [listId, groupId]);
      await db.query('UPDATE list_group_roles SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE list_id = $1 AND group_id = $2 AND deleted_at IS NULL', [listId, groupId]);

      // Notify all group members about the revoked list access
      try {
        console.log(`[CollaborationController] Notifying group members about list ${listId} access revoked (group: ${groupId})`);
        
        for (const member of groupMembers) {
          console.log(`[CollaborationController] Notifying user ${member.user_id} about list access revoked`);
          safeSocketService.notifyUser(member.user_id, 'list_access_revoked', {
            listId: listId,
            updatedBy: requester_id,
            accessType: 'group',
            groupId: groupId,
            timestamp: Date.now()
          });
        }
        
        console.log(`[CollaborationController] Notified ${groupMembers.length} group members about list access revocation`);
      } catch (notifyError) {
        console.error('[CollaborationController] Failed to notify group members about access revocation:', notifyError);
        // Don't fail the request if notifications fail
      }

      return res.status(204).send();
    } catch (e) {
      console.error('Error detaching group from list:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // List: get per-user overrides (accessible to users with any list access)
  getListUserOverrides: async (req, res) => {
    const { listId } = req.params;
    const requester_id = req.user.id;
    console.log(`[getListUserOverrides] Called by user ${requester_id} for list ${listId}`);
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      
      const isOwner = listRows[0].owner_id === requester_id;
      
      // Check if user has any access to this list
      if (!isOwner) {
        const { rows: accessRows } = await db.query(
          `SELECT EXISTS (
             -- Check for group access
             SELECT 1 FROM list_sharing ls
             JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
             WHERE ls.list_id = $1 AND cgm.user_id = $2 AND ls.deleted_at IS NULL
           ) OR EXISTS (
             -- Check for individual user access
             SELECT 1 FROM list_user_overrides luo
             WHERE luo.list_id = $1 
               AND luo.user_id = $2 
               AND luo.deleted_at IS NULL
               AND luo.role != 'blocked'
               AND luo.role != 'inherit'
           ) AS has_access`,
          [listId, requester_id]
        );
        
        console.log(`[getListUserOverrides] Access check result for user ${requester_id} on list ${listId}:`, accessRows[0]);
        
        if (!accessRows[0]?.has_access) {
          console.log(`[getListUserOverrides] Access denied for user ${requester_id} on list ${listId}`);
          return res.status(403).json({ error: 'Insufficient permissions' });
        } else {
          console.log(`[getListUserOverrides] Access granted for user ${requester_id} on list ${listId} (non-owner with access)`);
        }
      }

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
    
    console.log('[setUserRoleOverrideOnList] Request received:', {
      listId,
      userId,
      role,
      permissions,
      requester_id,
      body: req.body
    });
    
    try {
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) {
        console.log('[setUserRoleOverrideOnList] List not found:', listId);
        return res.status(404).json({ error: 'List not found' });
      }
      if (listRows[0].owner_id !== requester_id) {
        console.log('[setUserRoleOverrideOnList] Permission denied. Owner:', listRows[0].owner_id, 'Requester:', requester_id);
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      if (!role) {
        console.log('[setUserRoleOverrideOnList] No role provided');
        return res.status(400).json({ error: 'role is required (or use "inherit" to remove override)' });
      }

      if (role === 'inherit') {
        console.log('[setUserRoleOverrideOnList] Removing override (role=inherit) for user:', userId, 'list:', listId);
        
        // First check if there's an existing override to remove
        const { rows: existingRows } = await db.query(
          `SELECT * FROM public.list_user_overrides 
           WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [listId, userId]
        );
        console.log('[setUserRoleOverrideOnList] Existing overrides found:', existingRows.length);
        
        const { rowCount } = await db.query(
          `UPDATE public.list_user_overrides
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [listId, userId]
        );
        console.log('[setUserRoleOverrideOnList] Rows updated (soft deleted):', rowCount);

        // Notify the user about access revocation (only if we actually removed an override)
        if (rowCount > 0) {
          try {
            console.log(`[CollaborationController] Notifying user ${userId} about list access revoked (individual)`);
            safeSocketService.notifyUser(userId, 'list_access_revoked', {
              listId: listId,
              updatedBy: requester_id,
              accessType: 'individual',
              timestamp: Date.now()
            });
          } catch (notifyError) {
            console.error('[CollaborationController] Failed to notify user about access revocation:', notifyError);
          }
        }

        return res.status(204).send();
      }

      console.log('[setUserRoleOverrideOnList] Upserting role:', role, 'for user:', userId, 'list:', listId);
      
      // Check if there's an existing record first
      const { rows: existingRows } = await db.query(
        `SELECT * FROM public.list_user_overrides 
         WHERE list_id = $1 AND user_id = $2`,
        [listId, userId]
      );
      console.log('[setUserRoleOverrideOnList] Existing records (including soft deleted):', existingRows.length);
      if (existingRows.length > 0) {
        console.log('[setUserRoleOverrideOnList] Existing record:', existingRows[0]);
      }
      
      const upsert = await db.query(
        `INSERT INTO public.list_user_overrides (id, list_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (list_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [uuidv4(), listId, userId, role, permissions ? JSON.stringify(permissions) : null]
      );
      console.log('[setUserRoleOverrideOnList] Upsert successful:', upsert.rows[0]);
      
      // Verify the insert actually worked
      const verifyQuery = await db.query(
        `SELECT * FROM public.list_user_overrides 
         WHERE list_id = $1 AND user_id = $2`,
        [listId, userId]
      );
      console.log('[setUserRoleOverrideOnList] Verification query found:', verifyQuery.rows.length, 'rows');
      if (verifyQuery.rows.length > 0) {
        console.log('[setUserRoleOverrideOnList] Verified data:', verifyQuery.rows[0]);
      }

      // Notify the user about access granted (only notify if user is not the requester)
      if (userId !== requester_id) {
        try {
          console.log(`[CollaborationController] Notifying user ${userId} about list access granted (individual, role: ${role})`);
          safeSocketService.notifyUser(userId, 'list_access_granted', {
            listId: listId,
            updatedBy: requester_id,
            accessType: 'individual',
            role: role,
            timestamp: Date.now()
          });
        } catch (notifyError) {
          console.error('[CollaborationController] Failed to notify user about access granted:', notifyError);
        }
      }

      return res.status(201).json(upsert.rows[0]);
    } catch (e) {
      console.error('[setUserRoleOverrideOnList] Error:', e.message, e.stack);
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
        `INSERT INTO public.list_group_user_roles (id, list_id, group_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (list_id, group_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [uuidv4(), listId, groupId, userId, role, permissions ? JSON.stringify(permissions) : null]
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
    console.log(`[getGroupUserRolesOnList] Called by user ${requester_id} for list ${listId}, group ${groupId}`);
    try {
      // First check if the list exists and get owner
      const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) return res.status(404).json({ error: 'List not found' });
      
      const isOwner = listRows[0].owner_id === requester_id;
      
      // If not owner, check if user has any access to the list (group or individual)
      if (!isOwner) {
        const { rows: accessRows } = await db.query(
          `SELECT EXISTS (
             -- Check for group access to this list
             SELECT 1 FROM list_sharing ls
             JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
             WHERE ls.list_id = $1 AND cgm.user_id = $2 AND ls.deleted_at IS NULL
           ) OR EXISTS (
             -- Check for individual user access to this list
             SELECT 1 FROM list_user_overrides luo
             WHERE luo.list_id = $1 
               AND luo.user_id = $2 
               AND luo.deleted_at IS NULL
               AND luo.role != 'blocked'
               AND luo.role != 'inherit'
           ) AS has_access`,
          [listId, requester_id]
        );
        
        console.log(`[getGroupUserRolesOnList] Access check result for user ${requester_id} on list ${listId}, group ${groupId}:`, accessRows[0]);
        
        if (!accessRows[0]?.has_access) {
          console.log(`[getGroupUserRolesOnList] Access denied for user ${requester_id} on list ${listId}, group ${groupId}`);
          return res.status(403).json({ error: 'Insufficient permissions' });
        } else {
          console.log(`[getGroupUserRolesOnList] Access granted for user ${requester_id} on list ${listId}, group ${groupId} (non-owner with access)`);
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
        'INSERT INTO list_sharing (id, list_id, shared_with_group_id, permissions) VALUES ($1, $2, $3, $4) RETURNING *',
        [uuidv4(), listId, groupId, permissions || 'edit']
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

    // Get effective user role for a list
    getUserListRole: async (req, res) => {
        const { listId, userId } = req.params;
        const requester_id = req.user.id;
        
        try {
            // Only allow users to check their own role or list owners to check any user's role
            const { rows: listRows } = await db.query('SELECT owner_id FROM lists WHERE id = $1', [listId]);
            if (listRows.length === 0) {
                return res.status(404).json({ error: 'List not found' });
            }
            
            const listOwnerId = listRows[0].owner_id;
            const isOwner = listOwnerId === requester_id;
            
            // Users can only check their own role unless they're the owner
            if (userId !== requester_id && !isOwner) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            
            // If checking the owner's role, return 'owner'
            if (userId === listOwnerId) {
                return res.json({ role: 'owner' });
            }
            
            // Check for direct user role override on the list
            const { rows: userOverride } = await db.query(
                `SELECT role FROM list_user_overrides 
                 WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
                [listId, userId]
            );
            
            if (userOverride.length > 0) {
                return res.json({ role: userOverride[0].role });
            }
            
            // Check for group-based access with the most permissive role
            const { rows: groupRoles } = await db.query(
                `SELECT 
                    COALESCE(lgur.role, lgr.role, 'viewer') as effective_role,
                    CASE 
                        WHEN lgur.role IS NOT NULL THEN 'user_group_override'
                        WHEN lgr.role IS NOT NULL THEN 'group_role'
                        ELSE 'default'
                    END as role_source
                 FROM list_sharing ls
                 JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
                 LEFT JOIN list_group_roles lgr ON lgr.list_id = ls.list_id 
                    AND lgr.group_id = ls.shared_with_group_id 
                    AND lgr.deleted_at IS NULL
                 LEFT JOIN list_group_user_roles lgur ON lgur.list_id = ls.list_id 
                    AND lgur.group_id = ls.shared_with_group_id 
                    AND lgur.user_id = cgm.user_id 
                    AND lgur.deleted_at IS NULL
                 WHERE ls.list_id = $1 
                    AND cgm.user_id = $2 
                    AND ls.deleted_at IS NULL
                    AND cgm.deleted_at IS NULL
                 ORDER BY 
                    CASE COALESCE(lgur.role, lgr.role, 'viewer')
                        WHEN 'admin' THEN 1
                        WHEN 'editor' THEN 2
                        WHEN 'commenter' THEN 3
                        WHEN 'reserver' THEN 4
                        WHEN 'viewer' THEN 5
                        ELSE 6
                    END
                 LIMIT 1`,
                [listId, userId]
            );
            
            if (groupRoles.length > 0) {
                return res.json({ 
                    role: groupRoles[0].effective_role,
                    source: groupRoles[0].role_source 
                });
            }
            
            // No access found
            return res.json({ role: 'viewer' });
            
        } catch (e) {
            console.error('Error fetching user list role:', e);
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    },
};

  return CollaborationController;
}

module.exports = collaborationControllerFactory; 