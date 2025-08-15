// auth/config.js
const config = {
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key', // Use environment variable in production
  // Shorten access token lifetime for testing refresh flow
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  bcryptSaltRounds: 10
};

module.exports = config;
