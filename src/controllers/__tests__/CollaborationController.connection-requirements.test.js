const CollaborationController = require('../CollaborationController');
const db = require('../../config/db');

jest.mock('../../config/db');

describe('CollaborationController - Connection Requirements', () => {
  let req, res, mockSocketService;

  beforeEach(() => {
    mockSocketService = {
      notifyUser: jest.fn()
    };

    // Mock the socketService global variable
    global.socketService = mockSocketService;

    req = {
      body: {},
      params: {},
      query: {},
      user: { id: 'user-123', username: 'testuser', full_name: 'Test User' },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete global.socketService;
  });

  describe('addMemberToGroup - with connection requirement', () => {
    it('should reject adding non-connected user to group', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456', role: 'member' };

      // Mock group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-123' }] // User is owner
      });

      // Mock connection check - not connected
      db.query.mockResolvedValueOnce({ rows: [] });

      await CollaborationController.addMemberToGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'You can only add connected users to groups. Please send a connection request first.'
      });
    });

    it('should allow adding connected user to group', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456', role: 'member' };

      // Mock group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-123' }]
      });

      // Mock connection check - connected
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      });

      // Mock existing member check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock insert member
      db.query.mockResolvedValueOnce({
        rows: [{
          group_id: 'group-123',
          user_id: 'user-456',
          role: 'member'
        }]
      });

      await CollaborationController.addMemberToGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        user_id: 'user-456'
      }));
    });

    it('should reject if user is already a member', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456', role: 'member' };

      // Mock group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-123' }]
      });

      // Mock connection check - connected
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      });

      // Mock existing member check - already a member
      db.query.mockResolvedValueOnce({
        rows: [{ user_id: 'user-456' }]
      });

      await CollaborationController.addMemberToGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'User is already a member of this group'
      });
    });
  });

  describe('searchUsers - with connection filter', () => {
    it('should only return connected users', async () => {
      req.query = { q: 'john', limit: 10 };

      const mockConnectedUsers = [
        {
          id: 'user-456',
          username: 'johndoe',
          email: 'john@example.com',
          full_name: 'John Doe'
        }
      ];

      db.query.mockResolvedValueOnce({ rows: mockConnectedUsers });

      await CollaborationController.searchUsers(req, res);

      // Verify the query includes connection filter
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INNER JOIN connections c'),
        expect.arrayContaining(['user-123', '%john%'])
      );
      expect(res.json).toHaveBeenCalledWith(mockConnectedUsers);
    });

    it('should return empty array for short query', async () => {
      req.query = { q: 'j' }; // Too short

      await CollaborationController.searchUsers(req, res);

      expect(db.query).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith([]);
    });
  });

  describe('inviteUserToGroup', () => {
    it('should create group invitation for connected user', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456', role: 'member' };

      // Mock group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-123', name: 'Test Group' }]
      });

      // Mock connection check - connected
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      });

      // Mock existing member check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock existing invitation check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock create invitation
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'invitation-789',
          group_id: 'group-123',
          inviter_id: 'user-123',
          invitee_id: 'user-456',
          role: 'member'
        }]
      });

      await CollaborationController.inviteUserToGroup(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'user-456',
        'group:invitation',
        expect.objectContaining({
          invitation: expect.any(Object),
          group: expect.objectContaining({
            id: 'group-123',
            name: 'Test Group'
          })
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should reject invitation for non-connected user', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456' };

      // Mock group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-123', name: 'Test Group' }]
      });

      // Mock connection check - not connected
      db.query.mockResolvedValueOnce({ rows: [] });

      await CollaborationController.inviteUserToGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'You can only invite connected users to groups. Please send a connection request first.'
      });
    });

    it('should reject if not group owner', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456' };

      // Mock group owner check - not owner
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-999', name: 'Test Group' }]
      });

      await CollaborationController.inviteUserToGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Only the group owner can invite members'
      });
    });

    it('should reject if invitation already exists', async () => {
      req.params.groupId = 'group-123';
      req.body = { userId: 'user-456' };

      // Mock group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: 'user-123', name: 'Test Group' }]
      });

      // Mock connection check - connected
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      });

      // Mock existing member check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock existing invitation check - invitation exists
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'existing-invitation' }]
      });

      await CollaborationController.inviteUserToGroup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'An invitation has already been sent to this user'
      });
    });
  });

  describe('acceptGroupInvitation', () => {
    it('should accept group invitation and add user to group', async () => {
      req.params.invitationId = 'invitation-123';

      // Mock get invitation
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'invitation-123',
          group_id: 'group-123',
          inviter_id: 'user-456',
          invitee_id: 'user-123',
          role: 'member'
        }]
      });

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock update invitation
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock add to group
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await CollaborationController.acceptGroupInvitation(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'user-456',
        'group:invitation-accepted',
        expect.objectContaining({
          groupId: 'group-123',
          acceptedBy: expect.objectContaining({
            id: 'user-123'
          })
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Group invitation accepted'
      });
    });

    it('should fail if invitation not found', async () => {
      req.params.invitationId = 'invalid-invitation';

      // Mock get invitation - not found
      db.query.mockResolvedValueOnce({ rows: [] });

      await CollaborationController.acceptGroupInvitation(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invitation not found or already processed'
      });
    });
  });

  describe('declineGroupInvitation', () => {
    it('should decline group invitation', async () => {
      req.params.invitationId = 'invitation-123';

      // Mock update invitation
      db.query.mockResolvedValueOnce({
        rows: [{
          inviter_id: 'user-456',
          group_id: 'group-123'
        }]
      });

      await CollaborationController.declineGroupInvitation(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'user-456',
        'group:invitation-declined',
        expect.objectContaining({
          groupId: 'group-123',
          declinedBy: expect.objectContaining({
            id: 'user-123'
          })
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Group invitation declined'
      });
    });
  });

  describe('getPendingGroupInvitations', () => {
    it('should return pending group invitations for user', async () => {
      const mockInvitations = [
        {
          id: 'inv-1',
          group_id: 'group-123',
          group_name: 'Test Group',
          inviter_username: 'inviter1',
          role: 'member'
        },
        {
          id: 'inv-2',
          group_id: 'group-456',
          group_name: 'Another Group',
          inviter_username: 'inviter2',
          role: 'admin'
        }
      ];

      db.query.mockResolvedValueOnce({ rows: mockInvitations });

      await CollaborationController.getPendingGroupInvitations(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('gi.invitee_id = $1'),
        ['user-123']
      );
      expect(res.json).toHaveBeenCalledWith(mockInvitations);
    });
  });
});