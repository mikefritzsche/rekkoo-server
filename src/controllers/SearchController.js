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
   * Respects privacy settings and connection status
   */
  const combinedSearch = async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }
      const limit = Math.min(parseInt(req.query.limit, 10) || 5, 50); // Hard-cap at 50
      const likeParam = `%${q}%`;
      const userId = req.user?.id || null; // Get authenticated user ID if available

      // Run the three searches in parallel for efficiency with privacy filtering
      const [listsResult, itemsResult, usersResult] = await Promise.all([
        // Lists: Only show public lists OR lists the user has access to
        db.query(
          `SELECT DISTINCT l.id, l.title, l.description
           FROM public.lists l
           WHERE l.deleted_at IS NULL
             AND (l.title ILIKE $1 OR l.description ILIKE $1)
             AND (
               -- Public lists are visible to everyone
               l.is_public = true
               -- User's own lists
               OR ($3::uuid IS NOT NULL AND l.owner_id = $3)
               -- Lists shared with the user
               OR ($3::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.list_collaborators lc
                 WHERE lc.list_id = l.id AND lc.user_id = $3
               ))
               -- Lists shared via groups the user is in
               OR ($3::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.collaboration_group_lists cgl
                 JOIN public.collaboration_group_members cgm ON cgl.group_id = cgm.group_id
                 WHERE cgl.list_id = l.id AND cgm.user_id = $3
               ))
             )
           ORDER BY l.updated_at DESC
           LIMIT $2`,
          [likeParam, limit, userId]
        ),
        // Items: Only from accessible lists
        db.query(
          `SELECT DISTINCT i.id, i.title, i.list_id
           FROM public.list_items i
           JOIN public.lists l ON i.list_id = l.id
           WHERE i.deleted_at IS NULL
             AND l.deleted_at IS NULL
             AND i.title ILIKE $1
             AND (
               -- Items from public lists
               l.is_public = true
               -- User's own list items
               OR ($3::uuid IS NOT NULL AND l.owner_id = $3)
               -- Items from lists shared with the user
               OR ($3::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.list_collaborators lc
                 WHERE lc.list_id = l.id AND lc.user_id = $3
               ))
               -- Items from group-shared lists
               OR ($3::uuid IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.collaboration_group_lists cgl
                 JOIN public.collaboration_group_members cgm ON cgl.group_id = cgm.group_id
                 WHERE cgl.list_id = l.id AND cgm.user_id = $3
               ))
             )
           ORDER BY i.updated_at DESC
           LIMIT $2`,
          [likeParam, limit, userId]
        ),
        // Users: Respect privacy settings and searchability
        db.query(
          `SELECT u.id, u.username, u.full_name,
                  us.privacy_settings->>'privacy_mode' as privacy_mode
           FROM public.users u
           LEFT JOIN public.user_settings us ON u.id = us.user_id
           WHERE u.deleted_at IS NULL
             -- Exclude ghost users completely unless connected
             AND COALESCE(us.privacy_settings->>'privacy_mode', 'private') != 'ghost'
             AND (
               -- Search by username if allowed
               (u.username ILIKE $1 AND (
                 -- Public users are searchable by username
                 COALESCE(us.privacy_settings->>'privacy_mode', 'private') = 'public'
                 -- Standard users might be searchable
                 OR (COALESCE(us.privacy_settings->>'privacy_mode', 'private') = 'standard'
                     AND COALESCE((us.privacy_settings->>'searchable_by_username')::boolean, false) = true)
                 -- Connected users can find each other
                 OR ($3::uuid IS NOT NULL AND EXISTS (
                   SELECT 1 FROM public.connections c
                   WHERE c.user_id = $3 AND c.connection_id = u.id
                     AND c.status = 'accepted'
                 ))
                 -- User searching for themselves
                 OR ($3::uuid IS NOT NULL AND u.id = $3)
               ))
               -- Search by full name if allowed
               OR (u.full_name ILIKE $1 AND (
                 -- Public users are searchable by name
                 COALESCE(us.privacy_settings->>'privacy_mode', 'private') = 'public'
                 -- Standard users might be searchable
                 OR (COALESCE(us.privacy_settings->>'privacy_mode', 'private') = 'standard'
                     AND COALESCE((us.privacy_settings->>'searchable_by_name')::boolean, false) = true)
                 -- Connected users can find each other
                 OR ($3::uuid IS NOT NULL AND EXISTS (
                   SELECT 1 FROM public.connections c
                   WHERE c.user_id = $3 AND c.connection_id = u.id
                     AND c.status = 'accepted'
                 ))
                 -- User searching for themselves
                 OR ($3::uuid IS NOT NULL AND u.id = $3)
               ))
             )
           ORDER BY u.updated_at DESC
           LIMIT $2`,
          [likeParam, limit, userId]
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