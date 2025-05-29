// server/src/routes/favorites.routes.js
const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with favorites routes
 * @param {Object} favoritesController - Controller with favorites methods
 * @returns {express.Router} Express router
 */
function createEmbeddingsRouter(embeddingsController) {
  const router = express.Router();

  /**
   * @route POST /
   * @desc Generate embeddings for a text
   * @access Private
   */
  router.post('/', embeddingsController.generateEmbeddings);


  return router;
}

module.exports = createEmbeddingsRouter; 