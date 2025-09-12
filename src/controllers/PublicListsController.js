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

      // Check if user has access through a group or individual share
      let hasGroupAccess = false;
      let hasIndividualAccess = false;
      
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
        
        // Check individual access via list_user_overrides
        const individualAccessQuery = `
          SELECT COUNT(*) as count
          FROM public.list_user_overrides luo
          WHERE luo.list_id = $1 
            AND luo.user_id = $2 
            AND luo.role NOT IN ('blocked', 'inherit')
            AND luo.deleted_at IS NULL
        `;
        const individualAccessResult = await db.query(individualAccessQuery, [id, requestor_id]);
        hasIndividualAccess = individualAccessResult.rows[0]?.count > 0;
      }

      // Check access permissions
      const isOwner = list.owner_id === requestor_id;
      const isPublic = list.is_public === true;
      const canAccess = isOwner || isPublic || hasGroupAccess || hasIndividualAccess;

      console.log('[PublicListsController.getListById] Access check:', {
        listId: id,
        requestorId: requestor_id,
        listOwnerId: list.owner_id,
        isOwner,
        isPublic,
        hasGroupAccess,
        hasIndividualAccess,
        canAccess,
        listType: list.list_type
      });

      if (!canAccess) {
        console.log('[PublicListsController.getListById] Access DENIED for user:', requestor_id);
        return res.status(403).json({ error: 'You do not have permission to view this list' });
      }

      // Always fetch all item fields for consistency
      let itemsQuery;
      let items;
      
      if (list.list_type === 'gifts') {
        // For gift lists, always include reservation status (will be null for non-reserved items)
        itemsQuery = `
          SELECT 
            i.*,
            gr.reserved_by,
            gr.is_purchased,
            u.username as reserved_by_username,
            u.full_name as reserved_by_full_name
          FROM public.list_items i
          LEFT JOIN public.gift_reservations gr ON i.id = gr.item_id
          LEFT JOIN public.users u ON gr.reserved_by = u.id
          WHERE i.list_id = $1 AND i.deleted_at IS NULL 
          ORDER BY i.sort_order ASC, i.created_at ASC
        `;
        
        const itemsResult = await db.query(itemsQuery, [id]);
        
        // Transform the data to have consistent structure with nested giftStatus
        items = itemsResult.rows.map(item => {
          const { reserved_by, is_purchased, reserved_by_username, reserved_by_full_name, ...itemData } = item;
          
          // Build the transformed item with gift status as a nested object
          const transformedItem = {
            ...itemData
          };
          
          // Add gift status for non-owners or when there's reservation data
          if (!isOwner || reserved_by) {
            transformedItem.giftStatus = {
              is_reserved: !!reserved_by,
              is_purchased: !!is_purchased,
              reserved_by: reserved_by ? {
                id: reserved_by,
                username: reserved_by_username,
                full_name: reserved_by_full_name,
                is_me: reserved_by === requestor_id
              } : null
            };
          }
          
          // For owners, don't show reservation details unless it's their own reservation
          if (isOwner && reserved_by && reserved_by !== requestor_id) {
            // Hide other people's reservations from the owner
            delete transformedItem.giftStatus;
          }
          
          return transformedItem;
        });
      } else {
        // For non-gift lists, use simple query
        itemsQuery = `
          SELECT * FROM public.list_items 
          WHERE list_id = $1 AND deleted_at IS NULL 
          ORDER BY sort_order ASC, created_at ASC
        `;
        const itemsResult = await db.query(itemsQuery, [id]);
        items = itemsResult.rows;
      }

      res.json({ list, items });
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