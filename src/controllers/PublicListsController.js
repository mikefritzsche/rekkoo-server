const db = require('../config/db');
const { normalizeReservationQuantity, buildReservationResponse } = require('../utils/giftReservationUtils');

function publicListsControllerFactory() {
  const hasSecretSantaWishlistAccess = async (listId, userId) => {
    if (!userId) return false;
    try {
      const { rows } = await db.query(
        `SELECT 1
           FROM secret_santa_round_participants wish
           JOIN secret_santa_round_participants me
             ON me.round_id = wish.round_id
          WHERE wish.wishlist_list_id = $1
            AND wish.wishlist_share_consent = true
            AND wish.status <> 'removed'
            AND me.user_id = $2
            AND me.status <> 'removed'
          LIMIT 1`,
        [listId, userId]
      );
      return rows.length > 0;
    } catch (error) {
      console.warn(
        '[PublicListsController] Secret Santa wishlist access check failed:',
        error?.message || error
      );
      return false;
    }
  };

  const hasSecretSantaRoundAccess = async (listId, userId) => {
    if (!userId) return false;
    try {
      const { rows } = await db.query(
        `SELECT 1
           FROM secret_santa_rounds sr
           JOIN secret_santa_round_participants sp
             ON sp.round_id = sr.id
          WHERE sr.list_id = $1
            AND sp.user_id = $2
            AND sp.status <> 'removed'
          LIMIT 1`,
        [listId, userId]
      );
      return rows.length > 0;
    } catch (error) {
      console.warn(
        '[PublicListsController] Secret Santa round access check failed:',
        error?.message || error
      );
      return false;
    }
  };

  /**
   * GET /v1.0/lists/:id
   * Returns list metadata plus its non-deleted items
   */
  const getListById = async (req, res) => {
    const { id } = req.params;
    const requestor_id = req.user?.id; // Can be null for public, unauthenticated requests

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
      const hasSecretSantaAccess =
        (await hasSecretSantaWishlistAccess(id, requestor_id)) ||
        (await hasSecretSantaRoundAccess(id, requestor_id));

      const canAccess = isOwner || isPublic || hasGroupAccess || hasIndividualAccess || hasSecretSantaAccess;

      if (!canAccess) {
        return res.status(403).json({ error: 'You do not have permission to view this list' });
      }

      // If owner is fetching a gift list, suppress this fetch (owner should rely on sync)
      if (isOwner && list.list_type === 'gifts') {
        return res.status(200).json({
          list,
          items: [],
          suppressed: true,
        });
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

      if (!isOwner) {
        list.shared_with_me = true;
        list.share_type = list.share_type || 'individual_shared';
        list.shared_by_owner =
          typeof list.shared_by_owner === 'boolean'
            ? list.shared_by_owner
            : true;
        list.access_type = list.access_type || 'shared';
        list.type_shared = list.share_type;
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
