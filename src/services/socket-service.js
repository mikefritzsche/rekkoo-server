// socket-service.js
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken'); // Or your auth mechanism

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
    this.io.use((socket, next) => {
      const token = socket.handshake.auth.token;
      if (!token) {
        console.error('Socket connection failed: No token provided.');
        return next(new Error('Authentication error: No token'));
      }
      try {
        // Replace with your actual token verification logic
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = decoded; // Attach user info
        console.log(`Socket authenticated for user: ${socket.user.id}`);
        next();
      } catch (err) {
        console.error('Socket connection failed: Invalid token.');
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
    });
  }

  // Emit to specific user room
  emitToUser(userId, event, data) {
    const userRoom = `user_${userId}`;
    this.io.to(userRoom).emit(event, data);
  }

}

module.exports = SocketService;