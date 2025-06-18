// Utility helper to persist search-query embeddings
// Usage: await safeStoreSearchEmbedding(req, query);

const EmbeddingService = require('../services/embeddingService');
const { logger } = require('../utils/logger');

/**
 * Safely persist a search query embedding without impacting request latency.
 * Swallows errors after logging.
 *
 * @param {object} req - Express request (may contain user)
 * @param {string} queryText - Raw search text
 */
async function safeStoreSearchEmbedding(req, queryText) {
  if (!queryText || queryText.trim().length < 2) return;
  try {
    const userId = req?.user?.id || null;
    await EmbeddingService.storeSearchEmbedding(userId, queryText);
  } catch (err) {
    logger?.warn?.('[searchEmbeddingUtils] Failed to store search embedding:', err.message);
  }
}

module.exports = {
  safeStoreSearchEmbedding,
}; 