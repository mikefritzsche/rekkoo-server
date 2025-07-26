const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

function listTypesControllerFactory() {
  /**
   * GET /v1.0/list-types
   * Returns all non-deleted list types
   */
  const getAll = async (req, res) => {
    try {
      const result = await db.query('SELECT * FROM public.list_types WHERE deleted_at IS NULL ORDER BY label ASC');
      res.json(result.rows);
    } catch (err) {
      console.error('[ListTypesController] getAll error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * POST /v1.0/list-types
   * Creates a new list type
   * Body: { id, label, description, icon, gradient, icon_color }
   */
  const create = async (req, res) => {
    try {
      const { id, label, description, icon, gradient, icon_color } = req.body;
      if (!id || !label) return res.status(400).json({ error: 'id and label required' });
      await db.query(
        `INSERT INTO public.list_types (id,label,description,icon,gradient,icon_color)
         VALUES ($1,$2,$3,$4,$5,$6)` ,
        [id, label, description, icon, JSON.stringify(gradient ?? []), icon_color]
      );
      const result = await db.query('SELECT * FROM public.list_types WHERE id = $1', [id]);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('[ListTypesController] create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * PATCH /v1.0/list-types/:id
   */
  const update = async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id param required' });
    const fields = ['label','description','icon','gradient','icon_color'];
    const sets = [];
    const values = [];
    fields.forEach((field, idx) => {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${values.length +1}`);
        values.push(field === 'gradient' ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    });
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(id);
    const sql = `UPDATE public.list_types SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`;
    try {
      const result = await db.query(sql, values);
      res.json(result.rows[0]);
    } catch (err) {
      console.error('[ListTypesController] update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  /**
   * DELETE /v1.0/list-types/:id  (soft delete)
   */
  const remove = async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'id param required' });
    try {
      await db.query('UPDATE public.list_types SET deleted_at = NOW() WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err) {
      console.error('[ListTypesController] delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  return { getAll, create, update, remove };
}

module.exports = listTypesControllerFactory; 