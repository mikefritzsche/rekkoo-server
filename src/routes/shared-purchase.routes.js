const express = require('express');
const { authenticateJWT } = require('../auth/middleware');
const SharedPurchaseController = require('../controllers/SharedPurchaseController');

const router = express.Router();

router.use(authenticateJWT);

router.patch(
  '/:groupId/contributions/:contributionId',
  SharedPurchaseController.updateContribution
);
router.delete(
  '/:groupId/contributions/:contributionId',
  SharedPurchaseController.deleteContribution
);
router.patch('/:groupId', SharedPurchaseController.manageGroup);
router.delete('/:groupId', SharedPurchaseController.deleteGroup);

module.exports = router;
