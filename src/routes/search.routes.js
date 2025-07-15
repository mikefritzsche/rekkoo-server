const express = require('express');

/**
 * Returns an Express router for unified search endpoints
 * @param {Object} searchController Controller with combinedSearch handler
 * @returns {express.Router}
 */
function createSearchRouter(searchController) {
  const router = express.Router();

  /**
   * @route GET /
   * @desc Combined search across lists, list items, and users
   * @access Public (or adjust middleware as needed)
   */
  router.get('/', searchController.combinedSearch);

  return router;
}

module.exports = createSearchRouter; 