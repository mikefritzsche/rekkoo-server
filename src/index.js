const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

// --- 1. Import Services and Route Initializers ---
const SocketService = require('./services/socket-service');

// Import route *initializer functions* where needed
const initializeChatRoutes = require('./routes/chat.routes'); // Exports a function: (socketService) => router
const initializeSyncRoutes = require('./routes/sync.routes'); // Exports a function: (socketService) => router

// Import standard routes (assuming they export the router directly: module.exports = router;)
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
// Note: Removed the (socketService) from require lines above

// --- 2. Initialize Express App and HTTP Server ---
const app = express();
const server = http.createServer(app); // Pass express app to http server
const PORT = process.env.PORT || 3000;

// --- 3. Initialize Socket.IO Service ---
// Needs to happen *after* server is created, but *before* routes using it are mounted.
const socketService = new SocketService(server);

// --- 4. Middleware ---
app.use(cors({
  origin: '*',
  methods: ['GET', 'DELETE', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization', // Important for JWT
    'Cache-Control',
    'Pragma',
    'X-Random'
  ],
}));
app.use(express.json()); // Parse JSON bodies

// --- Optional: Add Authentication Middleware BEFORE protected routes ---
// const { authenticateJWT } = require('./auth/middleware'); // Example path
// If most routes need auth, you could add it globally:
// app.use(authenticateJWT);
// Or apply it selectively within specific route files or using app.use('/path', authenticateJWT, routes);

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
app.use('/auth', authRoutes);
app.use('/amazon', amazonRoutes); // Assuming this doesn't need socketService

// Routes that DO need socketService
// Call the initializer function here, passing the created instance
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

// --- Problematic Route (Keep in mind previous warnings) ---
app.get('/gifster-fetch', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).json({ message: 'Missing url query parameter' });
    }
    console.log(`[${new Date().toISOString()}] Fetching Giftster URL: ${url}`);
    // Consider adding error handling and checking the response status from fetch
    const resp = await fetch(`https://www.giftster.com/fetch/?url=${encodeURIComponent(url)}`, {
      "headers": {
        // Headers might need updating or removal, especially the cookie
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "Referer": "https://www.giftster.com/", // Simplier Referer might be better
        "Referrer-Policy": "strict-origin-when-cross-origin"
        // Avoid sending fixed cookies like this - it will break
      },
      "method": "GET"
    });

    if (!resp.ok) {
      console.error(`[${new Date().toISOString()}] Giftster fetch failed with status: ${resp.status} ${resp.statusText}`);
      // Try to get error body if possible
      let errorBody = 'Could not retrieve error details.';
      try {
        errorBody = await resp.text();
      } catch (e) { /* Ignore if body cannot be read */ }
      return res.status(resp.status).json({ message: `Giftster fetch failed: ${resp.statusText}`, details: errorBody });
    }

    const data = await resp.json();
    console.log(`[${new Date().toISOString()}] Giftster fetch successful for: ${url}`);
    res.json(data);
  } catch(error) {
    console.error(`[${new Date().toISOString()}] Error in /gifster-fetch:`, error);
    res.status(500).json({ message: 'Something went wrong during Giftster fetch!' });
  }
});


// --- 7. Error Handling Middleware (Keep this last) ---
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled Error:`, err); // Log the full error
  // Avoid exposing detailed error stacks in production
  res.status(err.status || 500).json({ message: err.message || 'Something went wrong!' });
});

// --- 8. Start Server ---
server.listen(PORT, () => { // Correctly use server.listen
  console.log(`DB_SSL: `, process.env.DB_SSL); // Make sure DB_SSL is actually used somewhere if logged
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Socket.IO listening on port ${PORT}`);
});