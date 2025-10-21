const db = require('../config/db');

/**
 * Permanently removes all change_log entries associated with a user.
 * @param {string} userId
 * @returns {Promise<{ deleted: number }>}
 */
async function clearChangeLogForUser(userId) {
  if (!userId) {
    throw new Error('userId required');
  }

  const { rowCount } = await db.query(
    'DELETE FROM change_log WHERE user_id = $1',
    [userId],
  );

  return { deleted: rowCount };
}

module.exports = {
  clearChangeLogForUser,
};
