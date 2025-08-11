// server/src/routes/favorites.routes.js
const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with favorites routes
 * @param {Object} favoritesController - Controller with favorites methods
 * @returns {express.Router} Express router
 */
function createFavoritesRouter(favoritesController) {
  const router = express.Router();

  /**
   * @route POST /
   * @desc Add a list or list item to favorites
   * @access Private
   */
  router.post('/', authenticateJWT, favoritesController.addToFavorites);

  /**
   * @route DELETE /:id
   * @desc Remove a favorite by ID
   * @access Private
   */
  router.delete('/:id', authenticateJWT, favoritesController.removeFromFavorites);

  /**
   * @route GET /
   * @desc Get user's favorites with optional filtering
   * @access Private
   */
  router.get('/', authenticateJWT, favoritesController.getUserFavorites);

  /**
   * @route GET /status
   * @desc Check if an item is favorited by the current user
   * @access Private
   */
  router.get('/status', authenticateJWT, favoritesController.checkFavoriteStatus);
  router.get('/count', authenticateJWT, favoritesController.getFavoriteCount);
  router.get('/likers', authenticateJWT, favoritesController.getLikersForTarget);

  /**
   * @route GET /shared
   * @desc Get favorites shared with the current user
   * @access Private
   */
  router.get('/shared', authenticateJWT, favoritesController.getSharedWithMe);

  /**
   * @route POST /sort
   * @desc Update favorite sort order (batch operation)
   * @access Private
   */
  router.post('/sort', authenticateJWT, favoritesController.updateFavoriteSortOrder);

  /**
   * @route POST /share
   * @desc Share a favorite with another user or group
   * @access Private
   */
  router.post('/share', authenticateJWT, favoritesController.shareFavorite);

  /**
   * @route DELETE /share/:id
   * @desc Remove a sharing
   * @access Private
   */
  router.delete('/share/:id', authenticateJWT, favoritesController.removeSharing);

  /**
   * @route POST /notifications
   * @desc Set notification preferences for a favorite
   * @access Private
   */
  router.post('/notifications', authenticateJWT, favoritesController.setNotificationPreferences);

  // Category routes
  /**
   * @route POST /categories
   * @desc Create a new favorite category
   * @access Private
   */
  router.post('/categories', authenticateJWT, favoritesController.createCategory);

  /**
   * @route GET /categories
   * @desc Get all favorite categories for the current user
   * @access Private
   */
  router.get('/categories', authenticateJWT, favoritesController.getCategories);

  /**
   * @route PUT /categories/:id
   * @desc Update a favorite category
   * @access Private
   */
  router.put('/categories/:id', authenticateJWT, favoritesController.updateCategory);

  /**
   * @route DELETE /categories/:id
   * @desc Delete a favorite category
   * @access Private
   */
  router.delete('/categories/:id', authenticateJWT, favoritesController.deleteCategory);

  return router;
}

module.exports = createFavoritesRouter; 