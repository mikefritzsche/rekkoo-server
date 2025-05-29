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
const createFavoritesRouter = require('./routes/favorites.routes');
const createUserRouter = require('./routes/user.routes');
const createBooksRouter = require('./routes/books.routes');
const createTMDBRouter = require('./routes/tmdb.routes');
const createSpotifyRouter = require('./routes/spotify.routes');
const createStockImagesRouter = require('./routes/stock-images.routes');
const createYTMusicRouter = require('./routes/ytmusic.routes');
const createUploadRouter = require('./routes/upload.routes');
const createEmbeddingsRouter = require('./routes/embeddings.routes');

// Import controllers that need initialization
const favoritesControllerFactory = require('./controllers/FavoritesController');
const userControllerFactory = require('./controllers/UserController');
const booksControllerFactory = require('./controllers/BooksController');
const tmdbControllerFactory = require('./controllers/TMDBController');
const spotifyControllerFactory = require('./controllers/SpotifyController');
const stockImagesControllerFactory = require('./controllers/StockImagesController');
const ytMusicControllerFactory = require('./controllers/YTMusicController');
const uploadControllerFactory = require('./controllers/UploadController');
const embeddingsControllerFactory = require('./controllers/EmbeddingsController');

// Import standard routes
const claudeRoutes = require('./routes/claude');
const placesRoutes = require('./routes/places.routes');
const productsRoutes = require('./routes/products.routes');
const authRoutes = require('./routes/auth');
const amazonRoutes = require('./routes/amazon.routes');
const geminiRoutes = require('./routes/gemini.routes');
const openlibraryRoutes = require('./routes/openlibrary.routes');

// --- 2. Initialize Express App and HTTP Server ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3100;

// --- 3. Initialize Socket.IO Service ---
const socketService = new SocketService(server);

// --- 4. Initialize Controllers that need dependencies ---
const favoritesController = favoritesControllerFactory(socketService);
const userController = userControllerFactory(socketService);
const booksController = booksControllerFactory(socketService);
const tmdbController = tmdbControllerFactory(socketService);
const spotifyController = spotifyControllerFactory(socketService);
const stockImagesController = stockImagesControllerFactory(socketService);
const ytMusicController = ytMusicControllerFactory(socketService);
const uploadController = uploadControllerFactory(socketService);
const embeddingsController = embeddingsControllerFactory(socketService);

// --- 5. Middleware ---
app.use(cors({
  origin: process.env.CORS_ORIGIN || ['http://localhost:3000', 'http://localhost:8081'],
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// --- 6. Mount Routes ---
// Routes that DON'T need socketService
app.use('/api/v1.0/claude', claudeRoutes);
app.use('/v1.0/places', placesRoutes);
app.use('/v1.0/recommendations', openlibraryRoutes);
app.use('/v1.0/suggestions', geminiRoutes);
app.use('/v1.0/products', productsRoutes);
app.use('/v1.0/auth', authRoutes);
app.use('/amazon', amazonRoutes);

// Initialize and mount routes that need socket service or use the factory pattern
const favoritesRouter = createFavoritesRouter(favoritesController);
app.use('/v1.0/favorites', favoritesRouter);
app.use('/api/favorites', favoritesRouter);

const userRouter = createUserRouter(userController);
app.use('/api/v1.0/users', userRouter);

const booksRouter = createBooksRouter(booksController);
app.use('/v1.0/books', booksRouter);

const tmdbRouter = createTMDBRouter(tmdbController);
app.use('/v1.0/media', tmdbRouter);

const spotifyRouter = createSpotifyRouter(spotifyController);
app.use('/v1.0/spotify', spotifyRouter);

const stockImagesRouter = createStockImagesRouter(stockImagesController);
app.use('/v1.0/images', stockImagesRouter);

const ytMusicRouter = createYTMusicRouter(ytMusicController);
app.use('/v1.0/ytmusic', ytMusicRouter);

const uploadRouter = createUploadRouter(uploadController);
app.use('/uploads', uploadRouter);

const embeddingsRouter = createEmbeddingsRouter(embeddingsController);
app.use('/v1.0/embeddings', embeddingsRouter);

app.use('/api/chat', initializeChatRoutes(socketService));
app.use('/sync', initializeSyncRoutes(socketService));

// --- 7. Basic/Utility Routes ---
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

// --- 8. Error Handling Middleware (Keep this last) ---
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- 9. Start Server ---
server.listen(PORT, () => {
  console.log(`env: `, process.env)
  console.log(`DB_SSL: `, process.env.DB_SSL);
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Socket.IO listening on port ${PORT}`);
});