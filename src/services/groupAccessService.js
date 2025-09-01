const db = require('../config/db');
const { logger } = require('../utils/logger');

/**
 * Service for verifying group-based access to lists
 * Handles complex group membership and permission checks
 */
class GroupAccessService {
  /**
   * Check if a user has access to a list through group membership
   * @param {string} userId - The user ID to check
   * @param {string} listId - The list ID to check access for
   * @returns {Object} Access information including access type and group name
   */
  static async checkGroupAccess(userId, listId) {
    try {
      // First check if user owns the list
      const ownerCheck = await db.query(
        'SELECT owner_id FROM lists WHERE id = $1 AND deleted_at IS NULL',
        [listId]
      );
      
      if (ownerCheck.rows.length > 0 && ownerCheck.rows[0].owner_id === userId) {
        return {
          hasAccess: true,
          accessType: 'owner',
          groupName: null
        };
      }

      // Check public access
      const publicCheck = await db.query(
        'SELECT is_public FROM lists WHERE id = $1 AND deleted_at IS NULL',
        [listId]
      );
      
      if (publicCheck.rows.length > 0 && publicCheck.rows[0].is_public === true) {
        return {
          hasAccess: true,
          accessType: 'public',
          groupName: null
        };
      }

      // Check group access through list_group_roles
      const groupRoleCheck = await db.query(`
        SELECT lgr.role, cg.name as group_name
        FROM list_group_roles lgr
        JOIN collaboration_groups cg ON lgr.group_id = cg.id
        JOIN collaboration_group_members cgm ON cg.id = cgm.group_id
        WHERE lgr.list_id = $1 
          AND cgm.user_id = $2
          AND lgr.deleted_at IS NULL
          AND cg.deleted_at IS NULL
          AND cgm.deleted_at IS NULL
        LIMIT 1
      `, [listId, userId]);

      if (groupRoleCheck.rows.length > 0) {
        return {
          hasAccess: true,
          accessType: 'group_member',
          groupName: groupRoleCheck.rows[0].group_name,
          role: groupRoleCheck.rows[0].role
        };
      }

      // Check group access through list_sharing (legacy)
      const listSharingCheck = await db.query(`
        SELECT cg.name as group_name
        FROM list_sharing ls
        JOIN collaboration_groups cg ON ls.shared_with_group_id = cg.id
        JOIN collaboration_group_members cgm ON cg.id = cgm.group_id
        WHERE ls.list_id = $1 
          AND cgm.user_id = $2
          AND ls.deleted_at IS NULL
          AND cg.deleted_at IS NULL
          AND cgm.deleted_at IS NULL
        LIMIT 1
      `, [listId, userId]);

      if (listSharingCheck.rows.length > 0) {
        return {
          hasAccess: true,
          accessType: 'group_shared_legacy',
          groupName: listSharingCheck.rows[0].group_name
        };
      }

      // Check individual user overrides
      const userOverrideCheck = await db.query(`
        SELECT role
        FROM list_user_overrides
        WHERE list_id = $1 
          AND user_id = $2 
          AND role != 'blocked'
          AND deleted_at IS NULL
        LIMIT 1
      `, [listId, userId]);

      if (userOverrideCheck.rows.length > 0) {
        return {
          hasAccess: true,
          accessType: 'individual_override',
          groupName: null,
          role: userOverrideCheck.rows[0].role
        };
      }

      // No access found
      return {
        hasAccess: false,
        accessType: 'no_access',
        groupName: null
      };
      
    } catch (error) {
      logger.error(`[GroupAccessService] Error checking group access:`, error);
      return {
        hasAccess: false,
        accessType: 'error',
        groupName: null,
        error: error.message
      };
    }
  }

  /**
   * Get all groups a user is a member of
   * @param {string} userId - The user ID
   * @returns {Array} List of groups with details
   */
  static async getUserGroups(userId) {
    try {
      const query = `
        SELECT DISTINCT 
          cg.id,
          cg.name,
          cg.description,
          CASE 
            WHEN cg.owner_id = $1 THEN 'owner'
            ELSE 'member'
          END as role
        FROM collaboration_groups cg
        LEFT JOIN collaboration_group_members cgm ON cg.id = cgm.group_id
        WHERE (cg.owner_id = $1 OR cgm.user_id = $1)
          AND cg.deleted_at IS NULL
          AND (cgm.deleted_at IS NULL OR cgm.deleted_at IS NULL)
        ORDER BY cg.name
      `;
      
      const { rows } = await db.query(query, [userId]);
      return rows;
      
    } catch (error) {
      logger.error(`[GroupAccessService] Error fetching user groups:`, error);
      return [];
    }
  }

  /**
   * Verify if two users share any groups
   * @param {string} userId1 - First user ID
   * @param {string} userId2 - Second user ID
   * @returns {Object} Information about shared groups
   */
  static async checkSharedGroups(userId1, userId2) {
    try {
      const query = `
        WITH user1_groups AS (
          SELECT group_id FROM collaboration_group_members 
          WHERE user_id = $1 AND deleted_at IS NULL
          UNION
          SELECT id as group_id FROM collaboration_groups 
          WHERE owner_id = $1 AND deleted_at IS NULL
        ),
        user2_groups AS (
          SELECT group_id FROM collaboration_group_members 
          WHERE user_id = $2 AND deleted_at IS NULL
          UNION
          SELECT id as group_id FROM collaboration_groups 
          WHERE owner_id = $2 AND deleted_at IS NULL
        )
        SELECT cg.id, cg.name
        FROM collaboration_groups cg
        WHERE cg.id IN (SELECT group_id FROM user1_groups)
          AND cg.id IN (SELECT group_id FROM user2_groups)
          AND cg.deleted_at IS NULL
      `;
      
      const { rows } = await db.query(query, [userId1, userId2]);
      
      return {
        hasSharedGroups: rows.length > 0,
        sharedGroups: rows,
        count: rows.length
      };
      
    } catch (error) {
      logger.error(`[GroupAccessService] Error checking shared groups:`, error);
      return {
        hasSharedGroups: false,
        sharedGroups: [],
        count: 0,
        error: error.message
      };
    }
  }

  /**
   * Get all lists accessible to a user through groups
   * @param {string} userId - The user ID
   * @param {string} targetUserId - The owner of the lists
   * @returns {Array} List of accessible lists with access details
   */
  static async getGroupAccessibleLists(userId, targetUserId) {
    try {
      const query = `
        WITH user_groups AS (
          SELECT DISTINCT cgm.group_id, cg.name as group_name
          FROM collaboration_group_members cgm
          JOIN collaboration_groups cg ON cgm.group_id = cg.id
          WHERE cgm.user_id = $1 
            AND cgm.deleted_at IS NULL
            AND cg.deleted_at IS NULL
          UNION
          SELECT id as group_id, name as group_name
          FROM collaboration_groups 
          WHERE owner_id = $1 AND deleted_at IS NULL
        )
        SELECT DISTINCT
          l.id,
          l.title,
          l.is_public,
          COALESCE(
            (SELECT ug.group_name FROM list_group_roles lgr
             JOIN user_groups ug ON lgr.group_id = ug.group_id
             WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL
             LIMIT 1),
            (SELECT ug.group_name FROM list_sharing ls
             JOIN user_groups ug ON ls.shared_with_group_id = ug.group_id
             WHERE ls.list_id = l.id AND ls.deleted_at IS NULL
             LIMIT 1)
          ) as access_via_group
        FROM lists l
        WHERE l.owner_id = $2
          AND l.deleted_at IS NULL
          AND l.is_public = false
          AND (
            EXISTS (
              SELECT 1 FROM list_group_roles lgr
              JOIN user_groups ug ON lgr.group_id = ug.group_id
              WHERE lgr.list_id = l.id AND lgr.deleted_at IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM list_sharing ls
              JOIN user_groups ug ON ls.shared_with_group_id = ug.group_id
              WHERE ls.list_id = l.id AND ls.deleted_at IS NULL
            )
          )
      `;
      
      const { rows } = await db.query(query, [userId, targetUserId]);
      
      logger.info(`[GroupAccessService] Found ${rows.length} group-accessible lists for user ${userId} from owner ${targetUserId}`);
      
      return rows;
      
    } catch (error) {
      logger.error(`[GroupAccessService] Error fetching group-accessible lists:`, error);
      return [];
    }
  }
}

module.exports = GroupAccessService;