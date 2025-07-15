const db = require('../config/db');

function publicListsControllerFactory() {
  /**
   * GET /v1.0/lists/:id
   * Returns list metadata plus its non-deleted items
   */
  const getListById = async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id param required' });
    try {
      const listQuery = `SELECT * FROM public.lists WHERE id = $1 AND deleted_at IS NULL LIMIT 1`;
      const listResult = await db.query(listQuery, [id]);
      if (listResult.rows.length === 0) {
        return res.status(404).json({ error: 'List not found' });
      }
      const list = listResult.rows[0];
      const itemsQuery = `SELECT * FROM public.list_items WHERE list_id = $1 AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC`;
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