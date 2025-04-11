// socket-service.js
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken'); // Or your auth mechanism

class SocketService {
  constructor(server) {
    this.io = socketIo(server, {
      cors: {
        // IMPORTANT: Restrict origin in production!
        origin: ['http://localhost:3000', 'https://app.rekkoo.com', '*'], // Mobile app origin should be specified for production
        methods: ["GET", "POST"],
        // credentials: true // If you need cookies/auth headers beyond the handshake auth
      },
      path: '/socket.io',
      transports: ['polling', 'websocket']
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
        // Check for the correct 'userId' claim based on the decoded token
        if (!decoded.userId) {
          console.error('Socket connection failed: JWT token missing "userId" claim.');
          return next(new Error('Authentication error: Invalid token payload'));
        }
        socket.user = decoded; // Attach the full decoded payload
        // Log using the 'userId' claim
        console.log(`Socket authenticated for user: ${socket.user.userId}`);
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
      // Log using the 'userId' claim
      console.log(`Client connected: socket ID ${socket.id}, user ID ${socket.user?.userId}`);

      // Automatically join user-specific room (Recommended)
      // Use socket.user.userId for the user ID
      if (socket.user && socket.user.userId) {
        const userRoom = `user_${socket.user.userId}`;
        socket.join(userRoom);
        console.log(`Socket ${socket.id} joined room ${userRoom}`);
      }

      // --- Align Event Listeners ---
      // Client emits 'sync:change'
      socket.on('sync:change', (change) => { // <<< Match client emit name
        // Ensure user is authorized for this change
        // Use socket.user.userId for the user ID check
        if (socket.user && socket.user.userId && change.userId && `user_${socket.user.userId}` === `user_${change.userId}`) {
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
        // Add validation: Does socket.user.userId match the user part of the room ID?
        // e.g., if roomId is 'user_123', check socket.user.userId === '123'
        console.log(`Socket ${socket.id} requested to join room: ${roomId}`);
        // Add validation here before joining arbitrary rooms if needed
        socket.join(roomId); // Be careful with allowing arbitrary room joins
      });

      // Client emits 'leave:room'
      socket.on('leave:room', (roomId) => { // <<< Match client emit name
        console.log(`Socket ${socket.id} leaving room: ${roomId}`);
        socket.leave(roomId);
      });

      socket.on('disconnect', (reason) => {
        // Log using the 'userId' claim
        console.log(`Client disconnected: socket ID ${socket.id}, user ID ${socket.user?.userId}. Reason: ${reason}`);
      });

      socket.on('error', (err) => {
        console.error(`Socket Error on ${socket.id}:`, err);
      });

      // --- Test Ping/Pong ---
      socket.on('ping', (data) => {
        const userId = socket.user?.userId || 'Unknown User';
        console.log(`Received 'ping' from user ${userId} (socket ${socket.id}). Data:`, data || '(No data)');
        const pongData = { message: 'Pong from server!', timestamp: Date.now() };
        // Emit 'pong' back to the specific client who sent 'ping'
        socket.emit('pong', pongData);
        // Add log to confirm emission attempt
        console.log(`Emitted 'pong' back to user ${userId} (socket ${socket.id}). Data:`, pongData);
      });
      // --- End Test ---
    });
  }

  // Emit to specific user room
  emitToUser(userId, event, data) {
    // Ensure the userId passed here matches the format expected (e.g., the 'sub' value)
    const userRoom = `user_${userId}`;
    this.io.to(userRoom).emit(event, data);
  }

}

module.exports = SocketService;
