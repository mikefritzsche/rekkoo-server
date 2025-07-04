const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const db = require('../config/db');
const invitationService = require('../services/invitationService');

const router = express.Router();

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

module.exports = router; 