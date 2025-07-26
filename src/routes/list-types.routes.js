const express = require('express');
const { authenticateJWT, checkPermissions } = require('../auth/middleware');

function createListTypesRouter(controller) {
  const router = express.Router();

  // Public GET
  router.get('/', controller.getAll);

  // Protected CRUD (admin)
  const requireAdmin = checkPermissions(['admin']);

  router.post('/', authenticateJWT, requireAdmin, controller.create);
  router.patch('/:id', authenticateJWT, requireAdmin, controller.update);
  router.delete('/:id', authenticateJWT, requireAdmin, controller.remove);

  return router;
}

module.exports = createListTypesRouter; 