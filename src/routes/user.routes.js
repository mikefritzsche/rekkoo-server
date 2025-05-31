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

  /**
   * @route DELETE /
   * @desc Delete multiple users
   * @access Private
   */
  router.delete('/', authenticateJWT, userController.deleteMultipleUsers);

  return router;
}

module.exports = createUserRouter;
