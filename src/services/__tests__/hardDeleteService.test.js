const { performHardDelete } = require('../hardDeleteService');

// Mock db layer
jest.mock('../../config/db', () => {
  const capturedQueries = [];
  const mockClient = {
    query: jest.fn(async (sql, params) => {
      capturedQueries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      // Return rows for SELECT so that service has ids to work with
      if (/SELECT id FROM list_items/i.test(sql)) {
        return { rows: [{ id: 'itm1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };

  return {
    transaction: jest.fn(async (cb) => {
      return cb(mockClient);
    }),
  };
});

describe('performHardDelete', () => {
  it('throws when required params missing', async () => {
    await expect(performHardDelete({})).rejects.toThrow('userId required');
  });

  it('hard-deletes specific items and returns counts', async () => {
    const res = await performHardDelete({
      userId: 'user1',
      mode: 'items',
      itemIds: ['itm1'],
      deleteEmbeddings: true,
    });

    expect(res.itemsProcessed).toBe(1);
    expect(res.deletedCounts).toHaveProperty('list_items', 1);
    expect(res.deletedCounts).toHaveProperty('embeddings');
  });
});
