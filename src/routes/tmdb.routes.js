const express = require('express');

/**
 * Creates and returns a router with TMDB routes
 * @param {Object} tmdbController - Controller with TMDB API methods
 * @returns {express.Router} Express router
 */
function createTMDBRouter(tmdbController) {
  const router = express.Router();

  /**
   * @route GET /search
   * @desc Search for movies and TV shows
   * @access Public
   */
  router.get('/search', tmdbController.searchMedia);

  /**
   * @route GET /details/:mediaType/:id
   * @desc Get movie or TV show details
   * @access Public
   */
  router.get('/details/:mediaType/:id', tmdbController.getMediaDetails);

  /**
   * @route POST /search/multiple
   * @desc Search for multiple movies at once
   * @access Public
   */
  router.post('/search/multiple', tmdbController.searchMultipleMedia);

  /**
   * @route GET /configuration
   * @desc Get TMDB configuration
   * @access Public
   */
  router.get('/configuration', tmdbController.getConfiguration);

  /**
   * @route DELETE /cache
   * @desc Clear TMDB cache entries
   * @access Admin
   */
  router.delete('/cache', tmdbController.clearTMDBCache);

  /**
   * @route GET /cache/stats
   * @desc Get TMDB cache statistics
   * @access Admin
   */
  router.get('/cache/stats', tmdbController.getTMDBCacheStats);

  return router;
}

module.exports = createTMDBRouter;