const { logger } = require('./logger');

/**
 * Get the appropriate AI server URL based on the current environment
 * @returns {string} The AI server URL
 */
function getAiServerUrl() {
    // First check if we're using the local/remote environment selector
    const aiServerEnv = process.env.AI_SERVER_ENV;
    if (aiServerEnv) {
        const localUrl = process.env.AI_SERVER_URL_LOCAL;
        const remoteUrl = process.env.AI_SERVER_URL_REMOTE;
        
        if (aiServerEnv === 'local' && localUrl) {
            logger.info(`Using local AI server URL: ${localUrl}`);
            return localUrl;
        }
        if (aiServerEnv === 'remote' && remoteUrl) {
            logger.info(`Using remote AI server URL: ${remoteUrl}`);
            return remoteUrl;
        }
    }

    // Fall back to legacy environment-based URLs if no explicit configuration
    const env = process.env.NODE_ENV || 'development';
    const envUrl = process.env.AI_SERVER_URL;

    if (envUrl) {
        logger.info(`Using AI server URL from environment: ${envUrl}`);
        return envUrl;
    }

    switch (env) {
        case 'production':
            return 'https://ai.rekkoo.com';
        case 'staging':
            return 'https://ai-staging.rekkoo.com';
        case 'development':
        default:
            return process.env.AI_SERVER_URL_LOCAL || 'http://ai-server:8000';
    }
}

/**
 * Check if the current environment is production
 * @returns {boolean}
 */
function isProduction() {
    return process.env.NODE_ENV === 'production';
}

/**
 * Check if the current environment is development
 * @returns {boolean}
 */
function isDevelopment() {
    return !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
}

/**
 * Check if the current environment is staging
 * @returns {boolean}
 */
function isStaging() {
    return process.env.NODE_ENV === 'staging';
}

module.exports = {
    getAiServerUrl,
    isProduction,
    isDevelopment,
    isStaging
}; 