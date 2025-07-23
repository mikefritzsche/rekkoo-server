const axios = require('axios');
const db = require('../config/db');
const { logger } = require('../utils/logger');
const aiService = require('./aiService');
const { getAiServerUrl } = require('../utils/environmentUtils');

const AI_SERVER_URL = getAiServerUrl();
const MAX_BATCH_SIZE = parseInt(process.env.EMBEDDING_BATCH_SIZE || '10', 10);
const RETRY_DELAYS = [1, 5, 15, 30, 60]; // minutes

class EmbeddingService {
    constructor() {
        this.dimension = null;
        logger.info('EmbeddingService initialized');
    }

    async _getAiServerDimensions() {
        if (this.dimension) {
            return this.dimension;
        }

        try {
            const response = await aiService.client.post('/embeddings', {
                text: 'hello'
            });
            this.dimension = response.data.dimensions;
            logger.info(`Fetched embedding dimension from AI server: ${this.dimension}`);
            return this.dimension;
        } catch (error) {
            logger.error('Failed to fetch embedding dimensions from AI server:', error);
            return 384; // Default to the model's dimension
        }
    }

    async generateEmbedding(text) {
        try {
            const response = await aiService.client.post('/embeddings', { text });
            return response.data.embedding;
        } catch (error) {
            logger.error('Failed to generate embedding from AI server:', error);
            const dims = await this._getAiServerDimensions();
            return new Array(dims).fill(0);
        }
    }

    async queueEmbeddingGeneration(entityId, entityType, metadata = {}) {
        try {
            // Standardize the entity type to the singular form used by the AI server
            const normalizedEntityType = entityType.endsWith('s') && entityType !== 'list_items' ? entityType.slice(0, -1) : entityType;

            const result = await db.query(
                `INSERT INTO embedding_queue 
                 (entity_id, entity_type, status, metadata)
                 VALUES ($1, $2, 'pending', $3)
                 ON CONFLICT (entity_id, entity_type) 
                 WHERE status NOT IN ('completed', 'processing')
                 DO UPDATE SET 
                    retry_count = 0,
                    status = 'pending',
                    next_attempt = CURRENT_TIMESTAMP,
                    metadata = EXCLUDED.metadata,
                    updated_at = CURRENT_TIMESTAMP
                 RETURNING id`,
                [entityId, normalizedEntityType, metadata]
            );
            
            logger.info(`Queued embedding generation for ${entityType}/${entityId}`);
            return result.rows[0];
        } catch (error) {
            logger.error(`Failed to queue embedding generation for ${entityType}/${entityId}:`, error);
            throw error;
        }
    }

    async processQueue(batchSize = MAX_BATCH_SIZE) {
        try {
            // Start a transaction
            await db.query('BEGIN');

            // Get batch of pending items
            const pendingItems = await db.query(
                `UPDATE embedding_queue
                 SET status = 'processing',
                     last_attempt = CURRENT_TIMESTAMP
                 WHERE id IN (
                     SELECT id
                     FROM embedding_queue
                     WHERE status = 'pending'
                     AND (next_attempt IS NULL OR next_attempt <= CURRENT_TIMESTAMP)
                     ORDER BY priority DESC, created_at ASC
                     LIMIT $1
                     FOR UPDATE SKIP LOCKED
                 )
                 RETURNING *`,
                [batchSize]
            );

            for (const item of pendingItems.rows) {
                try {
                    // Use aiService to generate the embedding
                    await aiService.generateEmbedding(
                        item.entity_type,
                        item.entity_id
                    );

                    // Mark as completed
                    await db.query(
                        `UPDATE embedding_queue
                         SET status = 'completed',
                             processed_at = CURRENT_TIMESTAMP,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $1`,
                        [item.id]
                    );

                    logger.info(`Successfully generated embedding for ${item.entity_type}/${item.entity_id}`);
                } catch (error) {
                    const retryCount = item.retry_count + 1;
                    const delayIndex = Math.min(retryCount - 1, RETRY_DELAYS.length - 1);
                    const nextAttemptDelay = RETRY_DELAYS[delayIndex];

                    await db.query(
                        `UPDATE embedding_queue
                         SET status = $1,
                             retry_count = $2,
                             next_attempt = CURRENT_TIMESTAMP + interval '${nextAttemptDelay} minutes',
                             error_message = $3,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $4`,
                        [
                            retryCount >= item.max_retries ? 'failed' : 'pending',
                            retryCount,
                            error.message,
                            item.id
                        ]
                    );

                    logger.error(`Failed to generate embedding for ${item.entity_type}/${item.entity_id}:`, error);
                }
            }

            await db.query('COMMIT');
            return pendingItems.rows.length;
        } catch (error) {
            await db.query('ROLLBACK');
            logger.error('Error processing embedding queue:', error);
            throw error;
        }
    }

    async getQueueStats() {
        try {
            const stats = await db.query(`
                SELECT 
                    status,
                    COUNT(*) as count,
                    MAX(last_attempt) as latest_attempt,
                    COUNT(CASE WHEN retry_count > 0 THEN 1 END) as retried_count
                FROM embedding_queue
                GROUP BY status
            `);
            return stats.rows;
        } catch (error) {
            logger.error('Failed to get queue stats:', error);
            throw error;
        }
    }

    // Keep existing methods for backward compatibility and direct operations
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

            // Updated to filter by entity_type
            if (filter.entity_type) {
                filterConditions = `AND entity_type = $${paramCounter++}`;
                filterValues.push(filter.entity_type);
            }

            // This query is now much more complex to handle multiple entity types.
            // It uses a Common Table Expression (CTE) to find similar embeddings
            // and then joins with the respective tables to get the details.
            const query = `
                WITH similar_embeddings AS (
                    SELECT
                        related_entity_id,
                        entity_type,
                        1 - (embedding <=> $1) as similarity
                    FROM embeddings
                    WHERE 1 - (embedding <=> $1) > $3
                    ${filterConditions}
                    ORDER BY similarity DESC
                    LIMIT $2
                )
                SELECT 
                    se.similarity,
                    se.entity_type,
                    se.related_entity_id,
                    li.title,
                    li.description,
                    li.id
                FROM similar_embeddings se
                JOIN list_items li ON se.related_entity_id = li.id AND se.entity_type = 'list_item'
                UNION ALL
                SELECT
                    se.similarity,
                    se.entity_type,
                    se.related_entity_id,
                    l.title,
                    l.description,
                    l.id
                FROM similar_embeddings se
                JOIN lists l ON se.related_entity_id = l.id AND se.entity_type = 'list'
                UNION ALL
                SELECT
                    se.similarity,
                    se.entity_type,
                    se.related_entity_id,
                    u.username as title,
                    u.full_name as description,
                    u.id
                FROM similar_embeddings se
                JOIN users u ON se.related_entity_id = u.id AND se.entity_type = 'user'
                ORDER BY similarity DESC
            `;

            const result = await db.query(query, filterValues);
            return result.rows.map(r => ({
                id: r.id,
                content: r.title,
                metadata: {
                    entity_type: r.entity_type,
                    description: r.description,
                    related_entity_id: r.related_entity_id
                },
                similarity: r.similarity
            }));
        } catch (error) {
            logger.error('Failed to find similar embeddings:', error);
            throw new Error('Failed to find similar embeddings');
        }
    }

    async getStats() {
        const dims = await this._getAiServerDimensions();
        return {
            modelLoaded: true,
            isLoading: false,
            dimension: dims
        };
    }

    /**
     * Soft-delete or down-weight an embedding.
     * @param {string} entityId
     * @param {string} entityType
     * @param {number} weight  A value between 0 and 1. Default 0.2
     */
    async deactivateEmbedding(entityId, entityType, weight = 0.2) {
        try {
            await db.query(
                `UPDATE embeddings
                 SET deleted_at = CURRENT_TIMESTAMP,
                     weight      = $3,
                     updated_at  = CURRENT_TIMESTAMP
                 WHERE related_entity_id = $1
                   AND entity_type = $2`,
                [entityId, entityType, weight]
            );
            logger.info(`Embedding for ${entityType}/${entityId} marked inactive (weight=${weight})`);
        } catch (error) {
            logger.error(`Failed to deactivate embedding for ${entityType}/${entityId}:`, error);
        }
    }

    /**
     * Persist a search query's embedding for personalization/analytics.
     * Non-blocking: caller may ignore return value.
     */
    async storeSearchEmbedding(userId, queryText) {
        if (!queryText || queryText.trim().length < 2) return;
        try {
            const embedding = await this.generateEmbedding(queryText.trim());
            await db.query(
                `INSERT INTO search_embeddings (user_id, raw_query, embedding)
                 VALUES ($1, $2, $3)`,
                [userId || null, queryText.trim(), `[${embedding.join(',')}]`]
            );
            logger.debug(`Stored search embedding (len=${queryText.length}) for user ${userId || 'anon'}`);
        } catch (err) {
            logger.error('Failed to store search embedding:', err);
        }
    }

    async getEmbeddingDebugInfo() {
        try {
            const totalCountQuery = db.query('SELECT COUNT(*) FROM embeddings');
            const countByTypeQuery = db.query(`
                SELECT entity_type, COUNT(*)
                FROM embeddings
                GROUP BY entity_type
            `);
            const sampleItemsQuery = db.query(`
                SELECT e.entity_type, e.similarity, l.title, l.description
                FROM (
                    SELECT *, 1 - (embedding <=> (SELECT embedding FROM embeddings ORDER BY random() LIMIT 1)) as similarity
                    FROM embeddings
                    ORDER BY similarity DESC
                    LIMIT 10
                ) e
                LEFT JOIN list_items l ON e.related_entity_id = l.id AND e.entity_type = 'list_item'
                WHERE l.title IS NOT NULL
                LIMIT 5
            `);

            const [totalCountResult, countByTypeResult, sampleItemsResult] = await Promise.all([
                totalCountQuery,
                countByTypeQuery,
                sampleItemsQuery
            ]);

            return {
                totalCount: parseInt(totalCountResult.rows[0].count, 10),
                countByType: countByTypeResult.rows,
                sampleItems: sampleItemsResult.rows,
            };
        } catch (error) {
            logger.error('Failed to get embedding debug info:', error);
            throw new Error('Failed to get embedding debug info');
        }
    }
}

module.exports = new EmbeddingService(); 