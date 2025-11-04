const favoritesControllerFactory = require('../FavoritesController');
const db = require('../../config/db');

jest.mock('../../config/db');

describe('FavoritesController.getLikersForTarget', () => {
  let favoritesController;
  let req;
  let res;

  beforeEach(() => {
    favoritesController = favoritesControllerFactory();
    req = {
      user: { id: 'viewer-1' },
      query: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    jest.clearAllMocks();
  });

  it('returns 400 when neither list_id nor list_item_id is provided', async () => {
    await favoritesController.getLikersForTarget(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Either list_id or list_item_id must be provided',
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns likers for a list when requester is the owner', async () => {
    req.query = { list_id: 'list-123' };
    const likerRows = [
      {
        id: 'fav-1',
        user_id: 'user-2',
        created_at: '2025-01-01T00:00:00Z',
        username: 'friend',
        display_name: 'Friend',
        avatar_url: null,
      },
    ];

    db.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM public.lists l') && sql.includes('COALESCE(l.is_public')) {
        return Promise.resolve({
          rows: [{ owner_id: req.user.id, is_public: false }],
        });
      }
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({
          rows: [{ column_name: 'list_id' }, { column_name: 'list_item_id' }],
        });
      }
      if (sql.includes('FROM public.favorites f')) {
        expect(sql).toContain('f.list_id = $1');
        expect(params).toEqual(['list-123']);
        return Promise.resolve({ rows: likerRows });
      }
      throw new Error(`Unexpected query executed: ${sql}`);
    });

    await favoritesController.getLikersForTarget(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: likerRows });
  });

  it('resolves list_id from list_item_id and queries favorites by list item', async () => {
    req.query = { list_item_id: 'item-456' };
    const likerRows = [
      {
        id: 'fav-2',
        user_id: 'user-99',
        created_at: '2025-02-02T00:00:00Z',
        username: 'viewer',
        display_name: 'Viewer',
        avatar_url: 'https://cdn/test.png',
      },
    ];

    db.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM public.list_items li')) {
        expect(params).toEqual(['item-456']);
        return Promise.resolve({ rows: [{ list_id: 'resolved-list' }] });
      }
      if (sql.includes('FROM public.lists l') && sql.includes('COALESCE(l.is_public')) {
        return Promise.resolve({
          rows: [{ owner_id: 'someone-else', is_public: true }],
        });
      }
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({
          rows: [{ column_name: 'list_id' }, { column_name: 'list_item_id' }],
        });
      }
      if (sql.includes('FROM public.favorites f')) {
        expect(sql).toContain('f.list_item_id = $1');
        expect(params).toEqual(['item-456']);
        return Promise.resolve({ rows: likerRows });
      }
      throw new Error(`Unexpected query executed: ${sql}`);
    });

    await favoritesController.getLikersForTarget(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: likerRows });
  });

  it('returns 403 when the viewer lacks access to the list', async () => {
    req.query = { list_id: 'private-list' };

    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM public.lists l') && sql.includes('COALESCE(l.is_public')) {
        return Promise.resolve({
          rows: [{ owner_id: 'owner-1', is_public: false }],
        });
      }
      if (sql.includes('FROM public.list_collaborators')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('user_can_access_list_through_group')) {
        return Promise.resolve({ rows: [{ can_access: false }] });
      }
      throw new Error(`Unexpected query executed: ${sql}`);
    });

    await favoritesController.getLikersForTarget(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('falls back to legacy group membership when helper function is unavailable', async () => {
    req.query = { list_id: 'shared-list' };
    const likerRows = [
      {
        id: 'fav-3',
        user_id: 'user-55',
        created_at: '2025-03-03T00:00:00Z',
        username: 'ally',
        display_name: 'Ally',
        avatar_url: null,
      },
    ];

    db.query.mockImplementation((sql, params) => {
      if (sql.includes('FROM public.lists l') && sql.includes('COALESCE(l.is_public')) {
        return Promise.resolve({
          rows: [{ owner_id: 'owner-1', is_public: false }],
        });
      }
      if (sql.includes('FROM public.list_collaborators')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('user_can_access_list_through_group')) {
        return Promise.reject(new Error('function does not exist'));
      }
      if (sql.includes('FROM public.collaboration_group_lists')) {
        expect(params).toEqual(['shared-list', req.user.id]);
        return Promise.resolve({ rows: [{ exists: true }] });
      }
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({
          rows: [{ column_name: 'list_id' }, { column_name: 'list_item_id' }],
        });
      }
      if (sql.includes('FROM public.favorites f')) {
        expect(sql).toContain('f.list_id = $1');
        expect(params).toEqual(['shared-list']);
        return Promise.resolve({ rows: likerRows });
      }
      throw new Error(`Unexpected query executed: ${sql}`);
    });

    await favoritesController.getLikersForTarget(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: likerRows });
    const issuedQueries = db.query.mock.calls.map(([text]) => text);
    expect(issuedQueries.some((sql) => sql.includes('public.collaboration_group_lists'))).toBe(true);
  });
});
