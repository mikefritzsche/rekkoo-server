const connectionsControllerFactory = require('../ConnectionsController');
const db = require('../../config/db');

jest.mock('../../config/db');

describe('ConnectionsController', () => {
  let req, res, connectionsController, mockSocketService;

  beforeEach(() => {
    mockSocketService = {
      notifyUser: jest.fn()
    };

    connectionsController = connectionsControllerFactory(mockSocketService);

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

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe('sendConnectionRequest', () => {
    it('should send a connection request successfully', async () => {
      req.body = { recipientId: 'recipient-456', message: 'Let\'s connect!' };

      const mockInvitation = {
        id: 'invitation-789',
        sender_id: 'user-123',
        recipient_id: 'recipient-456',
        message: 'Let\'s connect!'
      };

      // Mock recipient privacy settings
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'recipient-456',
          allow_connection_requests: true
        }]
      });

      // Mock existing connection check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock existing invitation check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock invitation creation - returns the created invitation
      db.query.mockResolvedValueOnce({
        rows: [mockInvitation]
      });

      // Mock connection creation (both records)
      db.query.mockResolvedValueOnce({ rows: [] });
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.sendConnectionRequest(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'recipient-456',
        'connection:request',
        expect.objectContaining({
          invitation: mockInvitation,
          sender: expect.objectContaining({
            id: 'user-123',
            username: 'testuser'
          })
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(mockInvitation);
    });

    it('should fail if recipient does not allow connection requests', async () => {
      req.body = { recipientId: 'recipient-456' };

      // Mock recipient privacy settings - not allowing requests
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'recipient-456',
          allow_connection_requests: false
        }]
      });

      await connectionsController.sendConnectionRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'User has disabled connection requests'
      });
    });

    it('should fail if already connected', async () => {
      req.body = { recipientId: 'recipient-456' };

      // Mock recipient privacy settings
      db.query.mockResolvedValueOnce({
        rows: [{ allow_connection_requests: true }]
      });

      // Mock existing connection - already connected
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      });

      await connectionsController.sendConnectionRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Already connected or pending'
      });
    });
  });

  describe('acceptRequest', () => {
    it('should accept a connection request successfully', async () => {
      req.params = { requestId: 'invitation-123' };

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock invitation update
      db.query.mockResolvedValueOnce({
        rows: [{ sender_id: 'sender-456' }]
      });

      // Mock connection status updates
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.acceptRequest(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'sender-456',
        'connection:accepted',
        expect.objectContaining({
          acceptedBy: expect.objectContaining({
            id: 'user-123',
            username: 'testuser'
          })
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Connection request accepted'
      });
    });

    it('should fail if invitation not found', async () => {
      req.params = { requestId: 'invalid-invitation' };

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock invitation update - no rows returned
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock ROLLBACK
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.acceptRequest(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invitation not found or already processed'
      });
    });
  });

  describe('getConnections', () => {
    it('should return list of connections', async () => {
      const mockConnections = [
        {
          id: 'conn-1',
          connection_id: 'user-456',
          username: 'friend1',
          email: 'friend1@example.com',
          status: 'accepted'
        },
        {
          id: 'conn-2',
          connection_id: 'user-789',
          username: 'friend2',
          email: 'friend2@example.com',
          status: 'accepted'
        }
      ];

      db.query.mockResolvedValueOnce({ rows: mockConnections });

      await connectionsController.getConnections(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT c.*, u.username'),
        ['user-123']
      );
      expect(res.json).toHaveBeenCalledWith(mockConnections);
    });
  });

  describe('removeConnection', () => {
    it('should remove a connection and cascade delete group memberships', async () => {
      req.params = { connectionId: 'user-456' };

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock soft delete connections
      db.query.mockResolvedValueOnce({ rows: [{ connection_id: 'user-456' }] });

      // Mock get groups to notify
      db.query.mockResolvedValueOnce({
        rows: [
          { group_id: 'group-1', name: 'Group 1' },
          { group_id: 'group-2', name: 'Group 2' }
        ]
      });

      // Mock remove from groups
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.removeConnection(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'user-456',
        'connection:removed',
        expect.objectContaining({
          removedBy: expect.objectContaining({
            id: 'user-123',
            username: 'testuser'
          }),
          removedFromGroups: expect.arrayContaining([
            expect.objectContaining({ group_id: 'group-1' })
          ])
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Connection removed successfully'
      });
    });
  });

  describe('searchUsers', () => {
    it('should search users respecting privacy settings', async () => {
      req.query = { query: 'john', searchBy: 'username' };

      const mockUsers = [
        {
          id: 'user-456',
          username: 'johndoe',
          email: 'john@example.com',
          isConnected: false,
          hasPendingRequest: false
        }
      ];

      db.query.mockResolvedValueOnce({ rows: mockUsers });

      await connectionsController.searchUsers(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('privacy_mode'),
        expect.arrayContaining(['%john%', 'user-123'])
      );
      expect(res.json).toHaveBeenCalledWith(mockUsers);
    });

    it('should return 400 if search query is missing', async () => {
      req.query = {};

      await connectionsController.searchUsers(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Search query is required'
      });
    });
  });

  describe('getPrivacySettings', () => {
    it('should return user privacy settings', async () => {
      const mockSettings = {
        user_id: 'user-123',
        privacy_mode: 'standard',
        searchable_by_username: true,
        allow_connection_requests: true
      };

      db.query.mockResolvedValueOnce({ rows: [mockSettings] });

      await connectionsController.getPrivacySettings(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM user_privacy_settings'),
        ['user-123']
      );
      expect(res.json).toHaveBeenCalledWith(mockSettings);
    });

    it('should return default settings if none exist', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock insert default settings
      db.query.mockResolvedValueOnce({
        rows: [{
          user_id: 'user-123',
          privacy_mode: 'standard',
          searchable_by_username: true,
          allow_connection_requests: true
        }]
      });

      await connectionsController.getPrivacySettings(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        privacy_mode: 'standard'
      }));
    });
  });

  describe('updatePrivacySettings', () => {
    it('should update privacy settings successfully', async () => {
      req.body = {
        privacy_mode: 'private',
        searchable_by_username: false,
        allow_connection_requests: false
      };

      const updatedSettings = {
        user_id: 'user-123',
        ...req.body
      };

      db.query.mockResolvedValueOnce({ rows: [updatedSettings] });

      await connectionsController.updatePrivacySettings(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_privacy_settings'),
        expect.arrayContaining(['user-123', 'private', false, false])
      );
      expect(res.json).toHaveBeenCalledWith(updatedSettings);
    });
  });

  describe('checkConnectionStatus', () => {
    it('should return connection status between users', async () => {
      req.params = { targetUserId: 'user-456' };

      // Mock connection check
      db.query.mockResolvedValueOnce({
        rows: [{ status: 'accepted' }]
      });

      // Mock sent invitation check
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock received invitation check
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.checkConnectionStatus(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          isConnected: true,
          connectionStatus: 'accepted',
          hasSentRequest: false,
          hasReceivedRequest: false
        })
      );
    });

    it('should show pending invitations', async () => {
      req.params = { targetUserId: 'user-456' };

      // Mock no connection
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock sent invitation
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 'inv-1',
          status: 'pending',
          message: 'Let\'s connect!'
        }]
      });

      // Mock no received invitation
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.checkConnectionStatus(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          isConnected: false,
          hasSentRequest: true,
          hasReceivedRequest: false,
          sentInvitation: expect.objectContaining({
            id: 'inv-1'
          })
        })
      );
    });
  });

  describe('cancelRequest', () => {
    it('should cancel a sent connection request', async () => {
      req.params = { requestId: 'invitation-123' };

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock invitation update
      db.query.mockResolvedValueOnce({
        rows: [{ recipient_id: 'recipient-456' }]
      });

      // Mock delete pending connections
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.cancelRequest(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'recipient-456',
        'connection:cancelled',
        expect.objectContaining({
          cancelledBy: expect.objectContaining({
            id: 'user-123',
            username: 'testuser'
          })
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Connection request cancelled'
      });
    });
  });

  describe('declineRequest', () => {
    it('should decline a connection request', async () => {
      req.params = { requestId: 'invitation-123' };

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock invitation update
      db.query.mockResolvedValueOnce({
        rows: [{ sender_id: 'sender-456' }]
      });

      // Mock delete pending connections
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.declineRequest(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'sender-456',
        'connection:declined',
        expect.objectContaining({
          declinedBy: expect.objectContaining({
            id: 'user-123',
            username: 'testuser'
          })
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'Connection request declined'
      });
    });
  });

  describe('blockUser', () => {
    it('should block a user successfully', async () => {
      req.params = { userIdToBlock: 'user-456' };

      // Mock transaction
      db.query.mockResolvedValueOnce({ rows: [] }); // BEGIN

      // Mock remove existing connections
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock cancel pending invitations
      db.query.mockResolvedValueOnce({ rows: [] });
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock insert block record
      db.query.mockResolvedValueOnce({ rows: [] });
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock get groups to remove from
      db.query.mockResolvedValueOnce({
        rows: [{ group_id: 'group-1', name: 'Group 1' }]
      });

      // Mock remove from groups
      db.query.mockResolvedValueOnce({ rows: [] });

      // Mock COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      await connectionsController.blockUser(req, res);

      expect(mockSocketService.notifyUser).toHaveBeenCalledWith(
        'user-456',
        'connection:blocked',
        expect.objectContaining({
          blockedBy: expect.objectContaining({
            id: 'user-123'
          })
        })
      );
      expect(res.json).toHaveBeenCalledWith({
        message: 'User blocked successfully'
      });
    });
  });
});