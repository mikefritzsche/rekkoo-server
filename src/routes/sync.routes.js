// src/routes/sync.routes.js
const express = require('express');
const { authenticateJWT } = require('../auth/middleware'); // Adjust path if needed
const validateListData = require('../middleware/validate-list-data'); // Adjust path if needed

// --- Import the controller factory functions ---
const syncControllerFactory = require('../controllers/SyncController');
const optimizedSyncControllerFactory = require('../controllers/OptimizedSyncController');
const syncMonitor = require('../middleware/sync-monitoring');

// --- Export a function that takes socketService ---
module.exports = (socketService) => {
  const router = express.Router(); // Create router inside the function

  // --- Instantiate the controllers with the socketService ---
  const syncController = syncControllerFactory(socketService);
  const optimizedSyncController = optimizedSyncControllerFactory(socketService);

  // Apply monitoring middleware to all sync routes, unless disabled for local dev
  if (process.env.DISABLE_SYNC_THROTTLE === 'true' || process.env.NODE_ENV === 'development') {
    // Skip monitoring to avoid 429s in local workflows
  } else {
    router.use(syncMonitor.monitor());
  }

  // Get sync state (pull changes) - NEW OPTIMIZED VERSION
  router.get('/changes', authenticateJWT, optimizedSyncController.handleGetChangesOptimized);
  
  // Get sync state (pull changes) - LEGACY VERSION (for fallback)
  router.get('/changes/legacy', authenticateJWT, syncController.handleGetChanges);

  // Push changes
  router.post('/push', authenticateJWT, validateListData, syncController.handlePush);

  // Get full initial state
  router.get('/state', authenticateJWT, syncController.handleGetState);

  // Get single record
  router.get('/:table/:id', authenticateJWT, syncController.handleGetRecord);

  // Get sync conflicts 
  router.get('/conflicts', authenticateJWT, syncController.handleGetConflicts);

  // Get sync queue status
  router.get('/queue', authenticateJWT, syncController.handleGetQueue);

  // Get list items (for group members to fetch shared list items)
  router.get('/lists/:listId/items', authenticateJWT, syncController.handleGetListItems);

  // New optimized endpoints
  router.get('/stats', authenticateJWT, optimizedSyncController.getSyncStats);
  
  // Health check endpoint (includes Valkey status)
  router.get('/health', optimizedSyncController.getHealthCheck);

  // System health check endpoint (monitoring stats)
  router.get('/system-health', (req, res) => {
    const healthStatus = syncMonitor.getHealthStatus();
    res.status(healthStatus.status === 'healthy' ? 200 : 503).json(healthStatus);
  });

  return router; // Return the configured router
}; // End export function