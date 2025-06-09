const axios = require('axios');
const { logger } = require('../utils/logger');

const AI_SERVER_URL = process.env.AI_SERVER_URL;

if (!AI_SERVER_URL) {
    logger.warn('AI_SERVER_URL environment variable is not set. AI service calls will be disabled.');
}

/**
 * A client for interacting with the AI server.
 */
class AiService {
    constructor() {
        this.client = axios.create({
            baseURL: AI_SERVER_URL,
            timeout: 10000, // 10 second timeout
        });
    }

    /**
     * Triggers embedding generation for a given entity type and ID.
     * @param {string} entityType - The type of entity (e.g., 'list-items', 'lists', 'users').
     * @param {string} id - The UUID of the entity.
     * @returns {Promise<void>}
     */
    async generateEmbedding(entityType, id) {
        if (!AI_SERVER_URL) {
            logger.info(`Skipping embedding generation for ${entityType} ${id} because AI_SERVER_URL is not set.`);
            return;
        }

        try {
            const endpoint = `/${entityType}/${id}/generate-embedding`;
            logger.info(`Triggering embedding generation for ${entityType} ${id} at endpoint: ${endpoint}`);
            await this.client.post(endpoint);
            logger.info(`Successfully triggered embedding generation for ${entityType} ${id}.`);
        } catch (error) {
            const errorMessage = error.response ? error.response.data : error.message;
            logger.error(`Failed to trigger embedding generation for ${entityType} ${id}:`, errorMessage);
            // We don't re-throw the error to prevent the main application flow from failing
            // if the AI server is down or experiences a problem.
        }
    }
}

// Export a singleton instance of the service
module.exports = new AiService(); 