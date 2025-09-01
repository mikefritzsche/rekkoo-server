const express = require('express');
const router = express.Router();
const GiftController = require('../controllers/GiftController');
const { authenticateJWT } = require('../auth/middleware');

// All routes require authentication
router.use(authenticateJWT);

// Get reservation status for an item
router.get('/items/:itemId/status', GiftController.getItemReservationStatus);

// Reserve an item
router.post('/items/:itemId/reserve', GiftController.reserveItem);

// Purchase (mark as purchased) an item
router.post('/items/:itemId/purchase', GiftController.purchaseItem);

// Release a reservation or purchase
router.post('/items/:itemId/release', GiftController.releaseItem);

// Get all items with reservation status for a list
router.get('/lists/:listId/reservations', GiftController.getListReservations);

module.exports = router;