const db = require('../config/db');

function publicListsControllerFactory() {
  /**
   * GET /v1.0/lists/:id
   * Returns list metadata plus its non-deleted items
   */
  const getListById = async (req, res) => {
    const { id } = req.params;
    const requestor_id = req.user?.id; // Can be null for public, unauthenticated requests

    console.log('[PublicListsController.getListById] Request received:', {
      listId: id,
      requestorId: requestor_id,
      userInfo: req.user
    });

    if (!id) return res.status(400).json({ error: 'id param required' });

    try {
      const listQuery = `SELECT * FROM public.lists WHERE id = $1 AND deleted_at IS NULL LIMIT 1`;
      const listResult = await db.query(listQuery, [id]);
      if (listResult.rows.length === 0) {
        return res.status(404).json({ error: 'List not found' });
      }
      const list = listResult.rows[0];

      // Check if user has access through a group
      let hasGroupAccess = false;
      if (requestor_id && requestor_id !== list.owner_id) {
        const groupAccessQuery = `
          SELECT COUNT(*) as count
          FROM (
            -- Check list_group_roles table (new system)
            SELECT 1
            FROM public.list_group_roles lgr
            JOIN public.collaboration_group_members cgm ON lgr.group_id = cgm.group_id
            WHERE lgr.list_id = $1 
              AND cgm.user_id = $2
              AND lgr.deleted_at IS NULL
              AND cgm.deleted_at IS NULL
            UNION
            -- Check list_sharing table (legacy system)
            SELECT 1
            FROM public.list_sharing ls
            JOIN public.collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
            WHERE ls.list_id = $1 
              AND cgm.user_id = $2
              AND ls.deleted_at IS NULL
              AND cgm.deleted_at IS NULL
          ) as access_check
        `;
        const groupAccessResult = await db.query(groupAccessQuery, [id, requestor_id]);
        hasGroupAccess = groupAccessResult.rows[0]?.count > 0;
      }

      // Check access permissions
      const isOwner = list.owner_id === requestor_id;
      const isPublic = list.is_public === true;
      const canAccess = isOwner || isPublic || hasGroupAccess;

      console.log('[PublicListsController.getListById] Access check:', {
        listId: id,
        requestorId: requestor_id,
        listOwnerId: list.owner_id,
        isOwner,
        isPublic,
        hasGroupAccess,
        canAccess,
        listType: list.list_type
      });

      if (!canAccess) {
        console.log('[PublicListsController.getListById] Access DENIED for user:', requestor_id);
        return res.status(403).json({ error: 'You do not have permission to view this list' });
      }

      let itemsQuery;
      if (isOwner) {
        // Owner sees everything *except* reservation status
        itemsQuery = `SELECT * FROM public.list_items WHERE list_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`;
      } else {
        // Non-owners (including group members) see reservation status
        itemsQuery = `
          SELECT 
            i.*,
            gr.reserved_by,
            gr.is_purchased,
            u.username as reserved_by_username
          FROM public.list_items i
          LEFT JOIN public.gift_reservations gr ON i.id = gr.item_id
          LEFT JOIN public.users u ON gr.reserved_by = u.id
          WHERE i.list_id = $1 AND i.deleted_at IS NULL 
          ORDER BY i.sort_order ASC, i.created_at ASC
        `;
      }

      const itemsResult = await db.query(itemsQuery, [id]);
      res.json({ list, items: itemsResult.rows });
    } catch (err) {
      console.error('[PublicListsController] getListById error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  return {
    getListById,
  };
}

module.exports = publicListsControllerFactory; 