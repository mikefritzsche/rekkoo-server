const { logger } = require('../utils/logger');
const EmbeddingService = require('../services/embeddingService');
const { isDevelopment } = require('../utils/environmentUtils');

class EmbeddingQueueWorker {
    constructor(options = {}) {
        this.isRunning = false;
        this.processingInterval = options.processingInterval || 5000; // 5 seconds
        this.batchSize = options.batchSize || 10;
        this.maxRetries = options.maxRetries || 3;
    }

    async start() {
        if (this.isRunning) {
            logger.warn('EmbeddingQueueWorker is already running');
            return;
        }

        this.isRunning = true;
        logger.info('Starting EmbeddingQueueWorker');
        this._scheduleNextRun();
    }

    stop() {
        logger.info('Stopping EmbeddingQueueWorker');
        this.isRunning = false;
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    async _processQueue() {
        try {
            const processedCount = await EmbeddingService.processQueue(this.batchSize);
            if (processedCount > 0) {
                logger.info(`Processed ${processedCount} items from embedding queue`);
            }

            // In development, log queue stats periodically
            if (isDevelopment()) {
                const stats = await EmbeddingService.getQueueStats();
                logger.debug('Embedding queue stats:', stats);
            }
        } catch (error) {
            logger.error('Error processing embedding queue:', error);
        }
    }

    _scheduleNextRun() {
        if (!this.isRunning) return;

        this._processQueue()
            .finally(() => {
                if (this.isRunning) {
                    this.timeout = setTimeout(() => this._scheduleNextRun(), this.processingInterval);
                }
            });
    }
}

// Export the class and a singleton instance
module.exports = {
    EmbeddingQueueWorker,
    worker: new EmbeddingQueueWorker()
}; 