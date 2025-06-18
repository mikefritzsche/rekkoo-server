const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const db = require('../config/db');

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

// GET /v1.0/admin/metrics – basic counts
router.get('/metrics', authenticateJWT, async (req, res) => {
  try {
    if (!(await ensureAdmin(req.user.id))) {
      return res.status(403).json({ message: 'Admin role required' });
    }

    const [{ rows: usersCnt },
           { rows: listsCnt },
           { rows: queueCnt }] = await Promise.all([
      db.query('SELECT COUNT(*) FROM users  WHERE deleted_at IS NULL'),
      db.query('SELECT COUNT(*) FROM lists  WHERE deleted_at IS NULL'),
      db.query("SELECT COUNT(*) FROM embedding_queue WHERE status = 'pending'")
    ]);

    res.json({
      totalUsers:        Number(usersCnt[0].count),
      activeLists:       Number(listsCnt[0].count),
      embeddingsPending: Number(queueCnt[0].count)
    });
  } catch (err) {
    console.error('Admin metrics error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router; 