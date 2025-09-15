const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with collaboration routes
 * @param {Object} collaborationController - Controller with collaboration methods
 * @returns {express.Router} Express router
 */
function createCollaborationRouter(collaborationController) {
  const router = express.Router();

  // User search route
  router.get('/users/search', authenticateJWT, collaborationController.searchUsers);

  // Group routes
  router.post('/groups', authenticateJWT, collaborationController.createGroup);
  router.get('/groups', authenticateJWT, collaborationController.getGroupsForUser);

  // Group member routes
  router.post('/groups/:groupId/members', authenticateJWT, collaborationController.addMemberToGroup);
  router.get('/groups/:groupId/members', authenticateJWT, collaborationController.getGroupMembers);
  router.post('/groups/bulk-members', authenticateJWT, collaborationController.getBulkGroupMembers);
  router.delete('/groups/:groupId/members/:userId', authenticateJWT, collaborationController.removeMemberFromGroup);

  // Group invitation routes
  router.post('/groups/:groupId/invitations', authenticateJWT, collaborationController.inviteUserToGroup);
  router.get('/groups/invitations/pending', authenticateJWT, collaborationController.getPendingGroupInvitations);
  router.post('/groups/invitations/:invitationId/accept', authenticateJWT, collaborationController.acceptGroupInvitation);
  router.post('/groups/invitations/:invitationId/decline', authenticateJWT, collaborationController.declineGroupInvitation);

  // List sharing routes
  router.post('/lists/batch-shares', authenticateJWT, collaborationController.getBatchListShares);
  router.get('/lists/:listId/shares', authenticateJWT, collaborationController.getListShares);
  router.post('/lists/:listId/share/:groupId', authenticateJWT, collaborationController.shareListWithGroup);
  router.delete('/lists/:listId/share/:groupId', authenticateJWT, collaborationController.unshareListFromGroup);

  // List-specific group roles routes
  router.get('/lists/:listId/groups', authenticateJWT, collaborationController.getListGroupsWithRoles);
  router.post('/lists/:listId/groups/:groupId', authenticateJWT, collaborationController.attachGroupToList);
  router.put('/lists/:listId/groups/:groupId', authenticateJWT, collaborationController.updateGroupRoleOnList);
  router.delete('/lists/:listId/groups/:groupId', authenticateJWT, collaborationController.detachGroupFromList);
  router.get('/lists/:listId/groups/:groupId/users', authenticateJWT, collaborationController.getGroupUserRolesOnList);

  // List-specific per-user overrides
  router.get('/lists/:listId/users', authenticateJWT, collaborationController.getListUserOverrides);
  router.put('/lists/:listId/users/:userId/role', authenticateJWT, collaborationController.setUserRoleOverrideOnList);

  // Get effective user role for a list
  router.get('/lists/:listId/users/:userId/role', authenticateJWT, collaborationController.getUserListRole);

  // List-specific per-group per-user roles
  router.put('/lists/:listId/groups/:groupId/users/:userId/role', authenticateJWT, collaborationController.setUserRoleForGroupOnList);

  // Group List Attachment Consent routes
  router.get('/consents/pending', authenticateJWT, collaborationController.getPendingConsents);
  router.post('/consents/:consentId/accept', authenticateJWT, collaborationController.acceptConsent);
  router.post('/consents/:consentId/decline', authenticateJWT, collaborationController.declineConsent);

  // "Shop For" routes
  router.post('/items/:itemId/claim', authenticateJWT, collaborationController.claimGift);
  router.delete('/items/:itemId/claim', authenticateJWT, collaborationController.unclaimGift);

  return router;
}

module.exports = createCollaborationRouter; 