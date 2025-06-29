// v 0.0.2
const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { logger } = require('./utils/logger');
const { worker: embeddingQueueWorker } = require('./workers/embeddingQueueWorker');
const expressSession = require('express-session');

// Load environment variables from multiple files
// Load .env first (base configuration)
dotenv.config();
// Load .env.common (contains OAuth credentials and other shared config)
dotenv.config({ path: path.resolve(process.cwd(), '.env.common') });
// Load environment-specific file if it exists
const envFile = `.env.${process.env.NODE_ENV || 'development'}`;
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

// Log environment loading for debugging
console.log('🔧 Environment loaded from:', {
  NODE_ENV: process.env.NODE_ENV,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? '✓ Set' : '✗ Missing',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? '✓ Set' : '✗ Missing',
  PORT: process.env.PORT
});

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
const createRecipeRouter = require('./routes/recipe.routes');

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
const recipeControllerFactory = require('./controllers/RecipeController');

// Import standard routes
const claudeRoutes = require('./routes/claude');
const placesRoutes = require('./routes/places.routes');
const productsRoutes = require('./routes/products.routes');
const authRoutes = require('./routes/auth');
const amazonRoutes = require('./routes/amazon.routes');
const geminiRoutes = require('./routes/gemini.routes');
const openlibraryRoutes = require('./routes/openlibrary.routes');
const adminRoutes = require('./routes/admin.routes');
const invitationRoutes = require('./routes/invitations.routes');
const { log } = require('console');

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
const recipeController = recipeControllerFactory(socketService);

console.log('CORS_ORIGIN', process.env.CORS_ORIGIN);

// --- 5. Middleware --- --
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:8081',
      // Local development
      'http://localhost:5173',  // Vite dev server (admin SPA)
      'http://localhost:3100',  // Express API itself (for server-to-server requests)
      'http://api-dev.rekkoo.com',
      'https://api-dev.rekkoo.com',
      'https://app.rekkoo.com',
      'http://rekkoo-admin.localhost',
      'https://admin.rekkoo.com',
      'http://admin-dev.rekkoo.com',
      'https://admin-dev.rekkoo.com'
    ];
    
    // Check for exact matches first
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Check for dynamic staging subdomain pattern (branch-based deployments)
    // Matches: https://any-branch-name.app-staging.rekkoo.com
    if (origin.match(/^https:\/\/[a-z0-9-]+\.app-staging\.rekkoo\.com$/)) {
      console.log(`CORS: Allowed staging origin: ${origin}`);
      return callback(null, true);
    }
    
    // Log and reject other origins
    console.log(`CORS: Rejected origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  exposedHeaders: ['Authorization']
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: true }));

// ---- Session Middleware (must come before passport to allow passport to access session) ----
app.use(expressSession({
  secret: process.env.SESSION_SECRET || 'rekkoo_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

// ---- Passport ----
const passport = require('./auth/passport');
app.use(passport.initialize());

// --- 6. Mount Routes ---
// Routes that DON'T need socketService
app.use('/v1.0/claude', claudeRoutes);
app.use('/v1.0/places', placesRoutes);
app.use('/v1.0/recommendations', openlibraryRoutes);
app.use('/v1.0/suggestions', geminiRoutes);
app.use('/v1.0/products', productsRoutes);
app.use('/v1.0/auth', authRoutes);
app.use('/amazon', amazonRoutes);

// Admin routes (requires admin role)
app.use('/v1.0/admin', adminRoutes);

// Invitation routes (requires authentication)
app.use('/v1.0/invitations', invitationRoutes);

async function checkHealth() {
  try {
    const aiServerUrl = process.env.AI_SERVER_ENV === 'local' 
      ? process.env.AI_SERVER_URL_LOCAL 
      : process.env.AI_SERVER_URL_REMOTE;
    
    console.log('Using AI server URL:', aiServerUrl);
    const response = await fetch(`${aiServerUrl}/health`);
    // console.log('AI server Health Check response', response);
  } catch (error) {
    console.error('AI server Health Check error', error);
  }
}
checkHealth();

// Initialize and mount routes that need socket service or use the factory pattern
const favoritesRouter = createFavoritesRouter(favoritesController);
app.use('/v1.0/favorites', favoritesRouter);

const userRouter = createUserRouter(userController);
app.use('/v1.0/users', userRouter);

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

const recipeRouter = createRecipeRouter(recipeController);
app.use('/v1.0/recipe', recipeRouter);

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
  console.log(`env: `, process.env.CLIENT_URL_APP, process.env.CLIENT_URL_ADMIN, process.env.AI_SERVER_ENV, process.env.AI_SERVER_URL_LOCAL, process.env.AI_SERVER_URL_REMOTE)
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Socket.IO listening on port ${PORT}`);

  // Start the embedding queue worker
  embeddingQueueWorker.start()
    .catch(err => logger.error('Failed to start embedding queue worker:', err));
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received. Starting graceful shutdown...');
  
  // Stop the embedding queue worker
  embeddingQueueWorker.stop();
  
  // Close the server
  server.close(() => {
    logger.info('Server closed. Process terminating...');
    process.exit(0);
  });
});