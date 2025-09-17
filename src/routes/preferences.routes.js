const express = require('express');
const { authenticateJWT } = require('../auth/middleware');

/**
 * Creates and returns a router with preference routes
 * @param {Object} preferencesController - Controller with preference methods
 * @returns {express.Router} Express router
 */
function createPreferencesRouter(preferencesController) {
  const router = express.Router();

  // Get all categories and subcategories
  router.get('/categories', authenticateJWT, preferencesController.getCategories);

  // User preferences management
  router.get('/user', authenticateJWT, preferencesController.getUserPreferences);
  router.post('/user', authenticateJWT, preferencesController.saveUserPreferences);
  router.put('/user/:subcategoryId', authenticateJWT, preferencesController.updatePreference);

  // Discovery mode
  router.put('/discovery-mode', authenticateJWT, preferencesController.updateDiscoveryMode);

  // Onboarding status
  router.get('/onboarding-status', authenticateJWT, preferencesController.checkOnboardingStatus);

  // Regenerate preference embedding
  router.post('/regenerate-embedding', authenticateJWT, preferencesController.regeneratePreferenceEmbedding);

  return router;
}

module.exports = createPreferencesRouter;