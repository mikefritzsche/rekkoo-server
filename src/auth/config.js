// auth/config.js
const config = {
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key', // Use environment variable in production
  jwtExpiresIn: '24h',
  bcryptSaltRounds: 10
};

module.exports = config;
