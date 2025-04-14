// socket-service.js
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken'); // Or your auth mechanism
const db = require('../config/db');

class SocketService {
  constructor(server) {
    // const io = require('socket.io')(3000, { // or other port
    //   cors: {
    //     origin: "*", // Adjust for production
    //     methods: ["GET", "POST"]
    //   }
    // });
    this.io = socketIo(server, { // <--- Add options object here
      cors: {
        // IMPORTANT: Restrict origin in production!
        origin: "*", // Or ['http://localhost:xxxx', 'exp://...', 'https://your-app-domain.com']
        methods: ["GET", "POST"],
        // credentials: true // If you need cookies/auth headers beyond the handshake auth
      }
    });

    // --- Authentication Middleware ---
    this.io.use(async (socket, next) => {
      const token = socket.handshake.auth.token;
      if (!token) {
        console.error('Socket connection failed: No token provided.');
        return next(new Error('Authentication error: No token'));
      }

      try {
        // Verify token and check session against database
        const sessionResult = await db.query(
          `SELECT u.id, u.username, u.email, u.email_verified
           FROM user_sessions s
           JOIN users u ON s.user_id = u.id
           WHERE s.token = $1
             AND s.expires_at > NOW()
             AND u.account_locked = false`,
          [token]
        );

        if (sessionResult.rows.length === 0) {
          console.error('Socket connection failed: Invalid or expired session');
          return next(new Error('Authentication error: Invalid session'));
        }

        // Attach user to socket
        socket.user = {
          id: sessionResult.rows[0].id,
          username: sessionResult.rows[0].username,
          email: sessionResult.rows[0].email
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
    });
  }

  // Emit to specific user room
  emitToUser(userId, event, data) {
    const userRoom = `user_${userId}`;
    this.io.to(userRoom).emit(event, data);
  }

}

module.exports = SocketService;
