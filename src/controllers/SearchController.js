const db = require('../config/db');

/**
 * Factory to create SearchController with dependency injection (e.g., socketService)
 * @param {Object|null} socketService Optional Socket.IO service (currently not used but kept for parity)
 * @returns {Object} Controller with combinedSearch handler
 */
function searchControllerFactory(socketService = null) {
  /**
   * GET /v1.0/search?q=<query>&limit=<limit>
   * Searches lists, list items, and users in parallel and returns a combined payload
   */
  const combinedSearch = async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50); // Hard-cap at 50
      const likeParam = `%${q}%`;

      // Run the three searches in parallel for efficiency
      const [listsResult, itemsResult, usersResult] = await Promise.all([
        db.query(
          `SELECT id, title, description
           FROM public.lists
           WHERE deleted_at IS NULL
             AND (title ILIKE $1 OR description ILIKE $1)
           ORDER BY updated_at DESC
           LIMIT $2`,
          [likeParam, limit]
        ),
        db.query(
          `SELECT id, title, list_id
           FROM public.list_items
           WHERE deleted_at IS NULL
             AND title ILIKE $1
           ORDER BY updated_at DESC
           LIMIT $2`,
          [likeParam, limit]
        ),
        db.query(
          `SELECT id, username, full_name
           FROM public.users
           WHERE deleted_at IS NULL
             AND (username ILIKE $1 OR full_name ILIKE $1)
           ORDER BY updated_at DESC
           LIMIT $2`,
          [likeParam, limit]
        ),
      ]);

      res.json({
        lists: listsResult.rows,
        items: itemsResult.rows,
        users: usersResult.rows,
      });
    } catch (error) {
      console.error('[SearchController] combinedSearch error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  return {
    combinedSearch,
  };
}

module.exports = searchControllerFactory; 