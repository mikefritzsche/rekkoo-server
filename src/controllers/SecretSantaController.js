const SecretSantaService = require('../services/SecretSantaService');

const handleError = (res, error) => {
  const status = error.statusCode || 500;
  const message =
    error.statusCode && error.message
      ? error.message
      : 'Unexpected error processing Secret Santa request';
  if (!error.statusCode) {
    console.error('[SecretSantaController]', error);
  }
  return res.status(status).json({ error: message });
};

class SecretSantaController {
  async getActiveRound(req, res) {
    try {
      const data = await SecretSantaService.getActiveRound(
        req.params.listId,
        req.user.id
      );
      return res.json(data);
    } catch (error) {
      return handleError(res, error);
    }
  }

  async createRound(req, res) {
    try {
      const data = await SecretSantaService.createRound(
        req.params.listId,
        req.user.id,
        req.body
      );
      return res.status(201).json(data);
    } catch (error) {
      return handleError(res, error);
    }
  }

  async updateRound(req, res) {
    try {
      const data = await SecretSantaService.updateRound(
        req.params.roundId,
        req.user.id,
        req.body
      );
      return res.json(data);
    } catch (error) {
      return handleError(res, error);
    }
  }

  async publishRound(req, res) {
    try {
      const data = await SecretSantaService.publishRound(
        req.params.roundId,
        req.user.id
      );
      return res.json(data);
    } catch (error) {
      return handleError(res, error);
    }
  }

  async inviteGuests(req, res) {
    try {
      const result = await SecretSantaService.inviteGuests(
        req.params.listId,
        req.user.id,
        req.body
      );
      return res.status(201).json(result);
    } catch (error) {
      return handleError(res, error);
    }
  }
}

module.exports = new SecretSantaController();
