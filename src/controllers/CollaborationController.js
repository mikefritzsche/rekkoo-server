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
  // Bulk fetch members for multiple groups
  getBulkGroupMembers: async (req, res) => {
    const { group_ids } = req.body;
    const requester_id = req.user.id;
    
    if (!group_ids || !Array.isArray(group_ids) || group_ids.length === 0) {
      return res.status(400).json({ error: 'group_ids array is required' });
    }

    // Limit batch size to prevent abuse
    if (group_ids.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 groups per batch request' });
    }

    console.log(`[getBulkGroupMembers] Fetching members for ${group_ids.length} groups for user ${requester_id}`);

    try {
      // First check which groups the requester has access to
      const { rows: accessibleGroups } = await db.query(
        `SELECT DISTINCT g.id 
         FROM collaboration_groups g
         WHERE g.id = ANY($1::uuid[])
           AND (
             g.owner_id = $2  -- User owns the group
             OR EXISTS (      -- User is a member of the group
               SELECT 1 FROM collaboration_group_members cgm 
               WHERE cgm.group_id = g.id AND cgm.user_id = $2
             )
           )`,
        [group_ids, requester_id]
      );

      const accessibleGroupIds = accessibleGroups.map(g => g.id);
      
      if (accessibleGroupIds.length === 0) {
        return res.status(200).json({});
      }

      // Fetch all members for accessible groups
      const { rows: members } = await db.query(
        `SELECT m.group_id, m.user_id, m.role, m.joined_at, 
                u.username, u.email, u.full_name,
                u.profile_image_url AS avatar_url
         FROM collaboration_group_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.group_id = ANY($1::uuid[])
         ORDER BY m.group_id, m.joined_at ASC`,
        [accessibleGroupIds]
      );

      // Group members by group_id
      const result = {};
      for (const groupId of accessibleGroupIds) {
        result[groupId] = [];
      }
      
      members.forEach(member => {
        if (!result[member.group_id]) {
          result[member.group_id] = [];
        }
        result[member.group_id].push(member);
      });

      res.status(200).json(result);
    } catch (error) {
      console.error('Error fetching bulk group members:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Batch fetch sharing data for multiple lists
  getBatchListShares: async (req, res) => {
    const { listIds } = req.body;
    const requester_id = req.user.id;
    
    if (!listIds || !Array.isArray(listIds) || listIds.length === 0) {
      return res.status(400).json({ error: 'listIds array is required' });
    }

    // Limit batch size to prevent abuse
    if (listIds.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 lists per batch request' });
    }

    console.log(`[getBatchListShares] Fetching shares for ${listIds.length} lists for user ${requester_id} - Updated`);

    try {
      // First, get all lists to check ownership and access
      const { rows: lists } = await db.query(
        'SELECT id, owner_id FROM lists WHERE id = ANY($1::uuid[])',
        [listIds]
      );

      const listOwnerMap = {};
      lists.forEach(list => {
        listOwnerMap[list.id] = list.owner_id;
      });

      // Prepare results object
      const results = {
        groups: {},
        individuals: {}
      };

      // Initialize empty arrays for each list
      listIds.forEach(listId => {
        results.groups[listId] = [];
        results.individuals[listId] = [];
      });

      // Batch fetch all group shares for lists where user is owner or has access
      const { rows: groupShares } = await db.query(
        `SELECT DISTINCT
          ls.list_id,
          ls.shared_with_group_id as group_id,
          cg.name as group_name,
          cg.description as group_description,
          ls.permissions,
          ls.created_at,
          COUNT(cgm.user_id) as member_count
        FROM list_sharing ls
        JOIN collaboration_groups cg ON cg.id = ls.shared_with_group_id
        LEFT JOIN collaboration_group_members cgm ON cgm.group_id = ls.shared_with_group_id
        WHERE ls.list_id = ANY($1::uuid[])
          AND ls.deleted_at IS NULL
          AND cg.deleted_at IS NULL
          AND (
            -- User owns the list
            ls.list_id IN (SELECT id FROM lists WHERE id = ANY($1::uuid[]) AND owner_id = $2)
            OR
            -- User has access to the list through group or individual share
            EXISTS (
              SELECT 1 FROM collaboration_group_members cgm2
              WHERE cgm2.group_id IN (
                SELECT shared_with_group_id FROM list_sharing
                WHERE list_id = ls.list_id AND deleted_at IS NULL
              ) AND cgm2.user_id = $2
            )
            OR
            EXISTS (
              SELECT 1 FROM list_user_overrides luo
              WHERE luo.list_id = ls.list_id 
                AND luo.user_id = $2 
                AND luo.deleted_at IS NULL
                AND luo.role NOT IN ('blocked', 'inherit')
            )
          )
        GROUP BY ls.list_id, ls.shared_with_group_id, cg.name, cg.description, ls.permissions, ls.created_at
        ORDER BY ls.created_at ASC`,
        [listIds, requester_id]
      );

      // Batch fetch all individual shares for lists where user is owner or has access
      const { rows: individualShares } = await db.query(
        `SELECT DISTINCT
          luo.list_id,
          luo.user_id,
          luo.role,
          luo.permissions,
          luo.created_at,
          u.username,
          u.email,
          u.full_name,
          u.profile_image_url,
          u.profile_display_config
        FROM list_user_overrides luo
        JOIN users u ON u.id = luo.user_id
        WHERE luo.list_id = ANY($1::uuid[])
          AND luo.deleted_at IS NULL
          AND luo.role NOT IN ('blocked', 'inherit')
          AND (
            -- User owns the list
            luo.list_id IN (SELECT id FROM lists WHERE id = ANY($1::uuid[]) AND owner_id = $2)
            OR
            -- User has access to the list
            EXISTS (
              SELECT 1 FROM collaboration_group_members cgm
              WHERE cgm.group_id IN (
                SELECT shared_with_group_id FROM list_sharing
                WHERE list_id = luo.list_id AND deleted_at IS NULL
              ) AND cgm.user_id = $2
            )
            OR
            EXISTS (
              SELECT 1 FROM list_user_overrides luo2
              WHERE luo2.list_id = luo.list_id 
                AND luo2.user_id = $2 
                AND luo2.deleted_at IS NULL
                AND luo2.role NOT IN ('blocked', 'inherit')
            )
          )
        ORDER BY luo.created_at ASC`,
        [listIds, requester_id]
      );

      // Organize group shares by list_id
      groupShares.forEach(share => {
        if (results.groups[share.list_id]) {
          results.groups[share.list_id].push({
            id: share.group_id,
            name: share.group_name,
            description: share.group_description,
            permissions: share.permissions,
            member_count: parseInt(share.member_count),
            created_at: share.created_at
          });
        }
      });

      // Organize individual shares by list_id
      individualShares.forEach(share => {
        if (results.individuals[share.list_id]) {
          results.individuals[share.list_id].push({
            user_id: share.user_id,
            role: share.role,
            permissions: share.permissions,
            username: share.username,
            email: share.email,
            full_name: share.full_name,
            profile_image_url: share.profile_image_url,
            profile_display_config: share.profile_display_config
          });
        }
      });

      console.log(`[getBatchListShares] Returning shares for ${listIds.length} lists`);
      res.json(results);
    } catch (error) {
      console.error('Error batch fetching list shares:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Search connected users for collaboration
  searchUsers: async (req, res) => {
    const { q: query, limit = 10 } = req.query;
    const userId = req.user.id;

    if (!query || query.length < 2) {
      return res.json([]);
    }

    try {
      const searchQuery = `%${query}%`;
      // Only return connected users
      const { rows } = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name
         FROM users u
         INNER JOIN connections c ON c.connection_id = u.id
         WHERE c.user_id = $1
           AND c.status = 'accepted'
           AND (u.username ILIKE $2 OR u.email ILIKE $2 OR u.full_name ILIKE $2)
           AND u.deleted_at IS NULL
         LIMIT $3`,
        [userId, searchQuery, parseInt(limit)]
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
      
      // Notify all group members about the role change
      try {
        console.log(`[CollaborationController] Notifying group members about role change for list ${listId} (group: ${groupId}, new role: ${role})`);
        
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
          console.log(`[CollaborationController] Notifying user ${member.user_id} about group role change to ${role}`);
          safeSocketService.notifyUser(member.user_id, 'list_access_granted', {
            listId: listId,
            updatedBy: requester_id,
            accessType: 'group',
            groupId: groupId,
            role: role,
            timestamp: Date.now()
          });
        }
        
        console.log(`[CollaborationController] Notified ${groupMembers.length} group members about role change`);
      } catch (notifyError) {
        console.error('[CollaborationController] Failed to notify group members about role change:', notifyError);
        // Don't fail the request if notifications fail
      }
      
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
        `SELECT luo.list_id, luo.user_id, luo.role, luo.permissions, 
                u.username, u.email, u.full_name,
                u.profile_image_url, u.profile_display_config
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

  // List: set/remove per-user override (with connection and privacy checks)
  setUserRoleOverrideOnList: async (req, res) => {
    const { listId, userId } = req.params;
    const { role, permissions = null, message = null } = req.body || {};
    const requester_id = req.user.id;

    console.log('[setUserRoleOverrideOnList] Request received:', {
      listId,
      userId,
      role,
      permissions,
      requester_id,
      message,
      body: req.body
    });
    
    try {
      // Get list details
      const { rows: listRows } = await db.query('SELECT id, title, owner_id FROM lists WHERE id = $1', [listId]);
      if (listRows.length === 0) {
        console.log('[setUserRoleOverrideOnList] List not found:', listId);
        return res.status(404).json({ error: 'List not found' });
      }
      const list = listRows[0];

      if (list.owner_id !== requester_id) {
        console.log('[setUserRoleOverrideOnList] Permission denied. Owner:', list.owner_id, 'Requester:', requester_id);
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      if (!role) {
        console.log('[setUserRoleOverrideOnList] No role provided');
        return res.status(400).json({ error: 'role is required (or use "inherit" to remove override)' });
      }

      if (role === 'inherit') {
        console.log('[setUserRoleOverrideOnList] Removing override (role=inherit) for user:', userId, 'list:', listId);

        // Remove from list_user_overrides
        const { rowCount } = await db.query(
          `UPDATE public.list_user_overrides
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE list_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [listId, userId]
        );

        // Also remove any pending invitations
        await db.query(
          `UPDATE pending_list_invitations
           SET status = 'cancelled', responded_at = CURRENT_TIMESTAMP
           WHERE list_id = $1 AND invitee_id = $2 AND status = 'pending'`,
          [listId, userId]
        );

        console.log('[setUserRoleOverrideOnList] Removed override and cancelled pending invitations');

        // Notify the user about access revocation (only if we actually removed an override)
        if (rowCount > 0) {
          // Create a change_log entry marking the list as deleted for the user
          try {
            await db.query(
              `INSERT INTO public.change_log (table_name, record_id, operation, user_id, change_data, created_at)
               VALUES ('lists', $1, 'delete', $2, NULL, CURRENT_TIMESTAMP)`,
              [listId, userId]
            );
            console.log(`[setUserRoleOverrideOnList] Added delete change_log entry for user ${userId} to remove list ${listId}`);
          } catch (changeLogError) {
            console.error('[setUserRoleOverrideOnList] Failed to create delete change_log entry:', changeLogError);
          }
          
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

      // Check if users are connected
      console.log('[setUserRoleOverrideOnList] Checking connection status between users');
      const { rows: connectionCheck } = await db.query(
        `SELECT EXISTS (
          SELECT 1 FROM connections c1
          WHERE c1.user_id = $1 AND c1.connection_id = $2 AND c1.status = 'accepted'
            AND EXISTS (
              SELECT 1 FROM connections c2
              WHERE c2.user_id = $2 AND c2.connection_id = $1 AND c2.status = 'accepted'
            )
        ) as are_connected`,
        [requester_id, userId]
      );

      const areConnected = connectionCheck[0].are_connected;
      console.log('[setUserRoleOverrideOnList] Users connected:', areConnected);

      // Get invitee's privacy settings
      const { rows: privacyRows } = await db.query(
        `SELECT COALESCE((privacy_settings->>'privacy_mode')::VARCHAR, 'standard') as privacy_mode
         FROM user_settings WHERE user_id = $1`,
        [userId]
      );

      const privacyMode = privacyRows.length > 0 ? privacyRows[0].privacy_mode : 'standard';
      console.log('[setUserRoleOverrideOnList] Invitee privacy mode:', privacyMode);

      // If users are connected, apply the share immediately
      if (areConnected) {
        console.log('[setUserRoleOverrideOnList] Users are connected, applying share immediately');

        const upsert = await db.query(
          `INSERT INTO public.list_user_overrides (id, list_id, user_id, role, permissions)
             VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (list_id, user_id)
             DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
           RETURNING *`,
          [uuidv4(), listId, userId, role, permissions ? JSON.stringify(permissions) : null]
        );
        console.log('[setUserRoleOverrideOnList] Upsert successful:', upsert.rows[0]);
      
        // Create change log and notify for connected users

      // Create a change_log entry for the newly shared/blocked user so they can sync the list
      if (userId !== requester_id) {
        try {
          if (role === 'blocked') {
            // For blocked users, create a delete entry
            await db.query(
              `INSERT INTO public.change_log (table_name, record_id, operation, user_id, change_data, created_at)
               VALUES ('lists', $1, 'delete', $2, NULL, CURRENT_TIMESTAMP)`,
              [listId, userId]
            );
            console.log(`[setUserRoleOverrideOnList] Added delete change_log entry for blocked user ${userId} for list ${listId}`);
          } else {
            // For granted access, create an update entry
            const { rows: listData } = await db.query('SELECT * FROM lists WHERE id = $1', [listId]);
            if (listData.length > 0) {
              await db.query(
                `INSERT INTO public.change_log (table_name, record_id, operation, user_id, change_data, created_at)
                 VALUES ('lists', $1, 'update', $2, $3::jsonb, CURRENT_TIMESTAMP)`,
                [listId, userId, JSON.stringify(listData[0])]
              );
              console.log(`[setUserRoleOverrideOnList] Added change_log entry for user ${userId} to sync list ${listId}`);
            }
          }
        } catch (changeLogError) {
          console.error('[setUserRoleOverrideOnList] Failed to create change_log entry:', changeLogError);
          // Don't fail the whole operation if change_log fails
        }
      }

      // Notify the user about access granted/revoked (only notify if user is not the requester)
      if (userId !== requester_id) {
        try {
          if (role === 'blocked') {
            console.log(`[CollaborationController] Notifying user ${userId} about list access revoked (blocked)`);
            safeSocketService.notifyUser(userId, 'list_access_revoked', {
              listId: listId,
              updatedBy: requester_id,
              accessType: 'individual',
              timestamp: Date.now()
            });
          } else {
            console.log(`[CollaborationController] Notifying user ${userId} about list access granted (individual, role: ${role})`);
            safeSocketService.notifyUser(userId, 'list_access_granted', {
              listId: listId,
              updatedBy: requester_id,
              accessType: 'individual',
              role: role,
              timestamp: Date.now()
            });
          }
        } catch (notifyError) {
          console.error('[CollaborationController] Failed to notify user about access change:', notifyError);
        }
      }

        return res.status(201).json(upsert.rows[0]);
      }

      // Users are not connected - create a pending invitation
      console.log('[setUserRoleOverrideOnList] Users not connected, creating pending invitation');

      let connectionInvitationId = null;

      // If invitee is private, create a connection request first
      if (privacyMode === 'private') {
        console.log('[setUserRoleOverrideOnList] Invitee is private, creating connection request with list context');

        // Check if there's already a pending connection request
        const { rows: existingConnection } = await db.query(
          `SELECT id FROM connection_invitations
           WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'`,
          [requester_id, userId]
        );

        if (existingConnection.length === 0) {
          // Create connection request with list share context
          const { rows: connectionInvite } = await db.query(
            `INSERT INTO connection_invitations
             (sender_id, recipient_id, status, invitation_context, metadata, message)
             VALUES ($1, $2, 'pending', 'list_share', $3::jsonb, $4)
             RETURNING id`,
            [
              requester_id,
              userId,
              JSON.stringify({
                list_id: listId,
                list_name: list.name,
                role: role,
                permissions: permissions
              }),
              message || `I'd like to share "${list.name}" with you`
            ]
          );

          connectionInvitationId = connectionInvite[0].id;
          console.log('[setUserRoleOverrideOnList] Created connection invitation:', connectionInvitationId);

          // Create notification for connection request
          await db.query(
            `INSERT INTO notifications (user_id, notification_type, title, body, data, is_read)
             VALUES ($1, 'connection_request', 'Connection Request with List Share', $2, $3::jsonb, false)`,
            [
              userId,
              `${req.user.username || 'Someone'} wants to connect and share "${list.name}" with you`,
              JSON.stringify({
                sender_id: requester_id,
                invitation_id: connectionInvitationId,
                list_id: listId,
                list_name: list.name,
                role: role
              })
            ]
          );
        } else {
          connectionInvitationId = existingConnection[0].id;
          console.log('[setUserRoleOverrideOnList] Using existing connection invitation:', connectionInvitationId);
        }
      }

      // Create pending list invitation
      const { rows: pendingInvite } = await db.query(
        `SELECT * FROM create_or_update_pending_list_invitation($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [listId, requester_id, userId, role, permissions, message, connectionInvitationId]
      );

      const invitation = pendingInvite[0];
      console.log('[setUserRoleOverrideOnList] Created pending invitation:', invitation);

      // Create notification for list invitation (if not requiring connection)
      if (!invitation.requires_connection) {
        await db.query(
          `INSERT INTO notifications (user_id, notification_type, title, body, data, is_read)
           VALUES ($1, 'list_invitation', 'List Invitation', $2, $3::jsonb, false)`,
          [
            userId,
            `${req.user.username || 'Someone'} invited you to collaborate on "${list.name}"`,
            JSON.stringify({
              inviter_id: requester_id,
              invitation_id: invitation.invitation_id,
              list_id: listId,
              list_name: list.name,
              role: role
            })
          ]
        );
      }

      // Return response indicating pending invitation was created
      return res.status(201).json({
        success: true,
        status: 'pending',
        requiresConnection: invitation.requires_connection,
        invitation: {
          id: invitation.invitation_id,
          listId: listId,
          inviteeId: userId,
          role: role,
          status: invitation.invitation_status,
          requiresConnection: invitation.requires_connection,
          connectionInvitationId: connectionInvitationId,
          message: privacyMode === 'private'
            ? 'Connection request sent. List will be shared once connection is accepted.'
            : 'List invitation sent. Waiting for user to accept.'
        }
      });

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
        `INSERT INTO public.list_group_user_roles (list_id, group_id, user_id, role, permissions)
           VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (list_id, group_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [listId, groupId, userId, role, permissions ? JSON.stringify(permissions) : null]
      );

      // Notify the affected user about their role override
      safeSocketService.notifyUser(userId, 'list_access_granted', {
        listId: listId,
        updatedBy: req.user.id,
        accessType: 'group_override',
        groupId: groupId,
        role: role,
        timestamp: Date.now()
      });

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

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Create the group
      const { rows } = await client.query(
        'INSERT INTO collaboration_groups (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
        [name, description, owner_id]
      );

      const group = rows[0];

      // Add the owner as a member with 'owner' role
      await client.query(
        'INSERT INTO collaboration_group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
        [group.id, owner_id, 'owner']
      );

      await client.query('COMMIT');
      res.status(201).json(group);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error creating group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      client.release();
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

  // Add a member to a group (requires connection)
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

      // Check if the owner is connected to the user they're trying to add
      const connectionResult = await db.query(
        `SELECT status FROM connections
         WHERE user_id = $1 AND connection_id = $2 AND status = 'accepted'`,
        [owner_id, userId]
      );

      if (connectionResult.rows.length === 0) {
        return res.status(403).json({
          error: 'You can only add connected users to groups. Please send a connection request first.'
        });
      }

      // Check if user is already a member
      const existingMemberResult = await db.query(
        'SELECT 1 FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, userId]
      );

      if (existingMemberResult.rows.length > 0) {
        return res.status(400).json({ error: 'User is already a member of this group' });
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
        `SELECT
          m.group_id,
          m.user_id,
          m.role,
          m.joined_at,
          -- Ghost users show anonymized data unless viewer is connected
          CASE
            WHEN us.privacy_settings->>'privacy_mode' = 'ghost'
                 AND NOT public.can_view_user($2::uuid, m.user_id)
            THEN 'Anonymous Member'
            ELSE u.username
          END as username,
          -- Hide email for ghost and private users
          CASE
            WHEN us.privacy_settings->>'privacy_mode' IN ('ghost', 'private')
                 AND NOT public.can_view_user($2::uuid, m.user_id)
            THEN NULL
            ELSE u.email
          END as email,
          -- Hide full name for ghost users
          CASE
            WHEN us.privacy_settings->>'privacy_mode' = 'ghost'
                 AND NOT public.can_view_user($2::uuid, m.user_id)
            THEN NULL
            WHEN us.privacy_settings->>'privacy_mode' = 'private'
                 AND NOT public.can_view_user($2::uuid, m.user_id)
            THEN NULL
            ELSE u.full_name
          END as full_name,
          -- Hide avatar for ghost users
          CASE
            WHEN us.privacy_settings->>'privacy_mode' = 'ghost'
                 AND NOT public.can_view_user($2::uuid, m.user_id)
            THEN NULL
            ELSE u.profile_image_url
          END as avatar_url,
          -- Include privacy mode for frontend handling
          COALESCE(us.privacy_settings->>'privacy_mode', 'private') as privacy_mode,
          -- Check if anonymous in groups setting is enabled
          COALESCE((us.privacy_settings->>'anonymous_in_groups')::boolean, false) as anonymous_in_groups
        FROM collaboration_group_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE m.group_id = $1
        ORDER BY m.joined_at ASC`,
        [groupId, requester_id]
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

  // Invite a connected user to a group
  inviteUserToGroup: async (req, res) => {
    const { groupId } = req.params;
    const { userId, role = 'member' } = req.body;
    const inviter_id = req.user.id;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    try {
      // Check if the current user is the owner of the group
      const groupResult = await db.query('SELECT owner_id, name FROM collaboration_groups WHERE id = $1', [groupId]);
      if (groupResult.rows.length === 0) {
        return res.status(404).json({ error: 'Group not found' });
      }

      if (groupResult.rows[0].owner_id !== inviter_id) {
        return res.status(403).json({ error: 'Only the group owner can invite members' });
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

      // Create the group invitation with invitation_code
      const { rows } = await db.query(
        `INSERT INTO group_invitations
         (group_id, inviter_id, invitee_id, role, status, invitation_code, message)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING *`,
        [groupId, inviter_id, userId, role, invitationCode, req.body.message || null]
      );

      // Notify the invitee via socket
      if (socketService) {
        socketService.notifyUser(userId, 'group:invitation', {
          invitation: rows[0],
          group: {
            id: groupId,
            name: groupResult.rows[0].name
          },
          inviter: {
            id: inviter_id,
            username: req.user.username,
            full_name: req.user.full_name
          }
        });
      }

      res.status(201).json(rows[0]);
    } catch (error) {
      console.error('Error inviting user to group:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Accept a group invitation
  acceptGroupInvitation: async (req, res) => {
    const { invitationId } = req.params;
    const userId = req.user.id;

    try {
      // Get the invitation
      const invitationResult = await db.query(
        `SELECT * FROM group_invitations
         WHERE id = $1 AND invitee_id = $2 AND status = 'pending'`,
        [invitationId, userId]
      );

      if (invitationResult.rows.length === 0) {
        return res.status(404).json({ error: 'Invitation not found or already processed' });
      }

      const invitation = invitationResult.rows[0];

      // Begin transaction
      await db.query('BEGIN');

      // Update invitation status
      await db.query(
        `UPDATE group_invitations
         SET status = 'accepted', responded_at = NOW()
         WHERE id = $1`,
        [invitationId]
      );

      // Add user to the group
      await db.query(
        `INSERT INTO collaboration_group_members (group_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [invitation.group_id, userId, invitation.role]
      );

      await db.query('COMMIT');

      // Notify the inviter
      if (socketService) {
        socketService.notifyUser(invitation.inviter_id, 'group:invitation-accepted', {
          groupId: invitation.group_id,
          acceptedBy: {
            id: userId,
            username: req.user.username
          }
        });
      }

      res.json({ message: 'Group invitation accepted' });
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Error accepting group invitation:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Decline a group invitation
  declineGroupInvitation: async (req, res) => {
    const { invitationId } = req.params;
    const userId = req.user.id;

    try {
      const result = await db.query(
        `UPDATE group_invitations
         SET status = 'declined', responded_at = NOW()
         WHERE id = $1 AND invitee_id = $2 AND status = 'pending'
         RETURNING inviter_id, group_id`,
        [invitationId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Invitation not found or already processed' });
      }

      // Notify the inviter
      if (socketService) {
        socketService.notifyUser(result.rows[0].inviter_id, 'group:invitation-declined', {
          groupId: result.rows[0].group_id,
          declinedBy: {
            id: userId,
            username: req.user.username
          }
        });
      }

      res.json({ message: 'Group invitation declined' });
    } catch (error) {
      console.error('Error declining group invitation:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  // Get pending group invitations for the current user
  getPendingGroupInvitations: async (req, res) => {
    const userId = req.user.id;

    try {
      const { rows } = await db.query(
        `SELECT gi.*, cg.name as group_name, cg.description as group_description,
                u.username as inviter_username, u.full_name as inviter_name
         FROM group_invitations gi
         JOIN collaboration_groups cg ON cg.id = gi.group_id
         JOIN users u ON u.id = gi.inviter_id
         WHERE gi.invitee_id = $1
           AND gi.status = 'pending'
           AND gi.expires_at > NOW()
         ORDER BY gi.created_at DESC`,
        [userId]
      );

      res.json(rows);
    } catch (error) {
      console.error('Error fetching pending group invitations:', error);
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

    // Group List Attachment Consent endpoints

    // Get pending consents for the current user
    getPendingConsents: async (req, res) => {
        const userId = req.user.id;

        try {
            const result = await db.query(
                `SELECT * FROM get_pending_group_list_consents($1)`,
                [userId]
            );

            return res.json({
                success: true,
                consents: result.rows
            });
        } catch (error) {
            console.error('[getPendingConsents] Error:', error);
            return res.status(500).json({ error: 'Failed to fetch pending consents' });
        }
    },

    // Accept a consent for list attachment
    acceptConsent: async (req, res) => {
        const userId = req.user.id;
        const { consentId } = req.params;

        try {
            // Get consent details first
            const consentResult = await db.query(
                `SELECT list_id, group_id FROM group_list_attachment_consents
                 WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
                [consentId, userId]
            );

            if (consentResult.rows.length === 0) {
                return res.status(404).json({ error: 'Consent not found or already processed' });
            }

            const consent = consentResult.rows[0];

            // Accept the consent
            const result = await db.query(
                `SELECT accept_group_list_consent($1, $2, $3) as success`,
                [userId, consent.list_id, consent.group_id]
            );

            if (result.rows[0].success) {
                // Notify user via socket
                safeSocketService.notifyUser(userId, 'list_access_granted', {
                    listId: consent.list_id,
                    groupId: consent.group_id,
                    accessType: 'group_consent',
                    timestamp: Date.now()
                });

                return res.json({
                    success: true,
                    message: 'Consent granted successfully'
                });
            }

            return res.status(400).json({ error: 'Failed to grant consent' });
        } catch (error) {
            console.error('[acceptConsent] Error:', error);
            return res.status(500).json({ error: 'Failed to accept consent' });
        }
    },

    // Decline a consent for list attachment
    declineConsent: async (req, res) => {
        const userId = req.user.id;
        const { consentId } = req.params;

        try {
            // Get consent details first
            const consentResult = await db.query(
                `SELECT list_id, group_id FROM group_list_attachment_consents
                 WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
                [consentId, userId]
            );

            if (consentResult.rows.length === 0) {
                return res.status(404).json({ error: 'Consent not found or already processed' });
            }

            const consent = consentResult.rows[0];

            // Decline the consent
            const result = await db.query(
                `SELECT decline_group_list_consent($1, $2, $3) as success`,
                [userId, consent.list_id, consent.group_id]
            );

            if (result.rows[0].success) {
                return res.json({
                    success: true,
                    message: 'Consent declined successfully'
                });
            }

            return res.status(400).json({ error: 'Failed to decline consent' });
        } catch (error) {
            console.error('[declineConsent] Error:', error);
            return res.status(500).json({ error: 'Failed to decline consent' });
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

    // Get all invitations for a specific group
    getGroupInvitations: async (req, res) => {
      const { groupId } = req.params;
      const userId = req.user?.id;

      try {
        // First check if user is a member or owner of the group
        const memberCheck = await db.query(
          `SELECT 1 FROM collaboration_groups WHERE id = $1 AND owner_id = $2
           UNION
           SELECT 1 FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [groupId, userId]
        );

        if (memberCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Not authorized to view group invitations' });
        }

        // Get all pending invitations for the group
        const result = await db.query(
          `WITH group_invitations_data AS (
            -- Regular invitations
            SELECT
              gi.id,
              gi.group_id,
              gi.inviter_id,
              gi.invitee_id,
              gi.role,
              gi.status,
              gi.message,
              gi.created_at,
              gi.expires_at,
              'invitation' as invitation_type
            FROM group_invitations gi
            WHERE gi.group_id = $1
              AND gi.status = 'pending'
              AND gi.expires_at > NOW()

            UNION ALL

            -- Pending group invitations (connection-based)
            SELECT
              pgi.id::uuid,
              pgi.group_id,
              pgi.inviter_id,
              pgi.invitee_id,
              'member' as role,
              CASE
                WHEN ci.status = 'declined' THEN 'pending_connection'::text
                ELSE 'pending_connection'::text
              END as status,
              pgi.message,
              pgi.created_at,
              CURRENT_TIMESTAMP + INTERVAL '30 days' as expires_at,
              'pending' as invitation_type
            FROM pending_group_invitations pgi
            LEFT JOIN connections ci ON ci.id = pgi.connection_invitation_id
            WHERE pgi.group_id = $1
          )
          SELECT
            gid.*,
            u.username as invitee_username,
            u.full_name as invitee_name,
            u.profile_image_url as invitee_profile_picture,
            inviter.username as inviter_username,
            inviter.full_name as inviter_name
          FROM group_invitations_data gid
          JOIN users u ON u.id = gid.invitee_id
          JOIN users inviter ON inviter.id = gid.inviter_id
          ORDER BY gid.created_at DESC`,
          [groupId]
        );

        res.json({
          invitations: result.rows
        });
      } catch (error) {
        console.error('Error fetching group invitations:', error);
        res.status(500).json({ error: 'Failed to fetch group invitations' });
      }
    },
};

  return CollaborationController;
}

module.exports = collaborationControllerFactory; 