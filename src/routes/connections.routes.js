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
  router.post('/connect-by-code', authenticateJWT, connectionsController.connectByCode);
  router.get('/requests/pending', authenticateJWT, connectionsController.getPendingRequests);
  router.get('/requests/sent', authenticateJWT, connectionsController.getSentRequests);
  router.get('/requests/expiring', authenticateJWT, connectionsController.getExpiringInvitations);
  router.post('/requests/:requestId/accept', authenticateJWT, connectionsController.acceptRequest);
  router.post('/requests/:requestId/decline', authenticateJWT, connectionsController.declineRequest);
  router.delete('/requests/:requestId/cancel', authenticateJWT, connectionsController.cancelRequest);

  // Connection management routes
  router.get('/', authenticateJWT, connectionsController.getConnections);
  router.get('/status/:targetUserId', authenticateJWT, connectionsController.checkConnectionStatus);
  router.delete('/:connectionId', authenticateJWT, connectionsController.removeConnection);
  router.post('/block/:userIdToBlock', authenticateJWT, connectionsController.blockUser);

  // Following/Unfollowing routes
  router.post('/follow/:userId', authenticateJWT, connectionsController.followUser);
  router.delete('/unfollow/:userId', authenticateJWT, connectionsController.unfollowUser);
  router.get('/followers', authenticateJWT, connectionsController.getFollowers);
  router.get('/following', authenticateJWT, connectionsController.getFollowing);

  // Privacy settings routes
  router.get('/privacy', authenticateJWT, connectionsController.getPrivacySettings);
  router.put('/privacy', authenticateJWT, connectionsController.updatePrivacySettings);

  // User search route (respects privacy settings)
  router.get('/search', authenticateJWT, connectionsController.searchUsers);

  return router;
}

module.exports = createConnectionsRouter;