const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with connection routes
 * @param {Object} connectionsController - Controller with connection methods
 * @returns {express.Router} Express router
 */
function createConnectionsRouter(connectionsController) {
  const router = express.Router();

  // Connection request routes
  router.post('/request', authenticateJWT, connectionsController.sendConnectionRequest);
  router.get('/requests/pending', authenticateJWT, connectionsController.getPendingRequests);
  router.get('/requests/sent', authenticateJWT, connectionsController.getSentRequests);
  router.post('/requests/:requestId/accept', authenticateJWT, connectionsController.acceptRequest);
  router.post('/requests/:requestId/decline', authenticateJWT, connectionsController.declineRequest);
  router.delete('/requests/:requestId/cancel', authenticateJWT, connectionsController.cancelRequest);

  // Connection management routes
  router.get('/', authenticateJWT, connectionsController.getConnections);
  router.get('/status/:targetUserId', authenticateJWT, connectionsController.checkConnectionStatus);
  router.delete('/:connectionId', authenticateJWT, connectionsController.removeConnection);
  router.post('/block/:userIdToBlock', authenticateJWT, connectionsController.blockUser);

  // Privacy settings routes
  router.get('/privacy', authenticateJWT, connectionsController.getPrivacySettings);
  router.put('/privacy', authenticateJWT, connectionsController.updatePrivacySettings);

  // User search route (respects privacy settings)
  router.get('/search', authenticateJWT, connectionsController.searchUsers);

  return router;
}

module.exports = createConnectionsRouter;