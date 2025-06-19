const axios = require('axios');
const { logger } = require('../utils/logger');
const { getAiServerUrl } = require('../utils/environmentUtils');

/**
 * A client for interacting with the AI server.
 */
class AiService {
    constructor() {
        this.initializeClient();
    }

    /**
     * Initialize or reinitialize the axios client with the current AI server URL
     */
    initializeClient() {
        const aiServerUrl = getAiServerUrl();
        if (!aiServerUrl) {
            logger.warn('AI server URL is not available. AI service will not be functional.');
            return;
        }

        this.client = axios.create({
            baseURL: aiServerUrl,
            timeout: 10000, // 10 second timeout
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Host': new URL(aiServerUrl).host
            },
            maxRedirects: 5 // Allow redirects
        });
        logger.info(`AiService initialized with server URL: ${aiServerUrl}`);
    }

    /**
     * Check if the AI server is healthy and accessible
     * @returns {Promise<boolean>} True if both service and database are healthy
     */
    async checkHealth() {
        if (!this.client) {
            this.initializeClient();
            if (!this.client) {
                return false;
            }
        }

        try {
            // Check basic service health
            const serviceHealth = await this.client.get('/health');
            // logger.info('AI Server health check response:', serviceHealth.data);

            // Check database health
            const dbHealth = await this.client.get('/database/health');
            // logger.info('AI Server database health check response:', dbHealth.data);

            return serviceHealth.data.status === 'healthy' && dbHealth.data.status === 'connected';
        } catch (error) {
            const errorMessage = error.response ? error.response.data : error.message;
            logger.error('AI Server health check failed:', errorMessage);
            return false;
        }
    }

    /**
     * Triggers embedding generation for a given entity type and ID.
     * @param {string} entityType - The type of entity (e.g., 'list-items', 'lists', 'users').
     * @param {string} id - The UUID of the entity.
     * @returns {Promise<void>}
     * @throws {Error} If the request fails
     */
    async generateEmbedding(entityType, id) {
        if (!this.client) {
            this.initializeClient();
            if (!this.client) {
                throw new Error('AI service is not properly configured - missing server URL');
            }
        }

        try {
            // First check AI server health
            const isHealthy = await this.checkHealth();
            if (!isHealthy) {
                throw new Error('AI Server health check failed - service may be unavailable');
            }

            const endpoint = `/${entityType}/${id}/generate-embedding`;
            logger.info(`Triggering embedding generation for ${entityType} ${id} at endpoint: ${endpoint}`);
            
            const response = await this.client.post(endpoint);
            logger.info(`Successfully triggered embedding generation for ${entityType} ${id}. Response:`, response.data);
            return response.data;
        } catch (error) {
            const errorMessage = error.response ? error.response.data : error.message;
            const config = error.config ? {
                baseURL: error.config.baseURL,
                url: error.config.url,
                method: error.config.method,
                headers: error.config.headers
            } : 'No config available';
            logger.error(`Failed to trigger embedding generation for ${entityType} ${id}. Error:`, errorMessage);
            logger.error(`Request config:`, config);
            
            // Re-throw the error so it can be handled by the caller
            throw new Error(`Failed to generate embedding: ${errorMessage}`);
        }
    }
}

// Export a singleton instance of the service
module.exports = new AiService(); 