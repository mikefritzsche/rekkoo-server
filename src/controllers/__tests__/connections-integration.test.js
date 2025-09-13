/**
 * Integration tests for the complete connection system flow
 * Tests the interaction between connections and collaboration features
 */

const connectionsControllerFactory = require('../ConnectionsController');
const CollaborationController = require('../CollaborationController');
const db = require('../../config/db');

jest.mock('../../config/db');

describe('Connections System - Integration Tests', () => {
  let mockSocketService;
  let connectionsController;

  beforeEach(() => {
    mockSocketService = {
      notifyUser: jest.fn()
    };

    connectionsController = connectionsControllerFactory(mockSocketService);
    global.socketService = mockSocketService;

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete global.socketService;
  });

  describe('Complete Connection and Group Flow', () => {
    it('should handle full connection to group member flow', async () => {
      // Step 1: User A sends connection request to User B
      const userA = { id: 'user-a', username: 'alice', full_name: 'Alice' };
      const userB = { id: 'user-b', username: 'bob', full_name: 'Bob' };

      const connectionReq = {
        user: userA,
        body: { recipientId: userB.id, message: 'Let\'s connect!' }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      // Mock for sendConnectionRequest
      db.query.mockResolvedValueOnce({ rows: [{ allow_connection_requests: true }] }); // privacy check
      db.query.mockResolvedValueOnce({ rows: [] }); // no existing connection
      db.query.mockResolvedValueOnce({ rows: [] }); // no existing invitation
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'inv-1', sender_id: userA.id, recipient_id: userB.id }]
      }); // create invitation
      db.query.mockResolvedValueOnce({ rows: [] }); // create connection 1
      db.query.mockResolvedValueOnce({ rows: [] }); // create connection 2
      db.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      await connectionsController.sendConnectionRequest(connectionReq, res);
      expect(res.status).toHaveBeenCalledWith(201);

      // Step 2: User B accepts the connection request
      const acceptReq = {
        user: userB,
        params: { requestId: 'inv-1' }
      };

      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      db.query.mockResolvedValueOnce({ rows: [{ sender_id: userA.id }] }); // update invitation
      db.query.mockResolvedValueOnce({ rows: [] }); // update connections
      db.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      res.status.mockClear();
      res.json.mockClear();

      await connectionsController.acceptRequest(acceptReq, res);
      expect(res.json).toHaveBeenCalledWith({ message: 'Connection request accepted' });

      // Step 3: User A creates a group
      const createGroupReq = {
        user: userA,
        body: { name: 'Test Group', description: 'A test group' }
      };

      db.query.mockResolvedValueOnce({
        rows: [{ id: 'group-1', name: 'Test Group', owner_id: userA.id }]
      });

      res.status.mockClear();
      res.json.mockClear();

      await CollaborationController.createGroup(createGroupReq, res);
      expect(res.status).toHaveBeenCalledWith(201);

      // Step 4: User A invites User B to the group (should succeed - they're connected)
      const inviteReq = {
        user: userA,
        params: { groupId: 'group-1' },
        body: { userId: userB.id, role: 'member' }
      };

      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: userA.id, name: 'Test Group' }]
      }); // group owner check
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      }); // connection check - CONNECTED!
      db.query.mockResolvedValueOnce({ rows: [] }); // not already a member
      db.query.mockResolvedValueOnce({ rows: [] }); // no existing invitation
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'group-inv-1', group_id: 'group-1', invitee_id: userB.id }]
      }); // create invitation

      res.status.mockClear();
      res.json.mockClear();

      await CollaborationController.inviteUserToGroup(inviteReq, res);
      expect(res.status).toHaveBeenCalledWith(201);

      // Step 5: User B accepts the group invitation
      const acceptGroupReq = {
        user: userB,
        params: { invitationId: 'group-inv-1' }
      };

      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'group-inv-1',
          group_id: 'group-1',
          inviter_id: userA.id,
          invitee_id: userB.id,
          role: 'member'
        }]
      }); // get invitation
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      db.query.mockResolvedValueOnce({ rows: [] }); // update invitation
      db.query.mockResolvedValueOnce({ rows: [] }); // add to group
      db.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      res.json.mockClear();

      await CollaborationController.acceptGroupInvitation(acceptGroupReq, res);
      expect(res.json).toHaveBeenCalledWith({ message: 'Group invitation accepted' });
    });

    it('should prevent group invitation without connection', async () => {
      const userA = { id: 'user-a', username: 'alice' };
      const userC = { id: 'user-c', username: 'charlie' };

      // User A tries to invite User C (not connected) to a group
      const inviteReq = {
        user: userA,
        params: { groupId: 'group-1' },
        body: { userId: userC.id, role: 'member' }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      db.query.mockResolvedValueOnce({
        rows: [{ owner_id: userA.id, name: 'Test Group' }]
      }); // group owner check
      db.query.mockResolvedValueOnce({ rows: [] }); // connection check - NOT CONNECTED!

      await CollaborationController.inviteUserToGroup(inviteReq, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'You can only invite connected users to groups. Please send a connection request first.'
      });
    });
  });

  describe('Connection Removal and Cascade Deletion', () => {
    it('should remove user from groups when connection is removed', async () => {
      const userA = { id: 'user-a', username: 'alice' };
      const userB = { id: 'user-b', username: 'bob' };

      const removeReq = {
        user: userA,
        params: { connectionId: userB.id }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      // Mock the removal process
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      db.query.mockResolvedValueOnce({
        rows: [{ connection_id: userB.id }]
      }); // soft delete connections
      db.query.mockResolvedValueOnce({
        rows: [
          { group_id: 'group-1', name: 'Group 1' },
          { group_id: 'group-2', name: 'Group 2' }
        ]
      }); // get groups to notify
      db.query.mockResolvedValueOnce({ rows: [] }); // remove from groups
      db.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      await connectionsController.removeConnection(removeReq, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        userB.id,
        'connection:removed',
        expect.objectContaining({
          removedFromGroups: expect.arrayContaining([
            expect.objectContaining({ group_id: 'group-1' }),
            expect.objectContaining({ group_id: 'group-2' })
          ])
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Connection removed successfully'
      });
    });
  });

  describe('Privacy Settings Impact', () => {
    it('should respect privacy settings in search', async () => {
      const searchReq = {
        user: { id: 'user-a' },
        query: { query: 'test', searchBy: 'username' }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      // Mock users with different privacy settings
      const mockResults = [
        {
          id: 'user-public',
          username: 'testpublic',
          privacy_mode: 'public' // Should be visible
        },
        {
          id: 'user-standard',
          username: 'teststandard',
          privacy_mode: 'standard',
          searchable_by_username: true // Should be visible
        }
        // user-private with privacy_mode: 'private' won't be returned
      ];

      db.query.mockResolvedValueOnce({ rows: mockResults });

      await connectionsController.searchUsers(searchReq, res);

      expect(res.json).toHaveBeenCalledWith(mockResults);
    });

    it('should prevent connection request when disabled', async () => {
      const req = {
        user: { id: 'user-a' },
        body: { recipientId: 'user-private' }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      // Mock recipient with connection requests disabled
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'user-private',
          allow_connection_requests: false
        }]
      });

      await connectionsController.sendConnectionRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'User has disabled connection requests'
      });
    });
  });

  describe('Collaboration Search Filter', () => {
    it('should only return connected users in collaboration search', async () => {
      const req = {
        user: { id: 'user-a' },
        query: { q: 'test' }
      };
      const res = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      };

      const connectedUsers = [
        { id: 'user-b', username: 'testuser1' },
        { id: 'user-c', username: 'testuser2' }
      ];

      db.query.mockResolvedValueOnce({ rows: connectedUsers });

      await CollaborationController.searchUsers(req, res);

      // Verify the query includes connection join
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INNER JOIN connections c'),
        expect.arrayContaining(['user-a', '%test%'])
      );
      expect(res.json).toHaveBeenCalledWith(connectedUsers);
    });
  });
});