const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

function createGroupInvitationsRoutes(groupInvitationsController) {
  const router = express.Router();

  // All routes require authentication
  router.use(authenticateJWT);

  // Send a group invitation
  router.post('/groups/:groupId/invite', groupInvitationsController.sendInvitation);

  // Get pending invitations for current user
  router.get('/invitations', groupInvitationsController.getPendingInvitations);

  // Get invitations sent by current user
  router.get('/invitations/sent', groupInvitationsController.getSentInvitations);

  // Get all invitations for a specific group
  router.get('/groups/:groupId/invitations', groupInvitationsController.getGroupInvitations);

  // Accept a group invitation
  router.post('/invitations/:invitationId/accept', groupInvitationsController.acceptInvitation);

  // Decline a group invitation
  router.post('/invitations/:invitationId/decline', groupInvitationsController.declineInvitation);

  // Cancel a sent invitation
  router.post('/invitations/:invitationId/cancel', groupInvitationsController.cancelInvitation);

  // Get invitations expiring soon
  router.get('/invitations/expiring', groupInvitationsController.getExpiringInvitations);

  // Resend an invitation
  router.post('/invitations/:invitationId/resend', groupInvitationsController.resendInvitation);

  return router;
}

module.exports = createGroupInvitationsRoutes;