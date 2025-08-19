const express = require('express');
const request = require('supertest');

// Stub auth middleware to inject admin user
jest.mock('../../auth/middleware', () => ({
  authenticateJWT: (req, _res, next) => {
    req.user = { id: 'admin123' };
    next();
  },
}));

// Mock database check inside ensureAdmin by always returning rows
jest.mock('../../config/db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ dummy: 1 }] }),
}));

// Mock hardDelete service
const mockPerform = jest.fn().mockResolvedValue({
  deletedCounts: { list_items: 2 },
  itemsProcessed: 2,
});

jest.mock('../../services/hardDeleteService', () => ({
  performHardDelete: (...args) => mockPerform(...args),
}));

jest.mock('../../controllers/CacheController', () => ({
  getStats: jest.fn(),
  listKeys: jest.fn(),
  getKey: jest.fn(),
  deleteKey: jest.fn(),
  clearCache: jest.fn(),
  getCacheSettings: jest.fn(),
  updateCacheSettings: jest.fn(),
}));

const adminRoutes = require('../admin.routes');
const app = express();
app.use(express.json());
app.use('/', adminRoutes);

describe('POST /users/:userId/hard-delete', () => {
  it('invokes performHardDelete and returns 200', async () => {
    const payload = { mode: 'all', deleteEmbeddings: true };
    const res = await request(app)
      .post('/users/u1/hard-delete')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPerform).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', mode: 'all', deleteEmbeddings: true }),
    );
  });
});
