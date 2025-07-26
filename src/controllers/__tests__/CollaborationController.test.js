const CollaborationController = require('../CollaborationController');
const db = require('../../config/db');

jest.mock('../../config/db');

describe('CollaborationController', () => {
  let req, res;

  beforeEach(() => {
    req = {
      body: {},
      params: {},
      user: { id: 'user-123' },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createGroup', () => {
    it('should create a group successfully', async () => {
      req.body = { name: 'Test Group', description: 'A group for testing' };
      const newGroup = { id: 'group-456', ...req.body, owner_id: req.user.id };
      db.query.mockResolvedValue({ rows: [newGroup] });

      await CollaborationController.createGroup(req, res);

      expect(db.query).toHaveBeenCalledWith(
        'INSERT INTO collaboration_groups (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *',
        ['Test Group', 'A group for testing', 'user-123']
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(newGroup);
    });

    it('should return 400 if group name is missing', async () => {
      await CollaborationController.createGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Group name is required' });
    });
  });

  describe('getGroupsForUser', () => {
    it('should fetch all groups for a user', async () => {
        const userGroups = [{ id: 'group-1', name: 'Owned Group', is_owner: true, role: null }, { id: 'group-2', name: 'Member Group', is_owner: false, role: 'member' }];
        db.query.mockResolvedValue({ rows: userGroups });

        await CollaborationController.getGroupsForUser(req, res);

        expect(db.query).toHaveBeenCalledWith(expect.any(String), [req.user.id]);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(userGroups);
    });
  });
  
  describe('addMemberToGroup', () => {
    it('should add a member to a group if user is the owner', async () => {
        req.params.groupId = 'group-owned-by-user';
        req.body = { userId: 'new-member-id', role: 'member' };
        
        // Mock that the user is the owner
        db.query.mockResolvedValueOnce({ rows: [{ owner_id: req.user.id }] });
        // Mock the insert operation
        db.query.mockResolvedValueOnce({ rows: [{ group_id: req.params.groupId, user_id: req.body.userId, role: 'member' }] });
        
        await CollaborationController.addMemberToGroup(req, res);

        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should return 403 if user is not the owner', async () => {
        req.params.groupId = 'group-not-owned-by-user';
        req.body = { userId: 'new-member-id' };
        
        // Mock that the user is NOT the owner
        db.query.mockResolvedValue({ rows: [{ owner_id: 'another-user-id' }] });
        
        await CollaborationController.addMemberToGroup(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Only the group owner can add members' });
    });
  });

  describe('claimGift', () => {
    it('should allow a user to claim a gift', async () => {
      req.params.itemId = 'item-123';
      db.query.mockResolvedValueOnce({ rows: [{ owner_id: 'owner-user-id' }] }); // Mock item fetch
      db.query.mockResolvedValueOnce({ rows: [{ id: 'reservation-123' }] }); // Mock reservation insert

      await CollaborationController.claimGift(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: 'reservation-123' });
    });

    it('should prevent a user from claiming their own gift', async () => {
      req.params.itemId = 'item-owned-by-user';
      db.query.mockResolvedValue({ rows: [{ owner_id: req.user.id }] }); // Mock item fetch, owner is the same as the requestor

      await CollaborationController.claimGift(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'You cannot claim items on your own list' });
    });
  });
}); 