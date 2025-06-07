// const pipeline = require('@xenova/transformers').pipeline;

const embeddingService = require('../services/embeddingService');
const { logger } = require('../utils/logger');

const embeddingsControllerFactory = (socketService) => {
    return {
        async storeEmbedding(req, res) {
            try {
                const { content, metadata } = req.body;
                
                if (!content) {
                    return res.status(400).json({ error: 'Content is required' });
                }

                const result = await embeddingService.storeEmbedding(content, metadata);
                
                // Notify connected clients about new embedding
                socketService.io.emit('embedding:created', result);
                
                res.json(result);
            } catch (error) {
                logger.error('Error storing embedding:', error);
                res.status(500).json({ error: 'Failed to store embedding' });
            }
        },

        async findSimilar(req, res) {
            try {
                const { text, limit, threshold, filter } = req.body;
                
                if (!text) {
                    return res.status(400).json({ error: 'Text is required' });
                }

                const results = await embeddingService.findSimilar(text, { limit, threshold, filter });
                res.json(results);
            } catch (error) {
                logger.error('Error finding similar embeddings:', error);
                res.status(500).json({ error: 'Failed to find similar embeddings' });
            }
        },

        async getStatus(req, res) {
            try {
                const status = await embeddingService.getStats();
                res.json(status);
            } catch (error) {
                logger.error('Error getting embedding service status:', error);
                res.status(500).json({ error: 'Failed to get status' });
            }
        }
    };
};

module.exports = embeddingsControllerFactory; 