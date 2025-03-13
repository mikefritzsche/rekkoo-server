// Authentication middleware and utility functions for Express backend
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('./config');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// =============================================
// Authentication Middleware
// =============================================

/**
 * Middleware to verify JWT token and attach user to request
 */
const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authorization header missing or invalid' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    try {
      // Use a single query operation to check session and get user details
      const sessionResult = await db.query(
        `SELECT u.id, u.username, u.email, u.email_verified, 
                s.expires_at, s.last_activity_at
         FROM user_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = $1
           AND s.expires_at > NOW()
           AND u.account_locked = false`,
        [token]
      );

      if (sessionResult.rows.length === 0) {
        return res.status(401).json({ message: 'Invalid or expired session' });
      }

      // Update session last activity
      await db.query(
        `UPDATE user_sessions 
         SET last_activity_at = NOW()
         WHERE token = $1`,
        [token]
      );

      // Attach user to request
      req.user = {
        id: sessionResult.rows[0].id,
        username: sessionResult.rows[0].username,
        email: sessionResult.rows[0].email,
        emailVerified: sessionResult.rows[0].email_verified
      };

      next();
    } catch (dbError) {
      console.error('Database error during authentication:', dbError);
      return res.status(500).json({ message: 'Server error during authentication' });
    }
  } catch (jwtError) {
    console.error('JWT verification error:', jwtError);
    return res.status(401).json({ message: 'Invalid token' });
  }
};

/**
 * Middleware to check if user has required permissions
 * @param {Array} requiredPermissions - Array of permission names
 */
const checkPermissions = (requiredPermissions) => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      try {
        const permissionsResult = await db.query(
          `SELECT p.name
           FROM permissions p
           JOIN role_permissions rp ON p.id = rp.permission_id
           JOIN user_roles ur ON rp.role_id = ur.role_id
           WHERE ur.user_id = $1`,
          [req.user.id]
        );

        const userPermissions = permissionsResult.rows.map(row => row.name);

        // Check if user has all required permissions
        const hasAllPermissions = requiredPermissions.every(
          permission => userPermissions.includes(permission)
        );

        if (!hasAllPermissions) {
          return res.status(403).json({ message: 'Insufficient permissions' });
        }

        next();
      } catch (dbError) {
        console.error('Database error during permission check:', dbError);
        return res.status(500).json({ message: 'Server error during permission check' });
      }
    } catch (error) {
      console.error('Permission check error:', error);
      return res.status(500).json({ message: 'Server error' });
    }
  };
};

module.exports = { authenticateJWT, checkPermissions, authenticateToken };