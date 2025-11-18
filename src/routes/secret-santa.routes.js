const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../auth/middleware');
const SecretSantaController = require('../controllers/SecretSantaController');

router.use(authenticateJWT);

router.get(
  '/lists/:listId/secret-santa/active',
  (req, res) => SecretSantaController.getActiveRound(req, res)
);

router.post(
  '/lists/:listId/secret-santa',
  (req, res) => SecretSantaController.createRound(req, res)
);

router.patch(
  '/secret-santa/:roundId',
  (req, res) => SecretSantaController.updateRound(req, res)
);

router.post(
  '/secret-santa/:roundId/publish',
  (req, res) => SecretSantaController.publishRound(req, res)
);

router.post(
  '/lists/:listId/secret-santa/invitations',
  (req, res) => SecretSantaController.inviteGuests(req, res)
);

module.exports = router;
