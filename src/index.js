const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const { logger } = require('./utils/logger');

dotenv.config();

// --- 1. Import Services and Route Initializers ---
const SocketService = require('./services/socket-service');

// Import route *initializer functions* where needed
const initializeChatRoutes = require('./routes/chat.routes');
const initializeSyncRoutes = require('./routes/sync.routes');

// Import standard routes
const userRoutes = require('./routes/user.routes');
const claudeRoutes = require('./routes/claude');
const tmdbRoutes = require('./routes/tmdb.routes');
const ytmusicRoutes = require('./routes/ytmusic.routes');
const placesRoutes = require('./routes/places.routes');
const booksRoutes = require('./routes/books.routes');
const productsRoutes = require('./routes/products.routes');
const imagesRoutes = require('./routes/stock-images.routes');
const spotifyRoutes = require('./routes/spotify.routes');
const authRoutes = require('./routes/auth');
const amazonRoutes = require('./routes/amazon.routes');
const geminiRoutes = require('./routes/gemini.routes');
const openlibraryRoutes = require('./routes/openlibrary.routes');

// --- 2. Initialize Express App and HTTP Server ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// --- 3. Initialize Socket.IO Service ---
const socketService = new SocketService(server);

// --- 4. Middleware ---
app.use(cors({
  origin: process.env.CORS_ORIGIN || ['http://localhost:3000', 'http://localhost:8081'],
  credentials: true
}));
app.use(express.json());

// --- 5. Mount Routes ---
// Routes that DON'T need socketService
app.use('/api/v1.0/users', userRoutes);
app.use('/api/v1.0/claude', claudeRoutes);
app.use('/v1.0/media', tmdbRoutes);
app.use('/v1.0/ytmusic', ytmusicRoutes);
app.use('/v1.0/places', placesRoutes);
app.use('/v1.0/books', booksRoutes);
app.use('/v1.0/recommendations', openlibraryRoutes);
app.use('/v1.0/suggestions', geminiRoutes);
app.use('/v1.0/products', productsRoutes);
app.use('/v1.0/images', imagesRoutes);
app.use('/v1.0/spotify', spotifyRoutes);
app.use('/v1.0/auth', authRoutes);
app.use('/amazon', amazonRoutes);

// Routes that DO need socketService
app.use('/api/chat', initializeChatRoutes(socketService));
app.use('/sync', initializeSyncRoutes(socketService));

// --- 6. Basic/Utility Routes ---
app.get('/api/v1.0/health', (req, res) => {
  res.json({ status: 'ok', message: 'Rekko Health Check Successful' });
});
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Rekkoo'
  });
});
app.get('/api/v1.0', (req, res) => {
  res.json({ message: 'Welcome to Rekkoo API' });
});

// --- 7. Error Handling Middleware (Keep this last) ---
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- 8. Start Server ---
server.listen(PORT, () => {
  console.log(`env: `, process.env)
  console.log(`DB_SSL: `, process.env.DB_SSL);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Socket.IO listening on port ${PORT}`);
});