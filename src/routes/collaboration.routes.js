const express = require('express');
const router = express.Router();
const CollaborationController = require('../controllers/CollaborationController');
const { authenticateJWT } = require('../auth/middleware');

// Group routes
router.post('/groups', authenticateJWT, CollaborationController.createGroup);
router.get('/groups', authenticateJWT, CollaborationController.getGroupsForUser);

// Group member routes
router.post('/groups/:groupId/members', authenticateJWT, CollaborationController.addMemberToGroup);
router.delete('/groups/:groupId/members/:userId', authenticateJWT, CollaborationController.removeMemberFromGroup);

// Group invitation routes
router.post('/groups/:groupId/invitations', authenticateJWT, CollaborationController.inviteUserToGroup);

// List sharing routes
router.post('/lists/:listId/share/:groupId', authenticateJWT, CollaborationController.shareListWithGroup);
router.delete('/lists/:listId/share/:groupId', authenticateJWT, CollaborationController.unshareListFromGroup);

// "Shop For" routes
router.post('/items/:itemId/claim', authenticateJWT, CollaborationController.claimGift);
router.delete('/items/:itemId/claim', authenticateJWT, CollaborationController.unclaimGift);

module.exports = router; 