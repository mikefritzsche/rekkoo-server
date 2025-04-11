const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
    res.json
//   try {
//     const result = await db.query(
//       'INSERT INTO users (username, email, password_hash, full_name, is_active, is_verified) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
//       [username, email, password_hash, full_name, is_active, is_verified]
//     );
//     res.status(201).json(result.rows[0]);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'Internal server error' });
//   }
});

module.exports = router;
