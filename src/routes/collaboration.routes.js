const express = require('express');
const router = express.Router();
const CollaborationController = require('../controllers/CollaborationController');
const { authenticateJWT } = require('../auth/middleware');

// Group routes
router.post('/groups', authenticateJWT, CollaborationController.createGroup);
router.get('/groups', authenticateJWT, CollaborationController.getGroupsForUser);

// Group member routes
router.post('/groups/:groupId/members', authenticateJWT, CollaborationController.addMemberToGroup);
router.get('/groups/:groupId/members', authenticateJWT, CollaborationController.getGroupMembers);
router.delete('/groups/:groupId/members/:userId', authenticateJWT, CollaborationController.removeMemberFromGroup);

// Group invitation routes
router.post('/groups/:groupId/invitations', authenticateJWT, CollaborationController.inviteUserToGroup);

// List sharing routes
router.get('/lists/:listId/shares', authenticateJWT, CollaborationController.getListShares);
router.post('/lists/:listId/share/:groupId', authenticateJWT, CollaborationController.shareListWithGroup);
router.delete('/lists/:listId/share/:groupId', authenticateJWT, CollaborationController.unshareListFromGroup);

// List-specific group roles routes
router.get('/lists/:listId/groups', authenticateJWT, CollaborationController.getListGroupsWithRoles);
router.post('/lists/:listId/groups/:groupId', authenticateJWT, CollaborationController.attachGroupToList);
router.put('/lists/:listId/groups/:groupId', authenticateJWT, CollaborationController.updateGroupRoleOnList);
router.delete('/lists/:listId/groups/:groupId', authenticateJWT, CollaborationController.detachGroupFromList);
router.get('/lists/:listId/groups/:groupId/users', authenticateJWT, CollaborationController.getGroupUserRolesOnList);

// List-specific per-user overrides
router.get('/lists/:listId/users', authenticateJWT, CollaborationController.getListUserOverrides);
router.put('/lists/:listId/users/:userId/role', authenticateJWT, CollaborationController.setUserRoleOverrideOnList);

// List-specific per-group per-user roles
router.put('/lists/:listId/groups/:groupId/users/:userId/role', authenticateJWT, CollaborationController.setUserRoleForGroupOnList);

// "Shop For" routes
router.post('/items/:itemId/claim', authenticateJWT, CollaborationController.claimGift);
router.delete('/items/:itemId/claim', authenticateJWT, CollaborationController.unclaimGift);

module.exports = router; 