jest.mock('../../config/db', () => ({
  query: jest.fn(async (_sql, _params) => ({ rowCount: 5 })),
}));

const db = require('../../config/db');
const { clearChangeLogForUser } = require('../changeLogService');

describe('clearChangeLogForUser', () => {
  it('throws when userId missing', async () => {
    await expect(clearChangeLogForUser()).rejects.toThrow('userId required');
  });

  it('returns count of deleted rows', async () => {
    const result = await clearChangeLogForUser('user-123');
    expect(result).toEqual({ deleted: 5 });
    expect(db.query).toHaveBeenCalledWith(
      'DELETE FROM change_log WHERE user_id = $1',
      ['user-123'],
    );
  });
});
