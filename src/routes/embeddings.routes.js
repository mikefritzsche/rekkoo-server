// server/src/routes/favorites.routes.js
const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with favorites routes
 * @param {Object} favoritesController - Controller with favorites methods
 * @returns {express.Router} Express router
 */
const createEmbeddingsRouter = (controller) => {
  const router = express.Router();

  /**
   * @route POST /
   * @desc Generate embeddings for a text
   * @access Private
   */
  router.post('/', controller.storeEmbedding);

  // Find similar content
  router.post('/similar', controller.findSimilar);

  // Get model status
  router.get('/status', controller.getStatus);

  // Get debug info
  router.get('/debug-info', controller.getDebugInfo);

  return router;
};

module.exports = createEmbeddingsRouter; 