const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with user routes
 * @param {Object} userController - Controller with user management methods
 * @returns {express.Router} Express router
 */
function createUserRouter(userController) {
  const router = express.Router();

  /**
   * @route GET /batch
   * @desc Get multiple users by their IDs
   * @access Private
   */
  router.get('/batch', authenticateJWT, userController.getUsersByIds);

  /**
   * @route GET /suggestions
   * @desc Get users to suggest following
   * @access Private
   */
  router.get('/suggestions', authenticateJWT, userController.getUserSuggestions);

  /**
   * @route GET /
   * @desc Get all users with pagination
   * @access Private
   */
  router.get('/', authenticateJWT, userController.getUsers);

  /**
   * @route DELETE /
   * @desc Delete multiple users
   * @access Private
   */
  router.delete('/', authenticateJWT, userController.deleteMultipleUsers);

  /**
   * @route GET /search
   * @desc Search for users by username, email, or display name
   * @access Private
   */
  router.get('/search', authenticateJWT, userController.searchUsers);

  /**
   * @route GET /:id
   * @desc Get user by ID
   * @access Private
   */
  router.get('/:id', authenticateJWT, userController.getUserById);

  /**
   * @route GET /:userId/followers
   * @desc Get users following :userId
   * @access Private
   */
  router.get('/:userId/followers', authenticateJWT, userController.getUserFollowers);

  /**
   * @route GET /:userId/following
   * @desc Get users :userId is following
   * @access Private
   */
  router.get('/:userId/following', authenticateJWT, userController.getUserFollowing);

  /**
   * @route GET /:targetUserId/lists
   * @desc Get public lists of :targetUserId
   * @access Private
   */
  router.get('/:targetUserId/lists', authenticateJWT, userController.getUserPublicLists);

  /**
   * @route GET /:targetUserId/lists-with-access
   * @desc Get all lists for a user with proper privacy values (for access control)
   * @access Private
   */
  router.get('/:targetUserId/lists-with-access', authenticateJWT, userController.getUserListsWithAccess);

  /**
   * @route GET /:targetUserId/lists-live
   * @desc Get lists with real-time access checks (for viewing other users' lists)
   * @access Private
   */
  router.get('/:targetUserId/lists-live', authenticateJWT, userController.getUserListsLive);

  /**
   * @route POST /
   * @desc Create a new user
   * @access Private
   */
  router.post('/', authenticateJWT, userController.createUser);

  /**
   * @route DELETE /:id
   * @desc Delete a user by ID
   * @access Private
   */
  router.delete('/:id', authenticateJWT, userController.deleteUser);

  return router;
}

module.exports = createUserRouter;
