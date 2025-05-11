// src/routes/sync.routes.js
const express = require('express');
const { authenticateJWT } = require('../auth/middleware'); // Adjust path if needed
const validateListData = require('../middleware/validate-list-data'); // Adjust path if needed

// --- Import the controller factory function ---
const syncControllerFactory = require('../controllers/SyncController');

// --- Export a function that takes socketService ---
module.exports = (socketService) => {
  const router = express.Router(); // Create router inside the function

  // --- Instantiate the controller with the socketService ---
  const syncController = syncControllerFactory(socketService);

  // Get sync state (pull changes)
  router.get('/changes', authenticateJWT, syncController.handleGetChanges);

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

  return router; // Return the configured router
}; // End export function