const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/NotificationService');
const {
  DEFAULT_RESERVATION_QUANTITY,
  normalizeReservationQuantity,
  buildReservationResponse,
  fetchActiveReservationsForItem,
} = require('../utils/giftReservationUtils');

const parseOptionalQuantity = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('Quantity must be a number');
  }

  const intValue = Math.floor(parsed);
  if (intValue < 1) {
    throw new Error('Quantity must be at least 1');
  }

  return intValue;
};

const parseQuantityOrDefault = (value, defaultValue = DEFAULT_RESERVATION_QUANTITY) => {
  const parsed = parseOptionalQuantity(value);
  return parsed === null ? defaultValue : parsed;
};

const GiftController = {
  // Get gift reservation status for an item
  getItemReservationStatus: async (req, res) => {
    const { itemId } = req.params;
    const userId = req.user.id;
    
    try {
      const { rows: itemRows } = await db.query(
        `SELECT 
           li.*,
           COALESCE(gd.quantity, 1) AS gift_quantity,
           l.owner_id as list_owner_id,
           l.title as list_title
         FROM list_items li
         JOIN lists l ON li.list_id = l.id
         LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
         WHERE li.id = $1 AND li.deleted_at IS NULL`,
        [itemId]
      );
      
      if (itemRows.length === 0) {
        return res.status(404).json({ error: 'Item not found' });
      }
      
      const item = itemRows[0];
      const isListOwner = String(item.list_owner_id) === String(userId);

      const reservations = await fetchActiveReservationsForItem(itemId);
      const response = buildReservationResponse({
        item,
        reservations,
        userId,
        isListOwner,
      });

      return res.json(response);
    } catch (error) {
      console.error('Error fetching reservation status:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Reserve a gift item
  reserveItem: async (req, res) => {
    const { itemId } = req.params;
    const { reservation_message } = req.body;
    const userId = req.user.id;

    let requestedQuantity;
    try {
      requestedQuantity = parseQuantityOrDefault(req.body.quantity);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Invalid quantity' });
    }
    
    try {
      await db.query('BEGIN');
      
      const { rows: itemRows } = await db.query(
        `SELECT 
           li.*,
           COALESCE(gd.quantity, 1) AS gift_quantity,
           l.owner_id as list_owner_id,
           l.title as list_title,
           l.id as list_id
         FROM list_items li
         JOIN lists l ON li.list_id = l.id
         LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
         WHERE li.id = $1 AND li.deleted_at IS NULL
         FOR UPDATE OF li`,
        [itemId]
      );
      
      if (itemRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Item not found' });
      }
      
      const item = itemRows[0];
      const isListOwner = String(item.list_owner_id) === String(userId);
      
      if (isListOwner) {
        await db.query('ROLLBACK');
        return res.status(403).json({ error: 'Cannot reserve items from your own list' });
      }

      const reservations = await fetchActiveReservationsForItem(itemId, { forUpdate: true });
      const currentStatus = buildReservationResponse({
        item,
        reservations,
        userId,
        isListOwner,
      });

      if (currentStatus.available_quantity <= 0) {
        await db.query('ROLLBACK');
        return res.status(409).json({ error: 'All available quantities have already been claimed' });
      }

      if (requestedQuantity > currentStatus.available_quantity) {
        await db.query('ROLLBACK');
        return res.status(409).json({
          error: `Only ${currentStatus.available_quantity} item(s) remain available`,
        });
      }

      const existingReservation = reservations.find(
        (reservation) => !reservation.is_purchased && String(reservation.reserved_by) === String(userId)
      );

      let reservationRecord;
      if (existingReservation) {
        const updatedQuantity = normalizeReservationQuantity(existingReservation.quantity) + requestedQuantity;
        const { rows: updatedReservation } = await db.query(
          `UPDATE gift_reservations
             SET quantity = $1,
                 reservation_message = COALESCE($3, reservation_message),
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = $2
           RETURNING *`,
          [updatedQuantity, existingReservation.id, reservation_message || null]
        );
        reservationRecord = updatedReservation[0];
      } else {
        const reservationId = uuidv4();
        const { rows: newReservation } = await db.query(
          `INSERT INTO gift_reservations (
             id,
             item_id,
             reserved_by,
             reserved_for,
             reservation_message,
             is_purchased,
             quantity
           )
           VALUES ($1, $2, $3, $4, $5, false, $6)
           RETURNING *`,
          [reservationId, itemId, userId, item.list_owner_id, reservation_message || null, requestedQuantity]
        );
        reservationRecord = newReservation[0];
      }

      await db.query('COMMIT');

      const updatedReservations = await fetchActiveReservationsForItem(itemId);
      const updatedStatus = buildReservationResponse({
        item,
        reservations: updatedReservations,
        userId,
        isListOwner,
      });
      
      await NotificationService.notifyGroupMembers({
        listId: item.list_id,
        excludeUserId: item.list_owner_id,
        type: 'item_reserved',
        data: {
          item_id: itemId,
          item_title: item.title,
          list_title: item.list_title,
          reserved_by: req.user.username,
          reserved_by_id: userId,
          reservation_id: reservationRecord.id,
          quantity: normalizeReservationQuantity(reservationRecord.quantity),
          available_quantity: updatedStatus.available_quantity,
          reserved_quantity: updatedStatus.reserved_quantity,
          purchased_quantity: updatedStatus.purchased_quantity,
          total_quantity: updatedStatus.total_quantity,
        }
      });
      
      return res.status(existingReservation ? 200 : 201).json({
        success: true,
        reservation: reservationRecord,
        status: updatedStatus,
        message: existingReservation ? 'Reservation updated' : 'Item successfully reserved'
      });
      
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Error reserving item:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Purchase a gift item (mark as purchased)
  purchaseItem: async (req, res) => {
    const { itemId } = req.params;
    const { purchase_message } = req.body;
    const userId = req.user.id;
    
    let requestedQuantity = null;
    try {
      requestedQuantity = parseOptionalQuantity(req.body.quantity);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Invalid quantity' });
    }

    try {
      await db.query('BEGIN');
      
      // Get item and list details
      const { rows: itemRows } = await db.query(
        `SELECT 
           li.*,
           COALESCE(gd.quantity, 1) AS gift_quantity,
           l.owner_id as list_owner_id, 
           l.title as list_title, 
           l.id as list_id
         FROM list_items li
         JOIN lists l ON li.list_id = l.id
         LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
         WHERE li.id = $1 AND li.deleted_at IS NULL
         FOR UPDATE OF li`,
        [itemId]
      );
      
      if (itemRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'Item not found' });
      }
      
      const item = itemRows[0];
      
      // Check if user is the list owner
      if (String(item.list_owner_id) === String(userId)) {
        await db.query('ROLLBACK');
        return res.status(403).json({ error: 'Cannot purchase items from your own list' });
      }
      
      const reservations = await fetchActiveReservationsForItem(itemId, { forUpdate: true });
      const isListOwner = false; // purchaser can never be list owner due to earlier check
      const currentStatus = buildReservationResponse({
        item,
        reservations,
        userId,
        isListOwner,
      });

      if (currentStatus.available_quantity <= 0 && !reservations.some(r => !r.is_purchased && String(r.reserved_by) === String(userId))) {
        await db.query('ROLLBACK');
        return res.status(409).json({ error: 'All available quantities have already been purchased' });
      }

      const pendingReservation = reservations.find(
        (reservation) => !reservation.is_purchased && String(reservation.reserved_by) === String(userId)
      );

      const purchaseQuantity = pendingReservation
        ? (requestedQuantity === null ? normalizeReservationQuantity(pendingReservation.quantity) : requestedQuantity)
        : (requestedQuantity === null ? 1 : requestedQuantity);

      if (pendingReservation && purchaseQuantity !== normalizeReservationQuantity(pendingReservation.quantity)) {
        await db.query('ROLLBACK');
        return res.status(400).json({
          error: `You have reserved ${pendingReservation.quantity} item(s). Purchase quantity must match the reserved quantity.`,
        });
      }

      if (!pendingReservation && purchaseQuantity > currentStatus.available_quantity) {
        await db.query('ROLLBACK');
        return res.status(409).json({
          error: `Only ${currentStatus.available_quantity} item(s) remain available`,
        });
      }

      let reservationRecord;
      if (pendingReservation) {
        const { rows: updatedReservation } = await db.query(
          `UPDATE gift_reservations 
             SET is_purchased = true, 
                 reservation_message = COALESCE($2, reservation_message),
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [pendingReservation.id, purchase_message || pendingReservation.reservation_message]
        );
        reservationRecord = updatedReservation[0];
      } else {
        const reservationId = uuidv4();
        const { rows: newReservation } = await db.query(
          `INSERT INTO gift_reservations (
             id,
             item_id,
             reserved_by,
             reserved_for,
             reservation_message,
             is_purchased,
             quantity
           )
           VALUES ($1, $2, $3, $4, $5, true, $6)
           RETURNING *`,
          [reservationId, itemId, userId, item.list_owner_id, purchase_message || 'Purchased', purchaseQuantity]
        );
        reservationRecord = newReservation[0];
      }
        
      await db.query('COMMIT');

      const updatedReservations = await fetchActiveReservationsForItem(itemId);
      const updatedStatus = buildReservationResponse({
        item,
        reservations: updatedReservations,
        userId,
        isListOwner: false,
      });
        
      await NotificationService.notifyGroupMembers({
        listId: item.list_id,
        excludeUserId: item.list_owner_id,
        type: 'item_purchased',
        data: {
          item_id: itemId,
          item_title: item.title,
          list_title: item.list_title,
          purchased_by: req.user.username,
          purchased_by_id: userId,
          quantity: normalizeReservationQuantity(reservationRecord.quantity),
          available_quantity: updatedStatus.available_quantity,
          reserved_quantity: updatedStatus.reserved_quantity,
          purchased_quantity: updatedStatus.purchased_quantity,
          total_quantity: updatedStatus.total_quantity,
        }
      });
        
      return res.status(pendingReservation ? 200 : 201).json({
        success: true,
        reservation: reservationRecord,
        status: updatedStatus,
        message: pendingReservation ? 'Reservation marked as purchased' : 'Item successfully marked as purchased'
      });
      
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Error purchasing item:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  releaseItem: async (req, res) => {
    const { itemId } = req.params;
    const { reservation_id: reservationIdFromBody } = req.body || {};
    const userId = req.user.id;
    
    try {
      await db.query('BEGIN');
      
      const { rows: reservationRows } = await db.query(
        `SELECT 
           gr.*,
           li.list_id,
           li.title as item_title,
           COALESCE(gd.quantity, 1) AS gift_quantity,
           l.title as list_title,
           l.owner_id as list_owner_id
         FROM gift_reservations gr
         JOIN list_items li ON gr.item_id = li.id
         JOIN lists l ON li.list_id = l.id
         LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
         WHERE gr.item_id = $1 AND gr.deleted_at IS NULL
         FOR UPDATE OF gr`,
        [itemId]
      );
      
      if (reservationRows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'No reservation found for this item' });
      }
      
      let reservation = null;
      if (reservationIdFromBody) {
        reservation = reservationRows.find((row) => String(row.id) === String(reservationIdFromBody));
        if (!reservation) {
          await db.query('ROLLBACK');
          return res.status(404).json({ error: 'Reservation not found' });
        }
        if (String(reservation.reserved_by) !== String(userId)) {
          await db.query('ROLLBACK');
          return res.status(403).json({ error: 'You can only release your own reservations' });
        }
      } else {
        reservation = reservationRows.find((row) => String(row.reserved_by) === String(userId));
        if (!reservation) {
          await db.query('ROLLBACK');
          return res.status(403).json({ error: 'You can only release your own reservations' });
        }
      }
      
      await db.query(
        `UPDATE gift_reservations 
         SET deleted_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [reservation.id]
      );
      
      await db.query('COMMIT');
      
      const lightweightItem = {
        id: itemId,
        list_id: reservation.list_id,
        quantity: reservation.gift_quantity,
      };
      const updatedReservations = await fetchActiveReservationsForItem(itemId);
      const updatedStatus = buildReservationResponse({
        item: lightweightItem,
        reservations: updatedReservations,
        userId,
        isListOwner: false,
      });
      
      const notificationType = reservation.is_purchased ? 'purchase_released' : 'reservation_released';
      await NotificationService.notifyGroupMembers({
        listId: reservation.list_id,
        excludeUserId: reservation.reserved_for,
        type: notificationType,
        data: {
          item_id: itemId,
          item_title: reservation.item_title,
          list_title: reservation.list_title,
          released_by: req.user.username,
          released_by_id: userId,
          available_quantity: updatedStatus.available_quantity,
          reserved_quantity: updatedStatus.reserved_quantity,
          purchased_quantity: updatedStatus.purchased_quantity,
          total_quantity: updatedStatus.total_quantity,
        }
      });
      
      return res.json({
        success: true,
        status: updatedStatus,
        message: reservation.is_purchased ? 'Purchase released successfully' : 'Reservation released successfully'
      });
      
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Error releasing item:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Get all reservations for a list (for group members)
  getListReservations: async (req, res) => {
    const { listId } = req.params;
    const userId = req.user.id;
    
    console.log('[GiftController.getListReservations] Request received:', {
      listId,
      userId,
      userInfo: req.user
    });
    
    try {
      // Check if user has access to the list
      const { rows: accessCheck } = await db.query(
        `SELECT l.id, l.owner_id, l.title, l.list_type, l.is_public, l.is_collaborative,
          (EXISTS(
            SELECT 1 FROM list_group_roles lgr
            JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
            WHERE lgr.list_id = l.id 
              AND cgm.user_id = $2 
              AND lgr.deleted_at IS NULL
              AND cgm.deleted_at IS NULL
          ) OR EXISTS(
            SELECT 1 FROM list_sharing ls
            JOIN collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
            WHERE ls.list_id = l.id 
              AND cgm.user_id = $2 
              AND ls.deleted_at IS NULL
              AND cgm.deleted_at IS NULL
          )) as has_group_access,
          EXISTS(
            SELECT 1 FROM list_user_overrides luo
            WHERE luo.list_id = l.id 
              AND luo.user_id = $2 
              AND luo.role != 'blocked'
              AND luo.deleted_at IS NULL
          ) as has_direct_access
         FROM lists l
         WHERE l.id = $1 AND l.deleted_at IS NULL`,
        [listId, userId]
      );
      
      if (accessCheck.length === 0) {
        return res.status(404).json({ error: 'List not found' });
      }
      
      const list = accessCheck[0];
      const isOwner = String(list.owner_id) === String(userId);
      
      // Additional debug query to check group membership directly
      const { rows: groupDebug } = await db.query(
        `SELECT 
          'list_group_roles' as source,
          lgr.group_id,
          cg.name as group_name,
          lgr.role
        FROM list_group_roles lgr
        JOIN collaboration_groups cg ON lgr.group_id = cg.id
        JOIN collaboration_group_members cgm ON cg.id = cgm.group_id
        WHERE lgr.list_id = $1 AND cgm.user_id = $2 AND lgr.deleted_at IS NULL AND cgm.deleted_at IS NULL
        UNION ALL
        SELECT 
          'list_sharing' as source,
          ls.shared_with_group_id as group_id,
          cg.name as group_name,
          'member' as role
        FROM list_sharing ls
        JOIN collaboration_groups cg ON ls.shared_with_group_id = cg.id
        JOIN collaboration_group_members cgm ON cg.id = cgm.group_id
        WHERE ls.list_id = $1 AND cgm.user_id = $2 AND ls.deleted_at IS NULL AND cgm.deleted_at IS NULL`,
        [listId, userId]
      );
      
      // Debug logging
      console.log('[GiftController.getListReservations] Access check:', {
        listId,
        userId,
        listOwnerId: list.owner_id,
        isOwner,
        list_type: list.list_type,
        is_public: list.is_public,
        is_collaborative: list.is_collaborative,
        has_group_access: list.has_group_access,
        has_direct_access: list.has_direct_access,
        isGiftList: list.list_type === 'gifts',
        groupMemberships: groupDebug
      });
      
      // Allow access if:
      // 1. User is the owner
      // 2. User has group access
      // 3. User has direct access (list_user_overrides)
      // 4. List is public
      // 5. List is collaborative
      const hasAccess = isOwner || 
                       list.has_group_access || 
                       list.has_direct_access ||
                       list.is_public ||
                       list.is_collaborative;
      
      console.log('[GiftController.getListReservations] Has access:', hasAccess);
      
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      const { rows: itemRows } = await db.query(
        `SELECT 
           li.*,
           COALESCE(gd.quantity, 1) AS gift_quantity
         FROM list_items li
         LEFT JOIN gift_details gd ON li.gift_detail_id = gd.id
         WHERE li.list_id = $1 AND li.deleted_at IS NULL
         ORDER BY li.priority ASC, li.created_at DESC`,
        [listId]
      );

      const itemIds = itemRows.map((row) => row.id);

      let reservationRows = [];
      if (itemIds.length > 0) {
        const reservationQuery = `
          SELECT 
            gr.*,
            u.username,
            u.full_name
          FROM gift_reservations gr
          LEFT JOIN users u ON gr.reserved_by = u.id
          WHERE gr.item_id = ANY($1::uuid[])
            AND gr.deleted_at IS NULL
          ORDER BY gr.created_at ASC`;
        const reservationResult = await db.query(reservationQuery, [itemIds]);
        reservationRows = reservationResult.rows;
      }

      const reservationsByItem = new Map();
      for (const row of reservationRows) {
        const existing = reservationsByItem.get(row.item_id) || [];
        existing.push({
          ...row,
          quantity: normalizeReservationQuantity(row.quantity),
        });
        reservationsByItem.set(row.item_id, existing);
      }

      const sharedGroupsMap = new Map();
      const contributionSummaryMap = new Map();

      if (itemIds.length > 0) {
        const { rows: groupRows } = await db.query(
          `
            SELECT DISTINCT ON (item_id)
              id,
              item_id,
              status,
              target_cents,
              target_quantity,
              currency_code,
              is_quantity_based,
              created_at
            FROM gift_purchase_groups
            WHERE item_id = ANY($1::uuid[])
              AND deleted_at IS NULL
              AND status <> 'abandoned'
            ORDER BY item_id, created_at DESC
          `,
          [itemIds]
        );

        groupRows.forEach((row) => {
          sharedGroupsMap.set(row.item_id, row);
        });

        const activeGroupIds = groupRows.map((row) => row.id);
        if (activeGroupIds.length > 0) {
          const { rows: contributionRows } = await db.query(
            `
              SELECT
                group_id,
                COALESCE(SUM(CASE WHEN status IN ('pledged', 'fulfilled') THEN contribution_cents ELSE 0 END), 0) AS contributed_cents,
                COALESCE(SUM(CASE WHEN status IN ('pledged', 'fulfilled') THEN contribution_quantity ELSE 0 END), 0) AS contribution_quantity,
                COALESCE(SUM(CASE WHEN status = 'fulfilled' THEN contribution_cents ELSE 0 END), 0) AS fulfilled_cents,
                COUNT(*) FILTER (WHERE status IN ('pledged', 'fulfilled')) AS contributor_count
              FROM gift_contributions
              WHERE group_id = ANY($1::uuid[])
                AND deleted_at IS NULL
              GROUP BY group_id
            `,
            [activeGroupIds]
          );

          contributionRows.forEach((row) => {
            contributionSummaryMap.set(row.group_id, {
              contributedCents: Number(row.contributed_cents) || 0,
              contributedQuantity: Number(row.contribution_quantity) || 0,
              fulfilledCents: Number(row.fulfilled_cents) || 0,
              contributorCount: Number(row.contributor_count) || 0,
            });
          });
        }
      }

      const items = itemRows.map((item) => {
        const reservations = reservationsByItem.get(item.id) || [];
        const status = buildReservationResponse({
          item,
          reservations,
          userId,
          isListOwner: isOwner,
        });

        let sharedPurchase = null;
        const groupRow = sharedGroupsMap.get(item.id);
        if (groupRow) {
          const summary = contributionSummaryMap.get(groupRow.id) || {
            contributedCents: 0,
            contributedQuantity: 0,
            fulfilledCents: 0,
            contributorCount: 0,
          };
          const contributedCents = summary.contributedCents || 0;
          const contributedQuantity = summary.contributedQuantity || 0;
          const remainingCents =
            groupRow.target_cents == null
              ? null
              : Math.max(groupRow.target_cents - contributedCents, 0);
          const remainingQuantity = groupRow.is_quantity_based && groupRow.target_quantity != null
            ? Math.max(groupRow.target_quantity - contributedQuantity, 0)
            : null;

          sharedPurchase = {
            id: groupRow.id,
            status: groupRow.status,
            targetCents: groupRow.target_cents,
            targetQuantity: groupRow.target_quantity,
            isQuantityBased: groupRow.is_quantity_based,
            currency: groupRow.currency_code,
            contributedCents,
            contributedQuantity,
            remainingCents,
            remainingQuantity,
            contributorCount: summary.contributorCount || 0,
          };
        }

        return {
          ...item,
          giftStatus: status,
          gift_status: status,
          is_reserved: status.is_reserved,
          is_purchased: status.is_purchased,
          reserved_quantity: status.reserved_quantity,
          purchased_quantity: status.purchased_quantity,
          available_quantity: status.available_quantity,
          sharedPurchase,
        };
      });

      return res.json({
        list_id: listId,
        list_title: list.title,
        is_owner: isOwner,
        items: items
      });
      
    } catch (error) {
      console.error('Error fetching list reservations:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
};

module.exports = GiftController;
