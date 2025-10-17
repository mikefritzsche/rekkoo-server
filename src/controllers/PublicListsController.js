const db = require('../config/db');
const { normalizeReservationQuantity, buildReservationResponse } = require('../utils/giftReservationUtils');

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
        const isOwner = requestor_id && String(requestor_id) === String(list.owner_id);
        itemsQuery = `
          SELECT 
            i.*,
            COALESCE(gd.quantity, 1) AS gift_quantity
          FROM public.list_items i
          LEFT JOIN public.gift_details gd ON i.gift_detail_id = gd.id
          WHERE i.list_id = $1 AND i.deleted_at IS NULL 
          ORDER BY i.sort_order ASC, i.created_at ASC
        `;
        
        const itemsResult = await db.query(itemsQuery, [id]);
        const itemRows = itemsResult.rows;
        const itemIds = itemRows.map(row => row.id);

        let reservationRows = [];
        if (itemIds.length > 0) {
          const reservationsQuery = `
            SELECT 
              gr.*,
              u.username,
              u.full_name
            FROM public.gift_reservations gr
            LEFT JOIN public.users u ON gr.reserved_by = u.id
            WHERE gr.deleted_at IS NULL
              AND gr.item_id = ANY($1::uuid[])
            ORDER BY gr.created_at ASC
          `;
          const reservationsResult = await db.query(reservationsQuery, [itemIds]);
          reservationRows = reservationsResult.rows;
        }

        const reservationsByItem = new Map();
        for (const row of reservationRows) {
          const normalizedRow = {
            ...row,
            quantity: normalizeReservationQuantity(row.quantity),
          };
          const existing = reservationsByItem.get(row.item_id) || [];
          existing.push(normalizedRow);
          reservationsByItem.set(row.item_id, existing);
        }

        items = itemRows.map(item => {
          const reservations = reservationsByItem.get(item.id) || [];
          const status = buildReservationResponse({
            item,
            reservations,
            userId: requestor_id,
            isListOwner: Boolean(isOwner),
          });

          return {
            ...item,
            giftStatus: status,
            gift_status: status,
            is_reserved: status.is_reserved,
            is_purchased: status.is_purchased,
            available_quantity: status.available_quantity,
            reserved_quantity: status.reserved_quantity,
            purchased_quantity: status.purchased_quantity,
          };
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
