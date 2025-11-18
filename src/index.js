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
const NotificationService = require('./services/NotificationService');
const hydrateNotificationPreferences = require('./utils/hydrateNotificationPreferences');

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
const createSearchRouter = require('./routes/search.routes');
const createRecipeRouter = require('./routes/recipe.routes');
const createPublicListsRouter = require('./routes/public-lists.routes');
const createCollaborationRouter = require('./routes/collaboration.routes.js');
const createListTypesRouter = require('./routes/list-types.routes');
const createConnectionsRouter = require('./routes/connections.routes');
const createListSharingRouter = require('./routes/list-sharing.routes');
const createPreferencesRouter = require('./routes/preferences.routes');

// Import controllers that need initialization
const favoritesControllerFactory = require('./controllers/FavoritesController');
const userControllerFactory = require('./controllers/UserController');
const collaborationControllerFactory = require('./controllers/CollaborationController');
const connectionsControllerFactory = require('./controllers/ConnectionsController');
const booksControllerFactory = require('./controllers/BooksController');
const tmdbControllerFactory = require('./controllers/TMDBController');
const spotifyControllerFactory = require('./controllers/SpotifyController');
const stockImagesControllerFactory = require('./controllers/StockImagesController');
const ytMusicControllerFactory = require('./controllers/YTMusicController');
const uploadControllerFactory = require('./controllers/UploadController');
const embeddingsControllerFactory = require('./controllers/EmbeddingsController');
const searchControllerFactory = require('./controllers/SearchController');
const recipeControllerFactory = require('./controllers/RecipeController');
const publicListsControllerFactory = require('./controllers/PublicListsController');
const listTypesControllerFactory = require('./controllers/ListTypesController');
const listSharingController = require('./controllers/ListSharingController');
const preferencesControllerFactory = require('./controllers/PreferencesController');

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
const osmRoutes = require('./routes/osm.routes');
const giftRoutes = require('./routes/gifts.routes');
const createGroupInvitationsController = require('./controllers/GroupInvitationsController');
const createGroupInvitationsRoutes = require('./routes/group-invitations.routes');
const bugReportsRouter = require('./routes/bug-reports.routes');
const supportRoutes = require('./routes/support.routes');
const secretSantaRoutes = require('./routes/secret-santa.routes');

// --- 2. Initialize Express App and HTTP Server ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3100;

// --- 3. Initialize Socket.IO Service ---
const socketService = new SocketService(server);
NotificationService.setSocketService(socketService);

// --- 4. Initialize Controllers that need dependencies ---
const favoritesController = favoritesControllerFactory(socketService);
const userController = userControllerFactory(socketService);
const collaborationController = collaborationControllerFactory(socketService);
const connectionsController = connectionsControllerFactory(socketService);
const booksController = booksControllerFactory(socketService);
const tmdbController = tmdbControllerFactory(socketService);
const spotifyController = spotifyControllerFactory(socketService);
const stockImagesController = stockImagesControllerFactory(socketService);
const ytMusicController = ytMusicControllerFactory(socketService);
const uploadController = uploadControllerFactory(socketService);
const embeddingsController = embeddingsControllerFactory(socketService);
const searchController = searchControllerFactory(socketService);
const recipeController = recipeControllerFactory(socketService);
const publicListsController = publicListsControllerFactory();
const listTypesController = listTypesControllerFactory();
const preferencesController = preferencesControllerFactory(socketService);
const groupInvitationsController = createGroupInvitationsController(socketService);

hydrateNotificationPreferences();

console.log('CORS_ORIGIN', process.env.CORS_ORIGIN);

// --- 5. Middleware --- --
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:8080',
      'http://localhost:8081',
      'http://localhost:8082',
      'https://app-dev.rekkoo.com',
      'http://app-dev.rekkoo.com',
      // Local development
      'http://localhost:5173',  // Vite dev server (admin SPA)
      'http://localhost:3100',  // Express API itself (for server-to-server requests)
      'http://api-dev.rekkoo.com',
      'https://api-dev.rekkoo.com',
      // Production URLs
      'https://app.rekkoo.com',
      'https://admin.rekkoo.com',
      // Development URLs
      'http://rekkoo-admin.localhost',
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
// When serving the app over HTTPS on a different subdomain (e.g., app-dev.rekkoo.com ↔ api-dev.rekkoo.com),
// the cookie must be SameSite=None and Secure=true for the browser to accept it.
app.set('trust proxy', 1); // respect X-Forwarded-Proto from Traefik

const appUrl = process.env.CLIENT_URL_APP || 'http://localhost:8081';
const isHttpsApp = appUrl.startsWith('https://');

app.use(expressSession({
  secret: process.env.SESSION_SECRET || 'rekkoo_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isHttpsApp || process.env.FORCE_SECURE_COOKIE === 'true',
    sameSite: (isHttpsApp || process.env.FORCE_SAMESITE_NONE === 'true') ? 'none' : 'lax',
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
app.use('/v1.0/osm', osmRoutes);

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

// Unified search router
const searchRouter = createSearchRouter(searchController);
app.use('/v1.0/search', searchRouter);

const recipeRouter = createRecipeRouter(recipeController);
app.use('/v1.0/recipe', recipeRouter);

// List sharing routes (must come before public lists route due to specific paths)
app.use('/v1.0/lists', createListSharingRouter(listSharingController));

// Public lists route (has catch-all /:id route so must come after specific routes)
const publicListsRouter = createPublicListsRouter(publicListsController);
app.use('/v1.0/lists', publicListsRouter);

app.use('/v1.0/list-types', createListTypesRouter(listTypesController));

app.use('/api/chat', initializeChatRoutes(socketService));
app.use('/sync', initializeSyncRoutes(socketService));
app.use('/v1.0/collaboration', createCollaborationRouter(collaborationController));
app.use('/v1.0/connections', createConnectionsRouter(connectionsController));
app.use('/v1.0/preferences', createPreferencesRouter(preferencesController));
app.use('/v1.0/groups', createGroupInvitationsRoutes(groupInvitationsController));
app.use('/v1.0/gifts', giftRoutes);
app.use('/v1.0/bugs', bugReportsRouter);
app.use('/v1.0/support', supportRoutes);
app.use('/v1.0', secretSantaRoutes);

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
