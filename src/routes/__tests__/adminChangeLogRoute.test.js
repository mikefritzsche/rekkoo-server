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

const mockClear = jest.fn().mockResolvedValue({ deleted: 7 });

jest.mock('../../services/changeLogService', () => ({
  clearChangeLogForUser: (...args) => mockClear(...args),
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

describe('DELETE /users/:userId/change-log', () => {
  it('invokes clearChangeLogForUser and returns count', async () => {
    const res = await request(app).delete('/users/u1/change-log');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, deleted: 7 });
    expect(mockClear).toHaveBeenCalledWith('u1');
  });
});
