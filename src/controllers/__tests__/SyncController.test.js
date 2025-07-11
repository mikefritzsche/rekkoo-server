jest.mock('../../config/db');
const syncControllerFactory = require('../SyncController');
const ListService = require('../../services/ListService');
const db = require('../../config/db');

jest.mock('../../services/ListService');
jest.mock('../../services/embeddingService'); // mock EmbeddingService

describe('SyncController', () => {
  let mockSocketService;
  let syncController;
  let mockReq;
  let mockRes;

  beforeEach(() => {
    mockSocketService = {
      emitToUser: jest.fn(),
      notifyUser: jest.fn(),
    };
    syncController = syncControllerFactory(mockSocketService);

    mockReq = {
      user: { id: 'user-123' },
      body: {
        changes: [],
      },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    db.transaction.mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn((sql, params) => {
            // Provide column names for table introspection queries
            if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
              return Promise.resolve({
                rows: [
                  { column_name: 'id' },
                  { column_name: 'title' },
                  { column_name: 'description' },
                  { column_name: 'api_source' },
                  { column_name: 'api_metadata' },
                  { column_name: 'custom_fields' },
                  { column_name: 'status' },
                ],
              });
            }
            return Promise.resolve({ rows: [{ id: 'mock-id' }], rowCount: 1 });
          }),
          escapeIdentifier: (str) => `"${str}"`,
        };
        await callback(mockClient);
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handlePush', () => {
    it('should call ListService.createDetailRecord for a new movie list item', async () => {
      const movieItem = {
        id: 'item-1',
        title: 'New Movie',
        api_source: 'movie',
        api_metadata: {
          tmdb_id: 'tmdb-123',
          release_date: '2024-01-01',
        },
      };

      mockReq.body.changes = [
        {
          table_name: 'list_items',
          operation: 'create',
          record_id: 'item-1',
          data: movieItem,
        },
      ];
      
      ListService.createDetailRecord.mockResolvedValue({ id: 'movie-detail-456' });

      await syncController.handlePush(mockReq, mockRes);
      
      expect(ListService.createDetailRecord).toHaveBeenCalledTimes(1);
    });

    it('should handle list_items update operations without errors', async () => {
      mockReq.body.changes = [
        {
          table_name: 'list_items',
          operation: 'update',
          record_id: 'item-1',
          data: {
            title: 'Updated Movie Title',
            description: 'Updated description',
          },
        },
      ];

      await syncController.handlePush(mockReq, mockRes);
      
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should handle list_items delete operations without errors', async () => {
      mockReq.body.changes = [
        {
          table_name: 'list_items',
          operation: 'delete',
          record_id: 'item-1',
          data: {},
        },
      ];

      await syncController.handlePush(mockReq, mockRes);
      
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should handle user_settings update operations without errors', async () => {
      mockReq.body.changes = [
        {
          table_name: 'user_settings',
          operation: 'update',
          record_id: 'user-123',
          data: {
            user_id: 'user-123',
            theme: 'dark',
            notification_preferences: { email: true },
          },
        },
      ];

      await syncController.handlePush(mockReq, mockRes);
      
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should handle user_settings delete operations without errors', async () => {
      mockReq.body.changes = [
        {
          table_name: 'user_settings',
          operation: 'delete',
          record_id: 'user-123',
          data: {},
        },
      ];

      await syncController.handlePush(mockReq, mockRes);
      
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should handle multiple operations in a single request', async () => {
      mockReq.body.changes = [
        {
          table_name: 'list_items',
          operation: 'create',
          record_id: 'item-1',
          data: {
            id: 'item-1',
            title: 'New Movie',
            api_source: 'movie',
          },
        },
        {
          table_name: 'list_items',
          operation: 'update',
          record_id: 'item-2',
          data: {
            title: 'Updated Movie',
          },
        },
        {
          table_name: 'user_settings',
          operation: 'update',
          record_id: 'user-123',
          data: {
            user_id: 'user-123',
            theme: 'light',
          },
        },
      ];

      await syncController.handlePush(mockReq, mockRes);
      
      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });
}); 