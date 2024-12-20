// auth/config.js
const config = {
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key', // Use environment variable in production
  jwtExpiresIn: '24h',
  bcryptSaltRounds: 10
};

module.exports = config;

// auth/middleware.js
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

module.exports = { authenticateToken };
