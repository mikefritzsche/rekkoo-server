const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/NotificationService');

const GiftController = {
  // Get gift reservation status for an item
  getItemReservationStatus: async (req, res) => {
    const { itemId } = req.params;
    const userId = req.user.id;
    
    try {
      // Get item details to check list ownership
      const { rows: itemRows } = await db.query(
        `SELECT li.*, l.owner_id as list_owner_id, l.title as list_title
         FROM list_items li
         JOIN lists l ON li.list_id = l.id
         WHERE li.id = $1 AND li.deleted_at IS NULL`,
        [itemId]
      );
      
      if (itemRows.length === 0) {
        return res.status(404).json({ error: 'Item not found' });
      }
      
      const item = itemRows[0];
      const isListOwner = String(item.list_owner_id) === String(userId);
      
      // Get reservation details
      const { rows: reservations } = await db.query(
        `SELECT gr.*, u.username, u.full_name
         FROM gift_reservations gr
         JOIN users u ON gr.reserved_by = u.id
         WHERE gr.item_id = $1 AND gr.deleted_at IS NULL
         ORDER BY gr.created_at DESC
         LIMIT 1`,
        [itemId]
      );
      
      const reservation = reservations[0] || null;
      
      // Prepare response based on user's relationship to the list
      let response = {
        item_id: itemId,
        is_reserved: !!reservation,
        is_purchased: reservation?.is_purchased || false,
        is_list_owner: isListOwner
      };
      
      if (reservation) {
        if (isListOwner) {
          // List owner sees that item is reserved/purchased but not by whom
          response.status = reservation.is_purchased ? 'purchased' : 'reserved';
        } else {
          // Other users see full details including who reserved/purchased
          response = {
            ...response,
            status: reservation.is_purchased ? 'purchased' : 'reserved',
            reserved_by: {
              id: reservation.reserved_by,
              username: reservation.username,
              full_name: reservation.full_name,
              is_me: String(reservation.reserved_by) === String(userId)
            },
            reservation_message: reservation.reservation_message,
            reserved_at: reservation.created_at,
            updated_at: reservation.updated_at
          };
        }
      }
      
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
    
    try {
      await db.query('BEGIN');
      
      // Get item and list details
      const { rows: itemRows } = await db.query(
        `SELECT li.*, l.owner_id as list_owner_id, l.title as list_title, l.id as list_id
         FROM list_items li
         JOIN lists l ON li.list_id = l.id
         WHERE li.id = $1 AND li.deleted_at IS NULL`,
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
        return res.status(403).json({ error: 'Cannot reserve items from your own list' });
      }
      
      // Check if item is already reserved
      const { rows: existingReservations } = await db.query(
        `SELECT * FROM gift_reservations 
         WHERE item_id = $1 AND deleted_at IS NULL`,
        [itemId]
      );
      
      if (existingReservations.length > 0) {
        await db.query('ROLLBACK');
        return res.status(409).json({ error: 'Item is already reserved' });
      }
      
      // Create reservation
      const reservationId = uuidv4();
      const { rows: newReservation } = await db.query(
        `INSERT INTO gift_reservations (id, item_id, reserved_by, reserved_for, reservation_message, is_purchased)
         VALUES ($1, $2, $3, $4, $5, false)
         RETURNING *`,
        [reservationId, itemId, userId, item.list_owner_id, reservation_message]
      );
      
      await db.query('COMMIT');
      
      // Send notifications to group members (except list owner)
      await NotificationService.notifyGroupMembers({
        listId: item.list_id,
        excludeUserId: item.list_owner_id,
        type: 'item_reserved',
        data: {
          item_title: item.title,
          list_title: item.list_title,
          reserved_by: req.user.username,
          reservation_id: reservationId
        }
      });
      
      return res.status(201).json({
        success: true,
        reservation: newReservation[0],
        message: 'Item successfully reserved'
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
    
    try {
      await db.query('BEGIN');
      
      // Get item and list details
      const { rows: itemRows } = await db.query(
        `SELECT li.*, l.owner_id as list_owner_id, l.title as list_title, l.id as list_id
         FROM list_items li
         JOIN lists l ON li.list_id = l.id
         WHERE li.id = $1 AND li.deleted_at IS NULL`,
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
      
      // Check existing reservation
      const { rows: existingReservations } = await db.query(
        `SELECT * FROM gift_reservations 
         WHERE item_id = $1 AND deleted_at IS NULL`,
        [itemId]
      );
      
      if (existingReservations.length > 0) {
        const reservation = existingReservations[0];
        
        // If already purchased, return error
        if (reservation.is_purchased) {
          await db.query('ROLLBACK');
          return res.status(409).json({ error: 'Item has already been purchased' });
        }
        
        // If reserved by someone else, return error
        // Convert both to strings for comparison to handle UUID type differences
        if (String(reservation.reserved_by) !== String(userId)) {
          await db.query('ROLLBACK');
          return res.status(403).json({ error: 'Item is reserved by another user' });
        }
        
        // Update existing reservation to purchased
        const { rows: updatedReservation } = await db.query(
          `UPDATE gift_reservations 
           SET is_purchased = true, 
               reservation_message = COALESCE($2, reservation_message),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [reservation.id, purchase_message || reservation.reservation_message]
        );
        
        await db.query('COMMIT');
        
        // Send notifications
        await NotificationService.notifyGroupMembers({
          listId: item.list_id,
          excludeUserId: item.list_owner_id,
          type: 'item_purchased',
          data: {
            item_title: item.title,
            list_title: item.list_title,
            purchased_by: req.user.username
          }
        });
        
        return res.json({
          success: true,
          reservation: updatedReservation[0],
          message: 'Item marked as purchased'
        });
      } else {
        // Create new reservation marked as purchased
        const reservationId = uuidv4();
        const { rows: newReservation } = await db.query(
          `INSERT INTO gift_reservations (id, item_id, reserved_by, reserved_for, reservation_message, is_purchased)
           VALUES ($1, $2, $3, $4, $5, true)
           RETURNING *`,
          [reservationId, itemId, userId, item.list_owner_id, purchase_message || 'Purchased']
        );
        
        await db.query('COMMIT');
        
        // Send notifications
        await NotificationService.notifyGroupMembers({
          listId: item.list_id,
          excludeUserId: item.list_owner_id,
          type: 'item_purchased',
          data: {
            item_title: item.title,
            list_title: item.list_title,
            purchased_by: req.user.username
          }
        });
        
        return res.status(201).json({
          success: true,
          reservation: newReservation[0],
          message: 'Item successfully marked as purchased'
        });
      }
      
    } catch (error) {
      await db.query('ROLLBACK');
      console.error('Error purchasing item:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },

  // Release a reservation or purchase
  releaseItem: async (req, res) => {
    const { itemId } = req.params;
    const userId = req.user.id;
    
    try {
      await db.query('BEGIN');
      
      // Get reservation
      const { rows: reservations } = await db.query(
        `SELECT gr.*, li.list_id, l.title as list_title, li.title as item_title
         FROM gift_reservations gr
         JOIN list_items li ON gr.item_id = li.id
         JOIN lists l ON li.list_id = l.id
         WHERE gr.item_id = $1 AND gr.deleted_at IS NULL`,
        [itemId]
      );
      
      if (reservations.length === 0) {
        await db.query('ROLLBACK');
        return res.status(404).json({ error: 'No reservation found for this item' });
      }
      
      const reservation = reservations[0];
      
      // Check if user can release (must be the one who reserved)
      // Convert both to strings for comparison to handle UUID type differences
      if (String(reservation.reserved_by) !== String(userId)) {
        console.log('[GiftController] Release denied:', {
          reserved_by: reservation.reserved_by,
          reserved_by_type: typeof reservation.reserved_by,
          userId: userId,
          userId_type: typeof userId,
          comparison: reservation.reserved_by === userId,
          stringComparison: String(reservation.reserved_by) === String(userId)
        });
        await db.query('ROLLBACK');
        return res.status(403).json({ error: 'You can only release your own reservations' });
      }
      
      // Soft delete the reservation
      await db.query(
        `UPDATE gift_reservations 
         SET deleted_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [reservation.id]
      );
      
      await db.query('COMMIT');
      
      // Send notifications
      const notificationType = reservation.is_purchased ? 'purchase_released' : 'reservation_released';
      await NotificationService.notifyGroupMembers({
        listId: reservation.list_id,
        excludeUserId: reservation.reserved_for,
        type: notificationType,
        data: {
          item_title: reservation.item_title,
          list_title: reservation.list_title,
          released_by: req.user.username
        }
      });
      
      return res.json({
        success: true,
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
    
    try {
      // Check if user has access to the list
      const { rows: accessCheck } = await db.query(
        `SELECT l.id, l.owner_id, l.title, l.list_type, l.is_public, l.is_collaborative,
          EXISTS(
            SELECT 1 FROM list_group_roles lgr
            JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
            WHERE lgr.list_id = l.id AND cgm.user_id = $2 AND lgr.deleted_at IS NULL
          ) as has_group_access,
          EXISTS(
            SELECT 1 FROM list_user_overrides luo
            WHERE luo.list_id = l.id AND luo.user_id = $2 AND luo.deleted_at IS NULL
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
        isGiftList: list.list_type === 'gifts'
      });
      
      // Allow access if:
      // 1. User is the owner
      // 2. User has group access
      // 3. User has direct access (list_user_overrides)
      // 4. List is public and is a gift list
      // 5. List is collaborative
      const hasAccess = isOwner || 
                       list.has_group_access || 
                       list.has_direct_access ||
                       (list.is_public && list.list_type === 'gifts') ||
                       list.is_collaborative;
      
      console.log('[GiftController.getListReservations] Has access:', hasAccess);
      
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      // Get all items with reservation status
      let query;
      let params = [listId];
      
      if (isOwner) {
        // Owner sees limited info
        query = `
          SELECT li.id, li.title, li.description, li.image_url, li.price,
                 EXISTS(
                   SELECT 1 FROM gift_reservations gr 
                   WHERE gr.item_id = li.id AND gr.deleted_at IS NULL
                 ) as is_reserved,
                 EXISTS(
                   SELECT 1 FROM gift_reservations gr 
                   WHERE gr.item_id = li.id AND gr.is_purchased = true AND gr.deleted_at IS NULL
                 ) as is_purchased
          FROM list_items li
          WHERE li.list_id = $1 AND li.deleted_at IS NULL
          ORDER BY li.priority ASC, li.created_at DESC`;
      } else {
        // Group members see full details
        query = `
          SELECT li.id, li.title, li.description, li.image_url, li.price,
                 gr.id as reservation_id, gr.is_purchased, gr.reservation_message,
                 gr.reserved_by, gr.created_at as reserved_at,
                 u.username as reserved_by_username, u.full_name as reserved_by_name,
                 CASE WHEN gr.reserved_by = $2 THEN true ELSE false END as is_mine
          FROM list_items li
          LEFT JOIN gift_reservations gr ON li.id = gr.item_id AND gr.deleted_at IS NULL
          LEFT JOIN users u ON gr.reserved_by = u.id
          WHERE li.list_id = $1 AND li.deleted_at IS NULL
          ORDER BY li.priority ASC, li.created_at DESC`;
        params.push(userId);
      }
      
      const { rows: items } = await db.query(query, params);
      
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