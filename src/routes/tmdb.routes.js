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

  router.get('/configuration', tmdbController.getConfiguration);

  return router;
}

module.exports = createTMDBRouter;