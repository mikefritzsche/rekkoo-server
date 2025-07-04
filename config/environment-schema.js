/**
 * Environment Configuration Schema
 * Defines all environment variables with validation, defaults, and documentation
 */

const environmentSchema = {
  // Server Configuration
  PORT: {
    type: 'number',
    default: 3100,
    required: true,
    description: 'Server port number'
  },
  HOST: {
    type: 'string',
    default: 'localhost',
    description: 'Server host'
  },
  NODE_ENV: {
    type: 'string',
    enum: ['development', 'staging', 'production'],
    default: 'development',
    required: true
  },

  // Database Configuration
  DB_HOST: {
    type: 'string',
    required: true,
    description: 'Database host'
  },
  DB_PORT: {
    type: 'number',
    default: 5432,
    description: 'Database port'
  },
  DB_NAME: {
    type: 'string',
    required: true,
    description: 'Database name'
  },
  DB_USER: {
    type: 'string',
    required: true,
    description: 'Database username'
  },
  DB_PASSWORD: {
    type: 'string',
    required: true,
    sensitive: true,
    description: 'Database password'
  },

  // Apple OAuth Configuration
  APPLE_CLIENT_ID: {
    type: 'string',
    required: ['production', 'staging'],
    description: 'Apple OAuth Client ID (Service ID)'
  },
  APPLE_TEAM_ID: {
    type: 'string',
    required: ['production', 'staging'],
    description: 'Apple Developer Team ID'
  },
  APPLE_KEY_ID: {
    type: 'string',
    required: ['production', 'staging'],
    description: 'Apple OAuth Key ID'
  },
  APPLE_PRIVATE_KEY: {
    type: 'string',
    required: ['production', 'staging'],
    sensitive: true,
    multiline: true,
    description: 'Apple OAuth Private Key (P8 format)'
  },
  APPLE_CALLBACK_URL: {
    type: 'string',
    required: ['production', 'staging'],
    description: 'Apple OAuth callback URL'
  },

  // Google OAuth Configuration
  GOOGLE_CLIENT_ID: {
    type: 'string',
    required: ['development', 'production', 'staging'],
    description: 'Google OAuth Client ID'
  },
  GOOGLE_CLIENT_SECRET: {
    type: 'string',
    required: ['development', 'production', 'staging'],
    sensitive: true,
    description: 'Google OAuth Client Secret'
  },
  GOOGLE_CALLBACK_URL: {
    type: 'string',
    required: ['development', 'production', 'staging'],
    description: 'Google OAuth callback URL'
  },

  // AI Service Configuration
  AI_SERVER_URL_LOCAL: {
    type: 'string',
    default: 'http://ai-server:8000',
    description: 'Local AI server URL for Docker'
  },
  AI_SERVER_URL_REMOTE: {
    type: 'string',
    required: ['production', 'staging'],
    description: 'Remote AI server URL'
  },
  AI_SERVER_ENV: {
    type: 'string',
    enum: ['local', 'development', 'staging', 'production'],
    default: 'local',
    description: 'AI server environment'
  },

  // Email Configuration
  MJ_APIKEY_PUBLIC: {
    type: 'string',
    required: ['production'],
    description: 'Mailjet public API key'
  },
  MJ_APIKEY_PRIVATE: {
    type: 'string',
    required: ['production'],
    sensitive: true,
    description: 'Mailjet private API key'
  },

  // Client URLs
  CLIENT_URL_APP: {
    type: 'string',
    default: 'http://localhost:8081',
    description: 'Mobile app client URL (development: http://localhost:8081, production: https://app.rekkoo.com)'
  },
  CLIENT_URL_ADMIN: {
    type: 'string',
    default: 'https://admin-dev.rekkoo.com',
    description: 'Admin client URL (development: https://admin-dev.rekkoo.com, production: https://admin.rekkoo.com)'
  },

  // Security
  JWT_SECRET: {
    type: 'string',
    required: true,
    sensitive: true,
    minLength: 32,
    description: 'JWT signing secret'
  }
};

module.exports = environmentSchema; 