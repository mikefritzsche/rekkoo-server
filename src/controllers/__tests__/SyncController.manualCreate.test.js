jest.mock('../../config/db');
jest.mock('../../services/ListService');
jest.mock('../../services/embeddingService');

const syncControllerFactory = require('../SyncController');
const db = require('../../config/db');
const ListService = require('../../services/ListService');
const EmbeddingService = require('../../services/embeddingService');

/**
 * This test covers the scenario where a user manually adds a list item to a list
 * that normally supports API-suggested items (e.g. movies, books). We expect:
 *   1. The item is inserted successfully via SyncController.handlePush.
 *   2. No detail record is created because `api_source` is empty / unknown.
 *   3. An embedding generation job is queued for the new list item.
 */
describe('SyncController – manual list item create', () => {
  let syncController;
  let mockReq;
  let mockRes;

  beforeEach(() => {
    const mockSocketService = {
      emitToUser: jest.fn(),
      notifyUser: jest.fn(),
    };
    syncController = syncControllerFactory(mockSocketService);

    mockReq = {
      user: { id: 'user-123' },
      body: { changes: [] },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };

    // Mock the DB transaction helper to provide a fake pg client
    db.transaction.mockImplementation(async (callback) => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 'mock-id' }], rowCount: 1 }),
        escapeIdentifier: (str) => `"${str}"`,
      };
      await callback(mockClient);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates list_item manually without detail record but queues embedding', async () => {
    const manualItem = {
      id: 'manual-1',
      title: 'Manual Item',
      description: 'Manually entered item',
      api_source: '', // No API source -> treated as manual entry
      custom_fields: [],
      api_metadata: {},
    };

    mockReq.body.changes = [
      {
        table_name: 'list_items',
        operation: 'create',
        record_id: manualItem.id,
        data: manualItem,
      },
    ];

    await syncController.handlePush(mockReq, mockRes);

    // Detail record should NOT be created for manual item
    expect(ListService.createDetailRecord).not.toHaveBeenCalled();

    // Embedding generation should be queued exactly once
    expect(EmbeddingService.queueEmbeddingGeneration).toHaveBeenCalledTimes(1);
    expect(EmbeddingService.queueEmbeddingGeneration).toHaveBeenCalledWith(
      'mock-id', // insertedId returned from mock client
      'list_item',
      expect.objectContaining({ operation: 'create' })
    );

    // Response should indicate success
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it('handles missing legacy list.type column and falls back to list_type', async () => {
    const manualItem = {
      id: 'manual-2',
      title: 'Manual Item 2',
      description: 'Manually entered item',
      custom_fields: [],
      api_metadata: {},
      list_id: 'list-xyz',
    };

    // Override the db.transaction mock for this test to simulate error 42703
    db.transaction.mockImplementationOnce(async (callback) => {
      const mockClient = {
        query: jest.fn((sql, params) => {
          if (typeof sql === 'string') {
            // 1) Insert new list_item
            if (sql.startsWith('INSERT INTO "list_items"')) {
              return Promise.resolve({ rows: [{ id: 'mock-insert-id' }], rowCount: 1 });
            }
            // 2) New column-existence probe against information_schema
            if (sql.includes('FROM information_schema.columns')) {
              return Promise.resolve({ rows: [{ column_name: 'list_type' }] }); // simulate only list_type column exists
            }
            // 3) Parent list lookup once column name has been chosen
            if (sql.includes('FROM lists') && sql.includes('list_type')) {
              return Promise.resolve({ rows: [{ lstype: 'movies' }] });
            }
            // 4) Patch FK back onto list_items
            if (sql.startsWith('UPDATE list_items SET')) {
              return Promise.resolve({ rowCount: 1 });
            }
          }
          // default stub
          return Promise.resolve({ rows: [{ id: 'stub' }], rowCount: 1 });
        }),
        escapeIdentifier: (str) => `"${str}"`,
      };
      await callback(mockClient);
    });

    ListService.createDetailRecord.mockResolvedValue({ id: 'detail-123' });

    // Force EmbeddingService to resolve
    EmbeddingService.queueEmbeddingGeneration.mockResolvedValue(true);

    mockReq.body.changes = [
      {
        table_name: 'list_items',
        operation: 'create',
        record_id: manualItem.id,
        data: manualItem,
      },
    ];

    await syncController.handlePush(mockReq, mockRes);

    // Ensure fallback path triggered detail creation with movies table
    expect(ListService.createDetailRecord).toHaveBeenCalledTimes(1);
    const callArgs = ListService.createDetailRecord.mock.calls[0];
    expect(callArgs[1]).toBe('movie_details'); // detail table
    expect(callArgs[3]).toBe('mock-insert-id'); // FK value

    // Ensure response success
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
}); 