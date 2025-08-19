const db = require('../config/db');

async function exportUserData({ userId, mode = 'all', listIds = [], itemIds = [] }) {
  if (!userId) throw new Error('userId required');
  if (!['all', 'lists', 'items'].includes(mode)) throw new Error('invalid mode');

  // resolve items
  let itemRows = [];
  if (mode === 'all') {
    ({ rows: itemRows } = await db.query('SELECT * FROM list_items WHERE owner_id = $1 AND deleted_at IS NULL', [userId]));
  } else if (mode === 'lists') {
    ({ rows: itemRows } = await db.query('SELECT * FROM list_items WHERE list_id = ANY($1) AND deleted_at IS NULL', [listIds]));
  } else {
    ({ rows: itemRows } = await db.query('SELECT * FROM list_items WHERE id = ANY($1) AND deleted_at IS NULL', [itemIds]));
  }

  // fetch lists relevant
  const listIdSet = [...new Set(itemRows.map(r => r.list_id))];
  const { rows: listRows } = await db.query('SELECT * FROM lists WHERE id = ANY($1)', [listIdSet]);

  return { lists: listRows, items: itemRows };
}

module.exports = { exportUserData };
