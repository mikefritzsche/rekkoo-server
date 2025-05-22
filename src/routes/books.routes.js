const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with books routes
 * @param {Object} booksController - Controller with book management methods
 * @returns {express.Router} Express router
 */
function createBooksRouter(booksController) {
  const router = express.Router();

  /**
   * @route GET /
   * @desc Search for books via Google Books API
   * @access Public
   */
  router.get('/', booksController.searchBooks);

  /**
   * @route GET /volume/details/:id
   * @desc Get book details by volume ID
   * @access Public
   */
  router.get('/volume/details/:id', booksController.getBookDetails);

  return router;
}

module.exports = createBooksRouter;