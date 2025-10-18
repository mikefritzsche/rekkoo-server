const db = require('../config/db');

const DEFAULT_RESERVATION_QUANTITY = 1;

const normalizeReservationQuantity = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_RESERVATION_QUANTITY;
  }
  const normalized = Math.floor(numeric);
  return normalized > 0 ? normalized : DEFAULT_RESERVATION_QUANTITY;
};

const buildReservedByPayload = (row, userId, isListOwner) => {
  if (!row.reserved_by) {
    return null;
  }

  const isMe = String(row.reserved_by) === String(userId);

  if (isListOwner && !isMe) {
    return null;
  }

  return {
    id: row.reserved_by,
    username: row.username || row.reserved_by_username || null,
    full_name: row.full_name || row.reserved_by_full_name || null,
    is_me: isMe,
  };
};

const buildReservationResponse = ({ item, reservations, userId, isListOwner }) => {
  const itemQuantityRaw = item?.quantity ?? item?.gift_quantity ?? DEFAULT_RESERVATION_QUANTITY;
  const itemQuantity = normalizeReservationQuantity(itemQuantityRaw);

  let reservedQuantity = 0;
  let purchasedQuantity = 0;

  const normalizedReservations = reservations.map((row) => {
    const quantity = normalizeReservationQuantity(row.quantity);
    if (row.is_purchased) {
      purchasedQuantity += quantity;
    } else {
      reservedQuantity += quantity;
    }

    const reservedBy = buildReservedByPayload(row, userId, isListOwner);
    const isMine = Boolean(reservedBy?.is_me);

    return {
      id: row.id,
      item_id: row.item_id,
      quantity,
      is_purchased: row.is_purchased,
      reservation_message: row.reservation_message || null,
      reserved_at: row.created_at,
      updated_at: row.updated_at,
      active_purchase_group_id: row.active_purchase_group_id || null,
      reserved_by: reservedBy,
      is_mine: isMine,
    };
  });

  const availableQuantity = Math.max(itemQuantity - reservedQuantity - purchasedQuantity, 0);
  const myReservations = normalizedReservations.filter((reservation) => reservation.is_mine);

  const primaryReservation =
    normalizedReservations.find((reservation) => !reservation.is_purchased) ||
    normalizedReservations[0] ||
    null;

  const statusLabel = purchasedQuantity >= itemQuantity
    ? 'purchased'
    : reservedQuantity > 0
      ? 'reserved'
      : 'available';

  return {
    item_id: item?.id,
    list_id: item?.list_id,
    is_list_owner: isListOwner,
    total_quantity: itemQuantity,
    reserved_quantity: reservedQuantity,
    purchased_quantity: purchasedQuantity,
    available_quantity: availableQuantity,
    is_reserved: reservedQuantity > 0,
    is_purchased: purchasedQuantity > 0,
    is_fully_claimed: availableQuantity <= 0,
    is_fully_purchased: purchasedQuantity >= itemQuantity && itemQuantity > 0,
    reservations: normalizedReservations,
    my_reservations: myReservations,
    reserved_by: primaryReservation?.reserved_by || null,
    reservation_message: primaryReservation?.reservation_message || null,
    status: statusLabel,
  };
};

const fetchActiveReservationsForItem = async (itemId, { forUpdate = false } = {}) => {
  const lockClause = forUpdate ? ' FOR UPDATE OF gr' : '';
  const { rows } = await db.query(
    `SELECT 
       gr.*,
       u.username,
       u.full_name
     FROM gift_reservations gr
     LEFT JOIN users u ON gr.reserved_by = u.id
     WHERE gr.item_id = $1
       AND gr.deleted_at IS NULL
     ORDER BY gr.created_at ASC${lockClause}`,
    [itemId]
  );

  return rows.map((row) => ({
    ...row,
    quantity: normalizeReservationQuantity(row.quantity),
  }));
};

module.exports = {
  DEFAULT_RESERVATION_QUANTITY,
  normalizeReservationQuantity,
  buildReservationResponse,
  fetchActiveReservationsForItem,
};
