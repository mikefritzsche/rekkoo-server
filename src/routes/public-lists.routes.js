const express = require('express');
const { optionalAuthenticateJWT } = require('../auth/middleware');

function createPublicListsRouter(controller) {
  const router = express.Router();

  // GET /v1.0/lists/:id
  // Uses optional authentication to allow both public and authenticated access
  router.get('/:id', optionalAuthenticateJWT, controller.getListById);

  return router;
}

module.exports = createPublicListsRouter; 