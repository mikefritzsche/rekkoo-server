const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * Perform irreversible hard-delete operations for a user.
 *
 * @param {Object} opts
 * @param {string} opts.userId                 Target user
 * @param {'all'|'lists'|'items'} opts.mode    Scope of delete
 * @param {string[]} [opts.listIds]
 * @param {string[]} [opts.itemIds]
 * @param {boolean} [opts.deleteEmbeddings]    Also delete embeddings / queue (default true)
 *
 * @returns {Promise<{deletedCounts:Object}>}
 */
async function performHardDelete({ userId, mode = 'all', listIds = [], itemIds = [], deleteEmbeddings = true }) {
  if (!userId) throw new Error('userId required');
  if (!['all', 'lists', 'items'].includes(mode)) throw new Error('Invalid mode');
  if (mode === 'lists' && (!Array.isArray(listIds) || listIds.length === 0)) {
    throw new Error('listIds required when mode = "lists"');
  }
  if (mode === 'items' && (!Array.isArray(itemIds) || itemIds.length === 0)) {
    throw new Error('itemIds required when mode = "items"');
  }

  return db.transaction(async (client) => {
    // 1. Resolve target item ids -------------------------------------------
    let itemQuery;
    let params = [userId];

    if (mode === 'all') {
      itemQuery = 'SELECT id FROM list_items WHERE owner_id = $1';
    } else if (mode === 'lists') {
      params.push(listIds);
      itemQuery = 'SELECT id FROM list_items WHERE owner_id = $1 AND list_id = ANY($2)';
    } else {
      params.push(itemIds);
      itemQuery = 'SELECT id FROM list_items WHERE owner_id = $1 AND id = ANY($2)';
    }

    const { rows: itemRows } = await client.query(itemQuery, params);
    const targetItemIds = itemRows.map((r) => r.id);

    // When mode === 'items' but some ids don\'t belong to user, we simply skip them.
    if (targetItemIds.length === 0) {
      return { deletedCounts: {}, items: 0 };
    }

    // Helper to run delete + capture count
    const runDel = async (sql, values) => {
      const res = await client.query(sql, values);
      return res.rowCount;
    };

    const counts = {};

    // 2. Child tables -------------------------------------------------------
    counts.list_item_tags = await runDel(
      'DELETE FROM list_item_tags WHERE item_id = ANY($1)',
      [targetItemIds],
    );

    counts.list_item_categories = await runDel(
      'DELETE FROM list_item_categories WHERE item_id = ANY($1)',
      [targetItemIds],
    );

    counts.favorites = await runDel(
      "DELETE FROM favorites WHERE target_type = 'item' AND target_id = ANY($1)",
      [targetItemIds],
    );

    counts.reviews = await runDel(
      'DELETE FROM reviews WHERE item_id = ANY($1)',
      [targetItemIds],
    );

    // Detail tables (all use list_item_id FK)
    const detailTables = [
      'movie_details',
      'tv_details',
      'book_details',
      'place_details',
      'recipe_details',
      'spotify_item_details',
    ];
    for (const tbl of detailTables) {
      counts[tbl] = await runDel(
        `DELETE FROM ${tbl} WHERE list_item_id = ANY($1)`,
        [targetItemIds],
      );
    }

    // 3. Embeddings ---------------------------------------------------------
    if (deleteEmbeddings) {
      counts.embeddings = await runDel(
        "DELETE FROM embeddings WHERE entity_type = 'list_item' AND related_entity_id = ANY($1)",
        [targetItemIds],
      );
      counts.embedding_queue = await runDel(
        "DELETE FROM embedding_queue WHERE entity_type = 'list_item' AND entity_id = ANY($1)",
        [targetItemIds],
      );
    }

    // 4. Finally delete the items ------------------------------------------
    counts.list_items = await runDel(
      'DELETE FROM list_items WHERE id = ANY($1)',
      [targetItemIds],
    );

    // 5. Optionally delete the lists themselves when mode = 'all' or 'lists'
    if (mode === 'all') {
      counts.lists = await runDel('DELETE FROM lists WHERE owner_id = $1', [userId]);
    }
    if (mode === 'lists' && listIds.length) {
      counts.lists = await runDel('DELETE FROM lists WHERE id = ANY($1)', [listIds]);
    }

    return { deletedCounts: counts, itemsProcessed: targetItemIds.length };
  });
}

module.exports = {
  performHardDelete,
};
