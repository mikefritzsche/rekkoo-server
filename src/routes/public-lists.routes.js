const express = require('express');

function createPublicListsRouter(controller) {
  const router = express.Router();

  // GET /v1.0/lists/:id
  router.get('/:id', controller.getListById);

  return router;
}

module.exports = createPublicListsRouter; 