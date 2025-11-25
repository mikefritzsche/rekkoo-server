const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const db = require('../config/db');
const invitationService = require('../services/invitationService');
const { 
  getStats: getCacheStats, 
  listKeys, 
  getKey, 
  deleteKey, 
  clearCache, 
  getCacheSettings, 
  updateCacheSettings 
} = require('../controllers/CacheController');
const { performHardDelete } = require('../services/hardDeleteService');
const { clearChangeLogForUser } = require('../services/changeLogService');
const { exportUserData } = require('../services/exportService');
const r2AdminControllerFactory = require('../controllers/R2AdminController');
const bcrypt = require('bcrypt');

const router = express.Router();
const r2AdminController = r2AdminControllerFactory();
const saltRounds = 12;

// Helper to verify admin role via user_roles table
async function ensureAdmin(userId) {
  const res = await db.query(
    `SELECT 1 FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.name = 'admin'
     WHERE ur.user_id = $1
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

let favoritesSchemaCache = null;
async function getFavoritesSchema() {
  if (favoritesSchemaCache) {
    return favoritesSchemaCache;
  }

  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'favorites'`
  );
  const columns = rows.map((row) => row.column_name);
  favoritesSchemaCache = {
    columns,
    hasListColumns: columns.includes('list_id') && columns.includes('list_item_id'),
    hasTargetColumns: columns.includes('target_type') && columns.includes('target_id'),
    hasTargetListColumn: columns.includes('target_list_id'),
  };
  return favoritesSchemaCache;
}

// GET /v1.0/admin/users – list users (paginated optional)
router.get('/users', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const usersRes = await db.query(
      `SELECT u.id, u.username, u.email, u.created_at, array_remove(array_agg(r.name), NULL) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    res.json({ users: usersRes.rows });
  } catch (err) {
    console.error('Admin users list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/users/:userId/settings – inspect user settings/preferences
router.get('/users/:userId/settings', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }
    const { userId } = req.params;
    const { rows } = await db.query(
      `SELECT
         u.id,
         u.username,
         u.email,
         u.full_name,
         us.privacy_settings,
         us.notification_preferences,
         us.created_at,
         us.updated_at
       FROM users u
       LEFT JOIN user_settings us ON us.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    res.json({ settings: rows[0] });
  } catch (err) {
    console.error('Admin user settings fetch error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/roles – list all available roles
router.get('/roles', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const rolesRes = await db.query(
      `SELECT id, name, description, created_at
       FROM roles
       WHERE deleted_at IS NULL
       ORDER BY name`,
    );

    res.json({ roles: rolesRes.rows });
  } catch (err) {
    console.error('Admin roles list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /v1.0/admin/roles – create or restore a role
router.post('/roles', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { name, description } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ message: 'Role name is required' });
    }

    const normalizedName = name.trim();
    if (!normalizedName) {
      return res.status(400).json({ message: 'Role name cannot be empty' });
    }

    const existing = await db.query(
      `SELECT id, deleted_at FROM roles WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [normalizedName],
    );

    let roleRow;
    if (existing.rows.length) {
      const role = existing.rows[0];
      if (role.deleted_at) {
        const { rows } = await db.query(
          `UPDATE roles
           SET deleted_at = NULL,
               name = $2,
               description = $3
           WHERE id = $1
           RETURNING id, name, description, created_at`,
          [role.id, normalizedName, description || null],
        );
        roleRow = rows[0];
      } else {
        return res.status(409).json({ message: 'Role name already exists' });
      }
    } else {
      const { rows } = await db.query(
        `INSERT INTO roles (name, description)
         VALUES ($1, $2)
         RETURNING id, name, description, created_at`,
        [normalizedName, description || null],
      );
      roleRow = rows[0];
    }

    return res.status(201).json({ role: roleRow });
  } catch (err) {
    console.error('Admin create role error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /v1.0/admin/roles/:roleId – update name/description
router.put('/roles/:roleId', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { roleId } = req.params;
    const { name, description } = req.body || {};

    if (!name && description === undefined) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    if (name && !name.trim()) {
      return res.status(400).json({ message: 'Role name cannot be empty' });
    }

    if (name) {
      const { rows } = await db.query(
        `SELECT id FROM roles
         WHERE LOWER(name) = LOWER($1) AND id <> $2 AND deleted_at IS NULL
         LIMIT 1`,
        [name.trim(), roleId],
      );
      if (rows.length) {
        return res.status(409).json({ message: 'Role name already exists' });
      }
    }

    const { rows } = await db.query(
      `UPDATE roles
       SET name = COALESCE($2, name),
           description = $3
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, name, description, created_at`,
      [roleId, name ? name.trim() : null, description ?? null],
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Role not found' });
    }

    return res.json({ role: rows[0] });
  } catch (err) {
    console.error('Admin update role error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /v1.0/admin/roles/:roleId – soft delete role
router.delete('/roles/:roleId', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { roleId } = req.params;
    const { rows } = await db.query(
      `UPDATE roles
       SET deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [roleId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'Role not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete role error', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// PUT /v1.0/admin/users/:userId/roles – assign/remove roles for a user
router.put('/users/:userId/roles', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { userId } = req.params;
    const { roleIds } = req.body; // Array of role IDs to assign

    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ message: 'roleIds must be an array' });
    }

    // Validate that the user exists
    const userCheck = await db.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Validate that all role IDs exist
    if (roleIds.length > 0) {
      const roleCheck = await db.query(
        'SELECT id FROM roles WHERE id = ANY($1) AND deleted_at IS NULL',
        [roleIds]
      );
      if (roleCheck.rows.length !== roleIds.length) {
        return res.status(400).json({ message: 'One or more role IDs are invalid' });
      }
    }

    // Start transaction
    await db.query('BEGIN');

    try {
      // Fetch all current roles for the user (both active and soft-deleted)
      const { rows: existingRoles } = await db.query(
        'SELECT role_id, deleted_at FROM user_roles WHERE user_id = $1',
        [userId],
      );

      const existingRoleMap = new Map(existingRoles.map((r) => [r.role_id, r]));
      const desiredRoleIds = new Set(roleIds);

      // Roles to soft-delete: currently active but not in the desired list
      const rolesToDelete = existingRoles
        .filter((r) => r.deleted_at === null && !desiredRoleIds.has(r.role_id))
        .map((r) => r.role_id);

      if (rolesToDelete.length > 0) {
        await db.query(
          'UPDATE user_roles SET deleted_at = NOW() WHERE user_id = $1 AND role_id = ANY($2)',
          [userId, rolesToDelete],
        );
      }

      // Roles to reactivate: currently soft-deleted but in the desired list
      const rolesToReactivate = existingRoles
        .filter((r) => r.deleted_at !== null && desiredRoleIds.has(r.role_id))
        .map((r) => r.role_id);

      if (rolesToReactivate.length > 0) {
        await db.query(
          'UPDATE user_roles SET deleted_at = NULL, assigned_at = NOW(), assigned_by = $1 WHERE user_id = $2 AND role_id = ANY($3)',
          [req.user.id, userId, rolesToReactivate],
        );
      }

      // Roles to insert: in the desired list but not in our records for this user at all
      const rolesToInsert = roleIds.filter((id) => !existingRoleMap.has(id));

      if (rolesToInsert.length > 0) {
        await db.query(
          `INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
           SELECT $1, role_id, NOW(), $2
           FROM UNNEST($3::uuid[]) AS t(role_id)`,
          [userId, req.user.id, rolesToInsert],
        );
      }
      await db.query('COMMIT');

      // Return updated user with roles
      const updatedUser = await db.query(
        `SELECT u.id, u.username, u.email, u.created_at, array_remove(array_agg(r.name), NULL) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
         LEFT JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
         WHERE u.id = $1
         GROUP BY u.id`,
        [userId]
      );

      res.json({ user: updatedUser.rows[0] });
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('Admin assign roles error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /v1.0/admin/users/:userId/password – change user password as admin
router.post('/users/:userId/password', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { userId } = req.params;
    // The admin app sends { password }, not { newPassword }
    const { password, newPassword } = req.body;
    const passwordToUse = password || newPassword;

    // Debug logging
    console.log('Admin password change request:', {
      userId,
      hasPassword: !!password,
      hasNewPassword: !!newPassword,
      passwordToUse: passwordToUse ? '***' : 'undefined',
      passwordLength: passwordToUse ? passwordToUse.length : 0,
      bodyKeys: Object.keys(req.body),
      fullBody: req.body
    });

    // Validate new password
    if (!passwordToUse || passwordToUse.length < 8) {
      console.log('Password validation failed:', {
        hasPassword: !!passwordToUse,
        length: passwordToUse ? passwordToUse.length : 0
      });
      return res.status(400).json({ message: 'Password must be at least 8 characters long' });
    }

    // Check if user exists
    const userCheck = await db.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Hash the new password
    const newPasswordHash = await bcrypt.hash(passwordToUse, saltRounds);

    // Update the user's password
    await db.query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [newPasswordHash, userId]
    );

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Admin password change error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/metrics – basic counts
router.get('/metrics', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const [{ rows: usersCnt },
           { rows: listsCnt },
           { rows: queueCnt },
           { rows: invitesCnt }] = await Promise.all([
      db.query('SELECT COUNT(*) FROM users  WHERE deleted_at IS NULL'),
      db.query('SELECT COUNT(*) FROM lists  WHERE deleted_at IS NULL'),
      db.query("SELECT COUNT(*) FROM embedding_queue WHERE status = 'pending'"),
      db.query("SELECT COUNT(*) FROM invitations WHERE status = 'pending' AND deleted_at IS NULL")
    ]);

    res.json({
      totalUsers:        Number(usersCnt[0].count),
      activeLists:       Number(listsCnt[0].count),
      embeddingsPending: Number(queueCnt[0].count),
      pendingInvitations: Number(invitesCnt[0].count)
    });
  } catch (err) {
    console.error('Admin metrics error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/lists – paginated list overview
router.get('/lists', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const listsRes = await db.query(
      `SELECT l.id,
              l.title,
              l.is_public,
              l.is_collaborative,
              l.created_at,
              u.email        AS owner_email,
              u.username     AS owner_username,
              COUNT(li.id)   AS item_count,
              COUNT(*) OVER() AS total_count
       FROM   lists l
       JOIN   users u ON u.id = l.owner_id
       LEFT JOIN list_items li ON li.list_id = l.id AND li.deleted_at IS NULL
       WHERE  l.deleted_at IS NULL
       GROUP BY l.id, u.email, u.username
       ORDER BY l.created_at DESC
       LIMIT  $1 OFFSET $2`,
      [limit, offset],
    );

    const lists = listsRes.rows;
    const total = lists.length ? parseInt(lists[0].total_count, 10) : 0;
    lists.forEach((r) => delete r.total_count);
    res.json({ lists, total });
  } catch (err) {
    console.error('Admin lists error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /v1.0/admin/lists/:id – soft-delete
router.delete('/lists/:id', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    await db.query('UPDATE lists SET deleted_at = NOW() WHERE id = $1', [req.params.id]);
    res.sendStatus(204);
  } catch (err) {
    console.error('Admin delete list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /v1.0/admin/lists/:id – update fields
router.put('/lists/:id', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { title, is_public } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }
    if (is_public !== undefined) {
      fields.push(`is_public = $${idx++}`);
      values.push(is_public);
    }

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(req.params.id);

    await db.query(`UPDATE lists SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    res.sendStatus(204);
  } catch (err) {
    console.error('Admin update list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/favorites – global favorites overview
router.get('/favorites', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const limit = Math.max(Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200), 1);
    const offset = Math.max(parseInt(req.query.offset ?? '0', 10) || 0, 0);
    const includeDeletedFlag = String(
      req.query.includeDeleted ?? req.query.include_deleted ?? 'false',
    ).toLowerCase();
    const includeDeleted = ['true', '1', 'yes'].includes(includeDeletedFlag);
    const userFilter = req.query.userId || req.query.user_id || null;
    const searchTermRaw = (req.query.search || '').toString().trim();
    const sortParam = (req.query.sort || '').toString().trim().toLowerCase();

    const schema = await getFavoritesSchema();

    const params = [];
    const filters = [];

    if (!includeDeleted) {
      filters.push('f.deleted_at IS NULL');
    }

    if (userFilter) {
      params.push(userFilter);
      filters.push(`f.user_id = $${params.length}`);
    }

    filters.push('(l.deleted_at IS NULL OR l.id IS NULL)');
    filters.push('(li.deleted_at IS NULL OR li.id IS NULL)');

    const joinClauses = [];
    let selectColumns = [];

    const targetTypeExpr = schema.hasListColumns
      ? "CASE WHEN f.list_item_id IS NOT NULL THEN 'item' ELSE 'list' END"
      : "LOWER(COALESCE(f.target_type, ''))";

    const targetIdExpr = schema.hasListColumns
      ? 'CASE WHEN f.list_item_id IS NOT NULL THEN f.list_item_id ELSE f.list_id END'
      : 'f.target_id';

    const sameTargetCondition = schema.hasListColumns
      ? `((f.list_item_id IS NOT NULL AND fav.list_item_id = f.list_item_id) OR (f.list_item_id IS NULL AND fav.list_id = f.list_id))`
      : `(LOWER(COALESCE(fav.target_type, '')) = ${targetTypeExpr} AND fav.target_id = ${targetIdExpr})`;

    const likersJoin = `LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS total_likers,
        json_agg(
          json_build_object(
            'id', fav.user_id,
            'email', fav_u.email,
            'username', fav_u.username,
            'name', COALESCE(NULLIF(fav_u.full_name, ''), fav_u.username),
            'favorited_at', fav.created_at
          )
          ORDER BY fav.created_at DESC
        ) AS likers
      FROM public.favorites fav
      JOIN public.users fav_u ON fav_u.id = fav.user_id
      WHERE ${sameTargetCondition}
        ${includeDeleted ? '' : 'AND fav.deleted_at IS NULL'}
    ) liker_details ON TRUE`;

    if (schema.hasListColumns) {
      joinClauses.push('JOIN public.users u ON u.id = f.user_id');
      joinClauses.push('LEFT JOIN public.list_items li ON f.list_item_id = li.id');
      joinClauses.push('LEFT JOIN public.lists l ON COALESCE(f.list_id, li.list_id) = l.id');
      joinClauses.push('LEFT JOIN public.users entity_owner ON entity_owner.id = COALESCE(li.owner_id, l.owner_id)');
      joinClauses.push('LEFT JOIN public.users list_owner ON l.owner_id = list_owner.id');
      if (schema.columns.includes('category_id')) {
        joinClauses.push('LEFT JOIN public.favorite_categories fc ON f.category_id = fc.id');
      }
      joinClauses.push(likersJoin);

      selectColumns = [
        'f.id',
        'f.user_id',
        'u.email AS user_email',
        'u.username AS user_username',
        "COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name",
        "CASE WHEN f.list_item_id IS NOT NULL THEN 'item' ELSE 'list' END AS target_type",
        'CASE WHEN f.list_item_id IS NOT NULL THEN f.list_item_id ELSE f.list_id END AS target_id',
        'COALESCE(f.list_id, li.list_id) AS target_list_id',
        'f.list_id',
        'f.list_item_id AS item_id',
        'COALESCE(li.title, l.title) AS target_title',
        'l.title AS list_title',
        'li.title AS item_title',
        'f.created_at',
        'f.updated_at',
        'f.deleted_at',
        'entity_owner.id AS entity_owner_id',
        'entity_owner.email AS entity_owner_email',
        'entity_owner.username AS entity_owner_username',
        "COALESCE(NULLIF(entity_owner.full_name, ''), entity_owner.username) AS entity_owner_name",
        'l.owner_id AS list_owner_id',
        'list_owner.email AS list_owner_email',
        'list_owner.username AS list_owner_username',
        "COALESCE(NULLIF(list_owner.full_name, ''), list_owner.username) AS list_owner_name",
        'li.owner_id AS item_owner_id',
        'l.list_type AS list_type',
        'l.is_public AS list_is_public',
        'li.status AS item_status',
        'li.price AS item_price',
        'li.priority AS item_priority',
        'li.link AS item_link',
        'li.description AS item_description'
      ];

      if (schema.columns.includes('category_id')) {
        selectColumns.push('f.category_id', 'fc.name AS category_name', 'fc.color AS category_color', 'fc.icon AS category_icon');
      }
      if (schema.columns.includes('is_public')) {
        selectColumns.push('f.is_public');
      }
      if (schema.columns.includes('sort_order')) {
        selectColumns.push('f.sort_order');
      }
      if (schema.columns.includes('notes')) {
        selectColumns.push('f.notes');
      }
      if (schema.columns.includes('custom_fields')) {
        selectColumns.push('f.custom_fields');
      }
      selectColumns.push('liker_details.total_likers', 'liker_details.likers');
    } else {
      const targetListExpr = schema.hasTargetListColumn ? 'f.target_list_id' : 'NULL::uuid';
      const itemJoinCondition = schema.hasTargetColumns
        ? "(LOWER(f.target_type) = 'item' AND f.target_id = li.id)"
        : 'FALSE';
      const listJoinConditions = [];
      if (schema.hasTargetColumns) {
        listJoinConditions.push("(LOWER(f.target_type) = 'list' AND f.target_id = l.id)");
        listJoinConditions.push("(LOWER(f.target_type) = 'item' AND li.list_id = l.id)");
        if (schema.hasTargetListColumn) {
          listJoinConditions.push("(LOWER(f.target_type) = 'item' AND f.target_list_id = l.id)");
        }
      }
      const listJoinCondition = listJoinConditions.length ? listJoinConditions.join(' OR ') : 'FALSE';

      joinClauses.push('JOIN public.users u ON u.id = f.user_id');
      joinClauses.push(`LEFT JOIN public.list_items li ON ${itemJoinCondition}`);
      joinClauses.push(`LEFT JOIN public.lists l ON ${listJoinCondition}`);
      joinClauses.push('LEFT JOIN public.users entity_owner ON entity_owner.id = COALESCE(li.owner_id, l.owner_id)');
      joinClauses.push('LEFT JOIN public.users list_owner ON l.owner_id = list_owner.id');
      if (schema.columns.includes('category_id')) {
        joinClauses.push('LEFT JOIN public.favorite_categories fc ON f.category_id = fc.id');
      }
      joinClauses.push(likersJoin);

      selectColumns = [
        'f.id',
        'f.user_id',
        'u.email AS user_email',
        'u.username AS user_username',
        "COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name",
        "LOWER(COALESCE(f.target_type, '')) AS target_type",
        'f.target_id',
        `${targetListExpr} AS target_list_id`,
        `CASE WHEN LOWER(COALESCE(f.target_type, '')) = 'list' THEN f.target_id ELSE ${targetListExpr} END AS list_id`,
        "CASE WHEN LOWER(COALESCE(f.target_type, '')) = 'item' THEN f.target_id ELSE NULL END AS item_id",
        "CASE WHEN LOWER(COALESCE(f.target_type, '')) = 'item' THEN li.title ELSE l.title END AS target_title",
        'l.title AS list_title',
        'li.title AS item_title',
        'f.created_at',
        'f.updated_at',
        'f.deleted_at',
        'entity_owner.id AS entity_owner_id',
        'entity_owner.email AS entity_owner_email',
        'entity_owner.username AS entity_owner_username',
        "COALESCE(NULLIF(entity_owner.full_name, ''), entity_owner.username) AS entity_owner_name",
        'l.owner_id AS list_owner_id',
        'list_owner.email AS list_owner_email',
        'list_owner.username AS list_owner_username',
        "COALESCE(NULLIF(list_owner.full_name, ''), list_owner.username) AS list_owner_name",
        'li.owner_id AS item_owner_id',
        'l.list_type AS list_type',
        'l.is_public AS list_is_public',
        'li.status AS item_status',
        'li.price AS item_price',
        'li.priority AS item_priority',
        'li.link AS item_link',
        'li.description AS item_description'
      ];

      if (schema.columns.includes('category_id')) {
        selectColumns.push('f.category_id', 'fc.name AS category_name', 'fc.color AS category_color', 'fc.icon AS category_icon');
      }
      if (schema.columns.includes('is_public')) {
        selectColumns.push('f.is_public');
      }
      if (schema.columns.includes('sort_order')) {
        selectColumns.push('f.sort_order');
      }
      if (schema.columns.includes('notes')) {
        selectColumns.push('f.notes');
      }
      if (schema.columns.includes('custom_fields')) {
        selectColumns.push('f.custom_fields');
      }
      selectColumns.push('liker_details.total_likers', 'liker_details.likers');
    }

    const searchTerm = searchTermRaw.toLowerCase();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      const idx = params.length;
      const searchableExpressions = [
        'LOWER(u.email)',
        'LOWER(u.username)',
        "LOWER(COALESCE(u.full_name, ''))",
        "LOWER(COALESCE(entity_owner.email, ''))",
        "LOWER(COALESCE(entity_owner.username, ''))",
        "LOWER(COALESCE(entity_owner.full_name, ''))",
        "LOWER(COALESCE(l.title, ''))",
        "LOWER(COALESCE(li.title, ''))",
      ];
      if (schema.columns.includes('notes')) {
        searchableExpressions.push("LOWER(COALESCE(f.notes, ''))");
      }
      filters.push(`(${searchableExpressions.map((expr) => `${expr} LIKE $${idx}`).join(' OR ')})`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const joinsSql = joinClauses.length ? joinClauses.join('\n    ') : '';

    let orderClause = 'ORDER BY f.created_at DESC';
    if (sortParam) {
      const [field, directionRaw] = sortParam.split(':');
      const direction = directionRaw === 'asc' ? 'ASC' : 'DESC';
      switch (field) {
        case 'created_at':
          orderClause = `ORDER BY f.created_at ${direction}`;
          break;
        case 'target_title':
          orderClause = `ORDER BY target_title ${direction}, f.created_at DESC`;
          break;
        case 'target_type':
          orderClause = `ORDER BY target_type ${direction}, target_title ASC`;
          break;
        case 'user':
          orderClause = `ORDER BY u.email ${direction}, target_title ASC`;
          break;
        default:
          break;
      }
    }

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const dataQuery = `
      SELECT
        ${selectColumns.join(',\n        ')}
      FROM public.favorites f
        ${joinsSql ? `\n        ${joinsSql}` : ''}
      ${whereSql ? `${whereSql}\n` : ''}
      ${orderClause}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM public.favorites f
        ${joinsSql ? `\n        ${joinsSql}` : ''}
      ${whereSql}
    `;

    const queryParams = params.concat([limit, offset]);
    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, queryParams),
      db.query(countQuery, params),
    ]);

    const total = countResult.rows[0] ? Number(countResult.rows[0].total) : 0;
    res.json({
      favorites: dataResult.rows,
      total,
      limit,
      offset,
      hasMore: total > offset + dataResult.rows.length,
    });
  } catch (err) {
    console.error('Admin favorites list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /v1.0/admin/favorites/:favoriteId – soft delete a favorite
router.delete('/favorites/:favoriteId', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { favoriteId } = req.params;
    if (!favoriteId) {
      return res.status(400).json({ message: 'Favorite ID is required' });
    }

    const schema = await getFavoritesSchema();
    const updateColumns = schema.columns.includes('updated_at')
      ? 'deleted_at = NOW(), updated_at = NOW()'
      : 'deleted_at = NOW()';

    const result = await db.query(
      `UPDATE public.favorites
         SET ${updateColumns}
       WHERE id = $1
       RETURNING id`,
      [favoriteId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Favorite not found' });
    }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Admin delete favorite error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ===== INVITATION MANAGEMENT ROUTES =====

// GET /v1.0/admin/invitations – list all invitations (paginated)
router.get('/invitations', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);

    const invitationsRes = await db.query(
      `SELECT i.id,
              i.email,
              i.invitation_code,
              i.status,
              i.expires_at,
              i.created_at,
              i.accepted_at,
              u.username AS inviter_username,
              u.email AS inviter_email,
              au.username AS accepted_by_username,
              au.email AS accepted_by_email,
              COUNT(*) OVER() AS total_count
       FROM invitations i
       JOIN users u ON u.id = i.inviter_id
       LEFT JOIN users au ON au.id = i.accepted_by_user_id
       WHERE i.deleted_at IS NULL
       ORDER BY i.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const invitations = invitationsRes.rows;
    const total = invitations.length ? parseInt(invitations[0].total_count, 10) : 0;
    invitations.forEach((r) => delete r.total_count);
    
    res.json({ invitations, total });
  } catch (err) {
    console.error('Admin invitations list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/invitation-stats – get invitation statistics
router.get('/invitation-stats', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const stats = await invitationService.getInvitationStats();
    res.json({ stats });
  } catch (err) {
    console.error('Admin invitation stats error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE /v1.0/admin/invitations/:id – cancel/delete invitation
router.delete('/invitations/:id', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const invitationId = req.params.id;
    
    // Admin can force cancel any invitation by setting status to cancelled
    await db.query(
      'UPDATE invitations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['cancelled', invitationId]
    );
    
    res.json({ success: true, message: 'Invitation cancelled' });
  } catch (err) {
    console.error('Admin cancel invitation error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /v1.0/admin/invitations/:id/resend – resend invitation
router.post('/invitations/:id/resend', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const invitationId = req.params.id;
    
    // Get invitation details
    const invitationRes = await db.query(
      `SELECT i.*, u.username as inviter_username
       FROM invitations i
       JOIN users u ON i.inviter_id = u.id
       WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [invitationId]
    );

    if (invitationRes.rows.length === 0) {
      return res.status(404).json({ message: 'Invitation not found' });
    }

    const invitation = invitationRes.rows[0];

    if (invitation.status !== 'pending') {
      return res.status(400).json({ message: 'Can only resend pending invitations' });
    }

    // Resend email
    await invitationService.sendInvitationEmail(invitation);
    
    res.json({ success: true, message: 'Invitation resent' });
  } catch (err) {
    console.error('Admin resend invitation error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/users/:userId/invitations – get invitations for a specific user
router.get('/users/:userId/invitations', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { userId } = req.params;
    const invitations = await invitationService.getInvitationsByInviter(userId);
    
    res.json({ invitations });
  } catch (err) {
    console.error('Admin user invitations error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /v1.0/admin/users/:userId/hard-delete – irreversible purge of list data
router.post('/users/:userId/hard-delete', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { userId } = req.params;
    const { mode = 'all', listIds = [], itemIds = [], deleteEmbeddings = true } = req.body || {};

    // Basic validation (extra checks happen inside service)
    if (!['all', 'lists', 'items'].includes(mode)) {
      return res.status(400).json({ message: 'Invalid mode' });
    }

    const result = await performHardDelete({ userId, mode, listIds, itemIds, deleteEmbeddings });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Admin hard-delete error', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /v1.0/admin/users/:userId/change-log – remove change log entries for a user
router.delete('/users/:userId/change-log', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const { userId } = req.params;
    const result = await clearChangeLogForUser(userId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Admin clear change log error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /v1.0/admin/users/:userId/export – generate export JSON
router.post('/users/:userId/export', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
    const { userId } = req.params;
    const { mode = 'all', listIds = [], itemIds = [], format = 'json' } = req.body || {};

    const data = await exportUserData({ userId, mode, listIds, itemIds });

    if (format === 'zip') {
      const archiver = require('archiver');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="user_${userId}_export.zip"`);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.pipe(res);

      data.lists.forEach((list) => {
        const rows = ['item_id,item_title,item_description'];
        data.items.filter((it)=>it.list_id===list.id).forEach((it)=>{
          rows.push(`"${it.id}","${it.title.replace(/"/g,'""')}","${(it.description||'').replace(/"/g,'""')}"`);
        });
        archive.append(rows.join('\n'), { name: `${list.title.replace(/[^a-z0-9_-]/gi,'_')}.csv` });
      });

      archive.finalize();
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="user_${userId}_export.json"`);
      res.json(data);
    }
  } catch (err) {
    console.error('Admin export error', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// === HARD-DELETE SUPPORTING FETCH ROUTES ===
// GET /v1.0/admin/users/:userId/lists – minimal list info for hard-delete dialog
router.get('/users/:userId/lists', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    const { userId } = req.params;
    const includeDeleted = req.query.includeDeleted === 'true';
    const { rows } = await db.query(
      `SELECT l.id, l.title, l.is_public, l.created_at, l.deleted_at IS NOT NULL AS is_deleted,
              (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) AS item_count
       FROM lists l
       WHERE owner_id = $1 AND ($2::boolean OR l.deleted_at IS NULL)
       ORDER BY created_at DESC`,
      [userId, includeDeleted],
    );

    // Ensure is_public is properly boolean for each list
    const processedRows = rows.map(list => ({
      ...list,
      is_public: Boolean(list.is_public)
    }));

    res.json({ lists: processedRows });
  } catch (err) {
    console.error('Admin users list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/lists/:id – list details
router.get('/lists/:id', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT l.id, l.title, l.description, l.is_public, l.is_collaborative, l.created_at, l.updated_at,
              u.username as owner_username, u.email as owner_email,
              (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id AND li.deleted_at IS NULL) as item_count
       FROM lists l
       JOIN users u ON l.owner_id = u.id
       WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'List not found' });
    }

    const listData = rows[0];
    // Ensure is_public is properly boolean
    listData.is_public = Boolean(listData.is_public);
    listData.is_collaborative = Boolean(listData.is_collaborative);

    console.log('List data sent:', listData); // Debug log
    res.json(listData);
  } catch (err) {
    console.error('Admin list details fetch error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/lists/:id/items – minimal list-item info
router.get('/lists/:id/items', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    const { id } = req.params;
    const includeDeleted = req.query.includeDeleted === 'true';
    const { rows } = await db.query(
      `SELECT
          li.id,
          li.title,
          li.description,
          li.created_at,
          li.updated_at,
          li.deleted_at IS NOT NULL AS is_deleted,
          -- Gift details
          gd.quantity,
          gd.where_to_buy,
          gd.amazon_url,
          gd.web_link,
          gd.rating as gift_rating,
          -- Movie details
          md.tmdb_id,
          md.tagline as movie_tagline,
          md.release_date,
          md.genres as movie_genres,
          md.rating as movie_rating,
          md.runtime_minutes,
          -- Book details
          bd.google_book_id,
          bd.authors,
          bd.publisher,
          bd.page_count,
          bd.categories as book_categories,
          -- Place details
          pd.google_place_id,
          pd.address_formatted,
          pd.website as place_website,
          pd.rating_google,
          -- Recipe details
          rd.image_url as recipe_image_url,
          rd.source_url as recipe_source_url,
          rd.servings,
          rd.cook_time,
          -- Spotify details
          sd.spotify_id,
          sd.spotify_item_type,
          sd.name as spotify_name,
          sd.external_urls_spotify,
          sd.images as spotify_images,
          -- TV details
          td.tmdb_id as tv_tmdb_id,
          td.name as tv_name,
          td.first_air_date,
          td.rating as tv_rating
       FROM list_items li
       LEFT JOIN gift_details gd ON li.id = gd.list_item_id
       LEFT JOIN movie_details md ON li.id = md.list_item_id
       LEFT JOIN book_details bd ON li.id = bd.list_item_id
       LEFT JOIN place_details pd ON li.id = pd.list_item_id
       LEFT JOIN recipe_details rd ON li.id = rd.list_item_id
       LEFT JOIN spotify_item_details sd ON li.id = sd.list_item_id
       LEFT JOIN tv_details td ON li.id = td.list_item_id
       WHERE li.list_id = $1 AND ($2::boolean OR li.deleted_at IS NULL)
       ORDER BY li.created_at DESC`,
      [id, includeDeleted],
    );
    res.json({ items: rows });
  } catch (err) {
    console.error('Admin list-items fetch error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/list-items – global list items browser with pagination, search, and filters
router.get('/list-items', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    const limit = Math.max(Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200), 1);
    const offset = Math.max(parseInt(req.query.offset ?? '0', 10) || 0, 0);
    const rawSearch = (req.query.search || '').toString().trim().toLowerCase();
    const listId = req.query.listId || req.query.list_id || null;
    const ownerId = req.query.ownerId || req.query.owner_id || null;
    const listType = req.query.listType || req.query.list_type || null;
    const userIdFilter = req.query.userId || req.query.user_id || null;
    const status = (req.query.status || 'active').toString().toLowerCase();
    const sortParam = (req.query.sort || '').toString().trim().toLowerCase();

    const params = [];
    const filters = ['l.deleted_at IS NULL']; // keep to non-deleted lists

    if (status === 'deleted') {
      filters.push('li.deleted_at IS NOT NULL');
    } else if (status === 'all') {
      // no filter on deleted_at for items
    } else {
      filters.push('li.deleted_at IS NULL');
    }

    if (listId) {
      params.push(listId);
      filters.push(`li.list_id = $${params.length}`);
    }

    if (ownerId) {
      params.push(ownerId);
      filters.push(`l.owner_id = $${params.length}`);
    }

    if (userIdFilter) {
      params.push(userIdFilter);
      const idx = params.length;
      filters.push(`(li.owner_id = $${idx} OR l.owner_id = $${idx})`);
    }

    if (listType) {
      params.push(listType);
      filters.push(`l.list_type = $${params.length}`);
    }

    if (rawSearch) {
      params.push(`%${rawSearch}%`);
      const idx = params.length;
      filters.push(`(
        LOWER(li.title) LIKE $${idx}
        OR LOWER(COALESCE(li.description, '')) LIKE $${idx}
        OR LOWER(COALESCE(l.title, '')) LIKE $${idx}
        OR LOWER(COALESCE(owner.email, '')) LIKE $${idx}
        OR LOWER(COALESCE(owner.username, '')) LIKE $${idx}
      )`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    let orderClause = 'ORDER BY li.updated_at DESC';
    if (sortParam) {
      const [field, dirRaw] = sortParam.split(':');
      const direction = dirRaw === 'asc' ? 'ASC' : 'DESC';
      switch (field) {
        case 'created_at':
          orderClause = `ORDER BY li.created_at ${direction}`;
          break;
        case 'title':
          orderClause = `ORDER BY li.title ${direction}, li.updated_at DESC`;
          break;
        case 'list':
          orderClause = `ORDER BY l.title ${direction}, li.updated_at DESC`;
          break;
        case 'owner':
          orderClause = `ORDER BY owner.email ${direction}, li.updated_at DESC`;
          break;
        case 'status':
          orderClause = `ORDER BY li.status ${direction}, li.updated_at DESC`;
          break;
        default:
          break;
      }
    }

    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const baseSelect = `
      SELECT
        li.id,
        li.title,
        li.description,
        li.list_id,
        li.status,
        li.priority,
        li.price,
        li.link,
        li.created_at,
        li.updated_at,
        li.deleted_at,
        l.title AS list_title,
        l.list_type,
        l.is_public AS list_is_public,
        l.owner_id AS owner_id,
        owner.email AS owner_email,
        owner.username AS owner_username
      FROM list_items li
      JOIN lists l ON l.id = li.list_id
      LEFT JOIN users owner ON owner.id = l.owner_id
      ${whereSql}
    `;

    const dataQuery = `
      ${baseSelect}
      ${orderClause}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM list_items li
      JOIN lists l ON l.id = li.list_id
      LEFT JOIN users owner ON owner.id = l.owner_id
      ${whereSql}
    `;

    const queryParams = params.concat([limit, offset]);
    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, queryParams),
      db.query(countQuery, params),
    ]);

    const total = countResult.rows[0] ? Number(countResult.rows[0].total) : 0;
    res.json({
      items: dataResult.rows,
      total,
      limit,
      offset,
      hasMore: total > offset + dataResult.rows.length,
    });
  } catch (err) {
    console.error('Admin global list-items fetch error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// --- Admin connection invitations management ---
router.get('/connection-requests', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const limit = Math.max(Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200), 1);
    const offset = Math.max(parseInt(req.query.offset ?? '0', 10) || 0, 0);
    const status = (req.query.status || 'pending').toString().toLowerCase();
    const search = (req.query.search || '').toString().trim().toLowerCase();

    const params = [];
    const filters = [];

    if (status && status !== 'all') {
      params.push(status);
      filters.push(`LOWER(ci.status) = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      filters.push(`(
        LOWER(s.username) LIKE $${idx} OR LOWER(COALESCE(s.email, '')) LIKE $${idx}
        OR LOWER(r.username) LIKE $${idx} OR LOWER(COALESCE(r.email, '')) LIKE $${idx}
      )`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const dataQuery = `
      SELECT
        ci.*,
        s.username AS sender_username,
        s.email AS sender_email,
        r.username AS recipient_username,
        r.email AS recipient_email
      FROM connection_invitations ci
      JOIN users s ON s.id = ci.sender_id
      JOIN users r ON r.id = ci.recipient_id
      ${whereSql}
      ORDER BY ci.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM connection_invitations ci
      JOIN users s ON s.id = ci.sender_id
      JOIN users r ON r.id = ci.recipient_id
      ${whereSql}
    `;

    const queryParams = params.concat([limit, offset]);
    const [dataResult, countResult] = await Promise.all([
      db.query(dataQuery, queryParams),
      db.query(countQuery, params),
    ]);

    const total = countResult.rows[0] ? Number(countResult.rows[0].total) : 0;
    res.json({
      requests: dataResult.rows,
      total,
      limit,
      offset,
      hasMore: total > offset + dataResult.rows.length,
    });
  } catch (err) {
    console.error('Admin connection requests list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

async function upsertAcceptedConnections(userA, userB) {
  // create or update both directions to accepted mutual
  await db.query(
    `INSERT INTO connections
       (user_id, connection_id, status, connection_type, initiated_by, visibility_level, accepted_at, updated_at)
     VALUES ($1, $2, 'accepted', 'mutual', $1, 'friends', NOW(), NOW())
     ON CONFLICT (user_id, connection_id) DO UPDATE SET
       status = 'accepted',
       connection_type = 'mutual',
       accepted_at = NOW(),
       updated_at = NOW()`,
    [userA, userB],
  );
  await db.query(
    `INSERT INTO connections
       (user_id, connection_id, status, connection_type, initiated_by, visibility_level, accepted_at, updated_at)
     VALUES ($1, $2, 'accepted', 'mutual', $1, 'friends', NOW(), NOW())
     ON CONFLICT (user_id, connection_id) DO UPDATE SET
       status = 'accepted',
       connection_type = 'mutual',
       accepted_at = NOW(),
       updated_at = NOW()`,
    [userB, userA],
  );
}

async function deletePendingConnections(userA, userB) {
  await db.query(
    `DELETE FROM connections
     WHERE ((user_id = $1 AND connection_id = $2)
        OR (user_id = $2 AND connection_id = $1))
       AND status = 'pending'`,
    [userA, userB],
  );
}

async function setInvitationStatus(id, status, declineType = null, declineMessage = null) {
  const result = await db.query(
    `UPDATE connection_invitations
     SET status = $2,
         responded_at = NOW(),
         decline_type = $3,
         decline_message = $4
     WHERE id = $1
     RETURNING sender_id, recipient_id`,
    [id, status, declineType, declineMessage],
  );
  return result.rows[0];
}

router.post('/connection-requests/:id/accept', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    await db.query('BEGIN');
    const row = await setInvitationStatus(req.params.id, 'accepted');
    if (!row) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: 'Invitation not found' });
    }
    await upsertAcceptedConnections(row.sender_id, row.recipient_id);
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Admin accept connection request error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/connection-requests/:id/decline', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
    const { declineType = 'standard', declineMessage = null } = req.body || {};
    await db.query('BEGIN');
    const row = await setInvitationStatus(req.params.id, 'declined', declineType, declineMessage);
    if (!row) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: 'Invitation not found' });
    }
    await deletePendingConnections(row.sender_id, row.recipient_id);
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Admin decline connection request error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/connection-requests/:id/cancel', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
    await db.query('BEGIN');
    const row = await setInvitationStatus(req.params.id, 'cancelled');
    if (!row) {
      await db.query('ROLLBACK');
      return res.status(404).json({ message: 'Invitation not found' });
    }
    await deletePendingConnections(row.sender_id, row.recipient_id);
    await db.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Admin cancel connection request error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/connection-requests/:id', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
    const { rows } = await db.query(
      `DELETE FROM connection_invitations
       WHERE id = $1
       RETURNING sender_id, recipient_id, status`,
      [req.params.id],
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Invitation not found' });
    }
    // Clean up any pending connection rows if the invite was pending
    if ((rows[0].status || '').toLowerCase() === 'pending') {
      await deletePendingConnections(rows[0].sender_id, rows[0].recipient_id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete connection request error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/users/:userId/metrics – user-specific metrics
router.get('/users/:userId/metrics', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    const { userId } = req.params;

    const listResults = await Promise.allSettled([
      db.query('SELECT COUNT(*) FROM lists WHERE owner_id = $1 AND deleted_at IS NULL', [userId]),
      db.query(`
        SELECT COUNT(*)
        FROM list_items li
        JOIN lists l ON li.list_id = l.id
        WHERE l.owner_id = $1 AND li.deleted_at IS NULL AND l.deleted_at IS NULL
      `, [userId]),
      db.query('SELECT COUNT(*) FROM user_groups WHERE created_by = $1 AND deleted_at IS NULL', [userId]),
      db.query(`
        SELECT COUNT(*)
        FROM group_members gm
        JOIN user_groups g ON gm.group_id = g.id
        WHERE gm.user_id = $1 AND gm.deleted_at IS NULL AND g.deleted_at IS NULL
      `, [userId])
    ]);

    // Extract results with fallbacks for failed queries
    const listsCnt = listResults[0].status === 'fulfilled' ? listResults[0].value.rows : [{ count: 0 }];
    const itemsCnt = listResults[1].status === 'fulfilled' ? listResults[1].value.rows : [{ count: 0 }];
    const groupsOwnedCnt = listResults[2].status === 'fulfilled' ? listResults[2].value.rows : [{ count: 0 }];
    const groupsMemberCnt = listResults[3].status === 'fulfilled' ? listResults[3].value.rows : [{ count: 0 }];

    const lastActivityResults = await Promise.allSettled([
      db.query(`
        SELECT GREATEST(
          (SELECT MAX(created_at) FROM lists WHERE owner_id = $1 AND deleted_at IS NULL),
          (SELECT MAX(li.created_at)
           FROM list_items li
           JOIN lists l ON li.list_id = l.id
           WHERE l.owner_id = $1 AND li.deleted_at IS NULL AND l.deleted_at IS NULL)
        ) as last_activity
      `, [userId])
    ]);

    const lastActivity = lastActivityResults[0].status === 'fulfilled'
      ? lastActivityResults[0].value.rows
      : [{ last_activity: null }];

    res.json({
      totalLists: Number(listsCnt[0].count),
      totalItems: Number(itemsCnt[0].count),
      totalGroupsOwned: Number(groupsOwnedCnt[0].count),
      totalGroupsMemberOf: Number(groupsMemberCnt[0].count),
      lastActivity: lastActivity[0].last_activity
    });
  } catch (err) {
    console.error('Admin user metrics error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/users/:userId/groups – user's group memberships
router.get('/users/:userId/groups', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });

    const { userId } = req.params;

    const groupResults = await Promise.allSettled([
      db.query(`
        SELECT g.id, g.name, g.description, g.created_at,
               COUNT(gm.id) as member_count
        FROM user_groups g
        LEFT JOIN group_members gm ON g.id = gm.group_id AND gm.deleted_at IS NULL
        WHERE g.created_by = $1 AND g.deleted_at IS NULL
        GROUP BY g.id, g.name, g.description, g.created_at
        ORDER BY g.created_at DESC
      `, [userId]),
      db.query(`
        SELECT g.id, g.name, g.description, g.created_at,
               u.username as owner_username,
               COUNT(gm2.id) as member_count
        FROM group_members gm
        JOIN user_groups g ON gm.group_id = g.id
        JOIN users u ON g.created_by = u.id
        LEFT JOIN group_members gm2 ON g.id = gm2.group_id AND gm2.deleted_at IS NULL
        WHERE gm.user_id = $1 AND gm.deleted_at IS NULL AND g.deleted_at IS NULL
        GROUP BY g.id, g.name, g.description, g.created_at, u.username
        ORDER BY g.created_at DESC
      `, [userId])
    ]);

    const ownedGroups = groupResults[0].status === 'fulfilled' ? groupResults[0].value.rows : [];
    const memberGroups = groupResults[1].status === 'fulfilled' ? groupResults[1].value.rows : [];

    res.json({
      owned: ownedGroups,
      memberOf: memberGroups,
      totalOwned: ownedGroups.length,
      totalMemberOf: memberGroups.length
    });
  } catch (err) {
    console.error('Admin user groups error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/cache/stats – Valkey cache statistics
router.get('/cache/stats', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    await getCacheStats(req, res);
  } catch (err) {
    console.error('Admin cache stats error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /v1.0/admin/cache/keys
router.get('/cache/keys', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  await listKeys(req, res);
});

// GET /v1.0/admin/cache/keys/:key
router.get('/cache/keys/:key', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  await getKey(req, res);
});

router.delete('/cache/keys/:key', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  await deleteKey(req, res);
});

router.post('/cache/clear', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  await clearCache(req, res);
});

router.get('/cache/settings', authenticateJWT, getCacheSettings);
router.post('/cache/settings', authenticateJWT, updateCacheSettings);

// === R2 STORAGE ADMIN ROUTES ===
// List objects in R2 storage
router.get('/r2/objects', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  req.user.isAdmin = true; // Set admin flag for controller
  await r2AdminController.listObjects(req, res);
});

// Get presigned URL for a specific object
// Using query parameter for key to handle slashes
router.get('/r2/object-url', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  req.user.isAdmin = true;
  // Get key from query parameter
  req.params.key = req.query.key || '';
  await r2AdminController.getObjectUrl(req, res);
});

// Delete an object
// Using request body for key to handle slashes
router.delete('/r2/object', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  req.user.isAdmin = true;
  // Get key from body
  req.params.key = req.body.key || '';
  await r2AdminController.deleteObject(req, res);
});

// Get storage statistics
router.get('/r2/stats', authenticateJWT, async (req, res) => {
  if (!(await ensureAdmin(req.user.id))) return res.status(403).json({ message: 'Admin role required' });
  req.user.isAdmin = true;
  await r2AdminController.getStorageStats(req, res);
});

module.exports = router; 
