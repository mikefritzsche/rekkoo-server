const express = require('express');
const router = express.Router();
const embeddingService = require('../services/embeddingService');
const { logger } = require('../utils/logger');

// Generate and store embedding
router.post('/', async (req, res) => {
    try {
        const { content, metadata } = req.body;
        
        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const result = await embeddingService.storeEmbedding(content, metadata);
        res.json(result);
    } catch (error) {
        logger.error('Error storing embedding:', error);
        res.status(500).json({ error: 'Failed to store embedding' });
    }
});

// Find similar content
router.post('/similar', async (req, res) => {
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
});

// Get model status
router.get('/status', async (req, res) => {
    try {
        const status = await embeddingService.getStats();
        res.json(status);
    } catch (error) {
        logger.error('Error getting embedding service status:', error);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

module.exports = router; 