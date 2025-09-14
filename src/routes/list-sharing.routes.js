const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with list sharing routes
 * Phase 3: List Sharing with Groups
 * @param {Object} listSharingController - Controller with list sharing methods
 * @returns {express.Router} Express router
 */
function createListSharingRouter(listSharingController) {
  const router = express.Router();

  // List invitation routes
  router.post('/:listId/invitations', authenticateJWT, listSharingController.sendListInvitation);
  router.get('/invitations/pending', authenticateJWT, listSharingController.getPendingInvitations);
  router.get('/invitations/sent', authenticateJWT, listSharingController.getSentInvitations);
  router.post('/invitations/:id/accept', authenticateJWT, listSharingController.acceptInvitation);
  router.post('/invitations/:id/decline', authenticateJWT, listSharingController.declineInvitation);
  router.delete('/invitations/:id/cancel', authenticateJWT, listSharingController.cancelInvitation);

  // List sharing routes
  router.post('/:listId/share/user', authenticateJWT, listSharingController.shareWithUser);
  router.post('/:listId/share/group', authenticateJWT, listSharingController.shareWithGroup);
  router.get('/:listId/shares', authenticateJWT, listSharingController.getListShares);
  router.delete('/:listId/shares/:shareId', authenticateJWT, listSharingController.revokeShare);

  // Permission and access routes
  router.get('/shared-with-me', authenticateJWT, listSharingController.getSharedWithMe);
  router.get('/:listId/permissions', authenticateJWT, listSharingController.getMyPermissions);
  router.get('/:listId/collaborators', authenticateJWT, listSharingController.getCollaborators);

  return router;
}

module.exports = createListSharingRouter;