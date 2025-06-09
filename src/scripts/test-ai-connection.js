const aiService = require('../services/aiService');
const { logger } = require('../utils/logger');

async function testAiConnection() {
    try {
        logger.info('Testing AI server connection...');
        
        // First check health
        const isHealthy = await aiService.checkHealth();
        logger.info(`AI server health check result: ${isHealthy}`);
        
        if (isHealthy) {
            // If healthy, try to generate an embedding using the real entity ID from the queue
            const entityId = 'e10d851f-03ee-4250-94da-40e98df0d6b7';
            logger.info('Attempting to generate embedding for real entity...');
            logger.info(`Entity ID: ${entityId}`);
            logger.info(`Entity Type: list-items`);
            
            const result = await aiService.generateEmbedding('list-items', entityId);
            logger.info('Embedding generation result:', result);
        }
    } catch (error) {
        logger.error('Test failed with error:', {
            message: error.message,
            stack: error.stack,
            response: error.response ? {
                status: error.response.status,
                statusText: error.response.statusText,
                data: error.response.data
            } : 'No response data'
        });
    }
}

// Run the test
testAiConnection(); 