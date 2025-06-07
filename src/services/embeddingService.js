const axios = require('axios');
const db = require('../config/db');
const { logger } = require('../utils/logger');

const AI_SERVER_URL = process.env.AI_SERVER_URL || 'http://ai-server:8000';

class EmbeddingService {
    constructor() {
        this.dimension = null; // Will be fetched from AI server
    }

    async #getAiServerDimensions() {
        if (this.dimension) {
            return this.dimension;
        }

        try {
            // The AI server's /embeddings endpoint returns the dimension.
            // We can send a dummy request to get it.
            const response = await axios.post(`${AI_SERVER_URL}/embeddings`, {
                text: 'hello'
            });
            this.dimension = response.data.dimensions;
            logger.info(`Fetched embedding dimension from AI server: ${this.dimension}`);
            return this.dimension;
        } catch (error) {
            logger.error('Failed to fetch embedding dimensions from AI server:', error);
            // Default to a common dimension if fetching fails
            return 100;
        }
    }

    async generateEmbedding(text) {
        try {
            const response = await axios.post(`${AI_SERVER_URL}/embeddings`, { text });
            return response.data.embedding;
        } catch (error) {
            logger.error('Failed to generate embedding from AI server:', error);
            const dims = await this.#getAiServerDimensions();
            return new Array(dims).fill(0);
        }
    }

    async storeEmbedding(content, metadata = {}) {
        try {
            const embedding = await this.generateEmbedding(content);
            
            const result = await db.query(
                `INSERT INTO embeddings (content, embedding, metadata)
                 VALUES ($1, $2, $3)
                 RETURNING id, content, metadata, created_at`,
                [content, `[${embedding.join(',')}]`, metadata]
            );

            return result.rows[0];
        } catch (error) {
            logger.error('Failed to store embedding:', error);
            throw new Error('Failed to store embedding');
        }
    }

    async findSimilar(text, { limit = 5, threshold = 0.7, filter = {} } = {}) {
        try {
            const queryEmbedding = await this.generateEmbedding(text);

            let filterConditions = '';
            const filterValues = [`[${queryEmbedding.join(',')}]`, limit, threshold];
            let paramCounter = 4;

            if (Object.keys(filter).length > 0) {
                filterConditions = 'AND ' + Object.entries(filter)
                    .map(([key, value]) => {
                        filterValues.push(value);
                        return `metadata->>'${key}' = $${paramCounter++}`;
                    })
                    .join(' AND ');
            }

            const query = `
                SELECT 
                    id,
                    content,
                    metadata,
                    1 - (embedding <=> $1) as similarity,
                    created_at
                FROM embeddings
                WHERE 1 - (embedding <=> $1) > $3
                ${filterConditions}
                ORDER BY similarity DESC
                LIMIT $2
            `;

            const result = await db.query(query, filterValues);
            return result.rows;
        } catch (error) {
            logger.error('Failed to find similar embeddings:', error);
            throw new Error('Failed to find similar embeddings');
        }
    }

    async getStats() {
        const dims = await this.#getAiServerDimensions();
        return {
            modelLoaded: true, // Delegated to AI server
            isLoading: false,
            dimension: dims
        };
    }
}

module.exports = new EmbeddingService(); 