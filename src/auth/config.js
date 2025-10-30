// auth/config.js
const allowSessionExpiry = process.env.ALLOW_SESSION_EXPIRY === 'true';

const envJwtExpiresIn = process.env.JWT_EXPIRES_IN;

const config = {
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key', // Use environment variable in production
  // Use extremely long-lived tokens when session expiry is disabled
  jwtExpiresIn: allowSessionExpiry
    ? (envJwtExpiresIn || '24h')
    : '36500d',
  bcryptSaltRounds: 10
};

module.exports = config;
