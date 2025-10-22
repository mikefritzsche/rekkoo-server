// socket-service.js
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

class SocketService {
  constructor(server) {
    // Determine allowed origins based on environment
    let allowedOrigins;
    
    if (process.env.NODE_ENV === 'production') {
      allowedOrigins = '*' // (process.env.SOCKET_CORS_ORIGINS || 'https://app.rekkoo.com').split(',').map(origin => origin.trim());
    } else {
      // Development mode - be more permissive
      const devOrigins = '*' // process.env.SOCKET_CORS_ORIGINS_DEV || 'http://localhost:8081,http://localhost:3000,http://localhost:19006';
      if (devOrigins === '*') {
        allowedOrigins = true; // Allow all origins in dev if * is specified
      } else {
        allowedOrigins = devOrigins.split(',').map(origin => origin.trim());
        // Always add common development URLs
        if (!allowedOrigins.includes('http://localhost:8081')) {
          allowedOrigins.push('http://localhost:8081');
        }
        if (!allowedOrigins.includes('http://localhost:3000')) {
          allowedOrigins.push('http://localhost:3000');
        }
        if (!allowedOrigins.includes('http://localhost:19006')) {
          allowedOrigins.push('http://localhost:19006');
        }
      }
    }

    console.log(`SocketService: NODE_ENV=${process.env.NODE_ENV}`);
    console.log(`SocketService: Allowed CORS Origins:`, allowedOrigins);

    this.io = socketIo(server, {
      cors: {
        origin: allowedOrigins, // Use the dynamic list or true for all
        methods: ["GET", "POST"],
        credentials: true // Enable credentials for auth
      }
    });

    // --- Authentication Middleware ---
    this.io.use(async (socket, next) => {
      let token = socket.handshake.auth.token;
      if (!token) {
        console.error('Socket connection failed: No token provided.');
        return next(new Error('Authentication error: No token'));
      }

      // Remove 'Bearer ' prefix if present
      if (token.startsWith('Bearer ')) {
        token = token.substring(7);
        console.log('[SocketService] Stripped Bearer prefix from token');
      }

      console.log('[SocketService] Attempting authentication with token (first 20 chars):', token.substring(0, 20) + '...');

      try {
        // First try JWT verification
        let userId = null;
        let userInfo = null;
        
        // Check if it's a JWT token (they typically have 3 parts separated by dots)
        if (token.includes('.') && token.split('.').length === 3) {
          console.log('[SocketService] Token appears to be JWT, attempting JWT verification...');
          try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            console.log('[SocketService] JWT decoded successfully:', { userId: decoded.id || decoded.userId });
            
            // Get user info from database using the decoded user ID
            const userResult = await db.query(
              `SELECT id, username, email, email_verified
               FROM users
               WHERE id = $1 AND account_locked = false`,
              [decoded.id || decoded.userId || decoded.sub]
            );
            
            if (userResult.rows.length > 0) {
              userInfo = userResult.rows[0];
              userId = userInfo.id;
              console.log('[SocketService] User found via JWT:', userId);
            }
          } catch (jwtError) {
            console.error('[SocketService] JWT verification failed:', jwtError.message);
          }
        }
        
        // If JWT didn't work, try session token lookup
        if (!userId) {
          console.log('[SocketService] Trying session token lookup...');
          const sessionResult = await db.query(
             `SELECT u.id, u.username, u.email, u.email_verified
              FROM user_sessions s
              JOIN users u ON s.user_id = u.id
              WHERE s.token = $1
                AND s.expires_at > NOW()
                AND s.deleted_at IS NULL
                AND u.account_locked = false`,
            [token]
          );

          if (sessionResult.rows.length > 0) {
            userInfo = sessionResult.rows[0];
            userId = userInfo.id;
            console.log('[SocketService] User found via session token:', userId);
          }
        }

        if (!userId || !userInfo) {
          console.error('Socket connection failed: Invalid or expired token');
          return next(new Error('Authentication error: Invalid session'));
        }

        // Attach user to socket
        socket.user = {
          id: userInfo.id,
          username: userInfo.username,
          email: userInfo.email
        };

        console.log(`Socket authenticated for user: ${socket.user.id}`);
        next();
      } catch (err) {
        console.error('Socket connection failed:', err);
        next(new Error('Authentication error: Invalid token'));
      }
    });

    this.setupSocketHandlers();
  }

  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      // Access user via socket.user here
      console.log(`Client connected: socket ID ${socket.id}, user ID ${socket.user?.id}`);

      // Automatically join user-specific room (Recommended)
      if (socket.user && socket.user.id) {
        const userRoom = `user_${socket.user.id}`;
        socket.join(userRoom);
        console.log(`Socket ${socket.id} joined room ${userRoom}`);
      }

      // --- Align Event Listeners ---
      // Client emits 'sync:change'
      socket.on('sync:change', (change) => { // <<< Match client emit name
        // Ensure user is authorized for this change
        if (socket.user && change.userId && `user_${socket.user.id}` === `user_${change.userId}`) {
          const targetRoom = `user_${change.userId}`;
          console.log(`Processing 'sync:change' for user ${change.userId} from socket ${socket.id}`);
          // Process change...
          // Optionally broadcast back (e.g., io.to(targetRoom).emit(...)) if needed,
          // but usually push triggers pull on other clients via 'sync_update_available'
        } else {
          console.warn(`Unauthorized 'sync:change' event from socket ${socket.id} for user ${change.userId}`);
          socket.emit('sync_error', { message: 'Unauthorized change' });
        }
      });

      // Client emits 'join:room' (Might be unnecessary if auto-joining on connect)
      socket.on('join:room', (roomId) => { // <<< Match client emit name
        // Add validation: Does socket.user.id match the user part of the room ID?
        // e.g., if roomId is 'user_123', check socket.user.id === '123'
        console.log(`Socket ${socket.id} requested to join room: ${roomId}`);
        socket.join(roomId); // Be careful with allowing arbitrary room joins
      });

      // Client emits 'leave:room'
      socket.on('leave:room', (roomId) => { // <<< Match client emit name
        console.log(`Socket ${socket.id} leaving room: ${roomId}`);
        socket.leave(roomId);
      });

      socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: socket ID ${socket.id}, user ID ${socket.user?.id}. Reason: ${reason}`);
      });

      socket.on('error', (err) => {
        console.error(`Socket Error on ${socket.id}:`, err);
      });

      // Handle ping events
      socket.on('ping', (data) => {
        console.log(`Received ping from socket ${socket.id}, user ${socket.user?.id}`);
        socket.emit('pong', { 
          timestamp: new Date().toISOString(),
          message: 'Pong response from server'
        });
      });

      // Handle list privacy updates
      socket.on('list_privacy_update', async (data) => {
        
        if (!socket.user || !data.listId) {
          console.error(`[SocketService] Invalid request - user: ${socket.user?.id}, listId: ${data.listId}`);
          socket.emit('error', { message: 'Invalid privacy update request' });
          return;
        }

        try {
          // First verify that the user owns this list
          const ownerCheckQuery = `
            SELECT owner_id, is_public 
            FROM lists 
            WHERE id = $1 AND deleted_at IS NULL
          `;
          const { rows: listRows } = await db.query(ownerCheckQuery, [data.listId]);
          
          if (listRows.length === 0) {
            console.log(`[SocketService] List ${data.listId} not found`);
            socket.emit('error', { message: 'List not found' });
            return;
          }
          
          const list = listRows[0];
          if (list.owner_id !== socket.user.id) {
            console.log(`[SocketService] User ${socket.user.id} is not the owner of list ${data.listId}`);
            socket.emit('error', { message: 'Unauthorized: Only list owner can change privacy' });
            return;
          }
          
          console.log(`[SocketService] Privacy update authorized for list ${data.listId}. New access_type: ${data.access_type}`);
          
          // Update the database with the new privacy setting
          const isPublic = data.access_type === 'public';
          const updateQuery = `
            UPDATE lists 
            SET is_public = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2 AND deleted_at IS NULL
          `;
          await db.query(updateQuery, [isPublic, data.listId]);
          console.log(`[SocketService] Updated list ${data.listId} is_public to ${isPublic} in database`);
          
          // Get all users who might need to be notified
          // This includes:
          // 1. All users currently viewing the owner's profile
          // 2. Group members who have access to the list
          // 3. Users the list is shared with
          
          // For now, broadcast to all connected users except the sender
          // In a production system, you'd want to be more selective
          const rooms = this.io.sockets.adapter.rooms;
          const notifiedUsers = new Set();
          
          // Notify all connected users (except sender) about the privacy change
          console.log(`[SocketService] Total connected sockets: ${this.io.sockets.sockets.size}`);
          
          for (const [socketId, socket] of this.io.sockets.sockets) {
            console.log(`[SocketService] Checking socket ${socketId}, user: ${socket.user?.id}`);
            
            if (socket.user && socket.user.id !== data.updatedBy) {
              const userRoom = `user_${socket.user.id}`;
              
              // Check if user room exists and has members
              const roomSockets = this.io.sockets.adapter.rooms.get(userRoom);
              const roomSize = roomSockets ? roomSockets.size : 0;
              console.log(`[SocketService] User room ${userRoom} has ${roomSize} sockets`);
              
              if (!notifiedUsers.has(socket.user.id)) {
                console.log(`[SocketService] >>> NOTIFYING user ${socket.user.id} about privacy change for list ${data.listId}`);
                
                const notificationData = {
                  listId: data.listId,
                  updatedBy: data.updatedBy,
                  access_type: data.access_type,
                  previousAccessType: data.previousAccessType,
                  timestamp: data.timestamp || Date.now()
                };
                
                console.log(`[SocketService] Notification data:`, JSON.stringify(notificationData));
                this.io.to(userRoom).emit('list_privacy_update', notificationData);
                notifiedUsers.add(socket.user.id);
              }
            } else if (socket.user && socket.user.id === data.updatedBy) {
              console.log(`[SocketService] Skipping sender ${socket.user.id}`);
            }
          }
          
          console.log(`[SocketService] Notified ${notifiedUsers.size} users about privacy change for list ${data.listId}`);
          
          // Send confirmation to the sender
          socket.emit('privacy_update_sent', { 
            message: `Privacy update sent to ${notifiedUsers.size} users`,
            userCount: notifiedUsers.size 
          });
          
        } catch (error) {
          console.error('[SocketService] Error handling privacy update:', error);
          socket.emit('error', { message: 'Failed to process privacy update' });
        }
      });

      // Handle test group notification
      socket.on('test_group_notification', async (data) => {
        console.log(`[SocketService] Received test_group_notification from user ${socket.user?.id} for list ${data.listId}`);
        
        if (!socket.user || !data.listId) {
          socket.emit('error', { message: 'Invalid test request' });
          return;
        }

        try {
          // Get all group members for this list (similar to SyncController logic)
          const groupMembersQuery = `
            SELECT DISTINCT cgm.user_id
            FROM list_group_roles lgr
            JOIN collaboration_group_members cgm ON lgr.group_id = cgm.group_id
            WHERE lgr.list_id = $1 
              AND lgr.deleted_at IS NULL
              AND cgm.deleted_at IS NULL
              AND cgm.user_id != $2
            UNION
            SELECT DISTINCT cg.owner_id as user_id
            FROM list_group_roles lgr
            JOIN collaboration_groups cg ON lgr.group_id = cg.id
            WHERE lgr.list_id = $1 
              AND lgr.deleted_at IS NULL
              AND cg.deleted_at IS NULL
              AND cg.owner_id != $2
            UNION
            SELECT DISTINCT cgm.user_id
            FROM list_sharing ls
            JOIN collaboration_group_members cgm ON ls.shared_with_group_id = cgm.group_id
            WHERE ls.list_id = $1 
              AND ls.deleted_at IS NULL
              AND cgm.deleted_at IS NULL
              AND cgm.user_id != $2
            UNION
            SELECT DISTINCT cg.owner_id as user_id
            FROM list_sharing ls
            JOIN collaboration_groups cg ON ls.shared_with_group_id = cg.id
            WHERE ls.list_id = $1 
              AND ls.deleted_at IS NULL
              AND cg.deleted_at IS NULL
              AND cg.owner_id != $2
          `;
          
          const { rows: members } = await db.query(groupMembersQuery, [data.listId, socket.user.id]);
          
          console.log(`[SocketService] Found ${members.length} group members for list ${data.listId}`);
          
          // Send test notification to each member
          for (const member of members) {
            const userRoom = `user_${member.user_id}`;
            console.log(`[SocketService] Sending test notification to room ${userRoom}`);
            
            // Check if room exists
            const roomClients = this.io.sockets.adapter.rooms.get(userRoom);
            const clientCount = roomClients ? roomClients.size : 0;
            console.log(`[SocketService] Room ${userRoom} has ${clientCount} connected client(s)`);
            
            this.io.to(userRoom).emit('websocket_test', {
              message: `Test notification from user ${socket.user.id}`,
              listId: data.listId,
              timestamp: Date.now(),
              fromUserId: socket.user.id
            });
          }
          
          // Send confirmation to the sender
          socket.emit('test_sent', { 
            message: `Test sent to ${members.length} group members`,
            memberCount: members.length 
          });
          
        } catch (error) {
          console.error('[SocketService] Error sending test notifications:', error);
          socket.emit('error', { message: 'Failed to send test notifications' });
        }
      });
    });

    this.io.on('connection', (socket) => {
      socket.on('join:gift-list', ({ listId }) => {
        if (!listId) return;
        const room = `gift_list_${listId}`;
        socket.join(room);
      });

      socket.on('leave:gift-list', ({ listId }) => {
        if (!listId) return;
        const room = `gift_list_${listId}`;
        socket.leave(room);
      });
    });
  }

  // Emit to specific user room
  notifyUser(userId, event, data) {
    console.log(`SocketService: notifyUser called for userId: ${userId}, event: ${event}. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
    const userRoom = `user_${userId}`;
    // Log before emitting
    const roomClients = this.io.sockets.adapter.rooms.get(userRoom);
    const clientCount = roomClients ? roomClients.size : 0;
    console.log(`SocketService: Attempting to emit (notifyUser) '${event}' to room '${userRoom}' (${clientCount} client(s) expected). Data:`, data, `Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
    
    this.io.to(userRoom).emit(event, data);

    const listId = data?.listId || data?.data?.listId || data?.data?.list_id;
    if (listId) {
      const listRoom = `gift_list_${listId}`;
      this.io.to(listRoom).emit(event, data);
    }
    console.log(`SocketService: Emission for '${event}' to room '${userRoom}' completed. Timestamp: ${Date.now()}`); // DEBUG TIMESTAMP
  }

}

module.exports = SocketService;
