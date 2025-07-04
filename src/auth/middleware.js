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
      // First get user details from token
      const userResult = await db.query(
        `SELECT id, username, email, email_verified, admin_locked, deleted_at
         FROM users 
         WHERE id = $1
           AND account_locked = false
           AND admin_locked = false
           AND deleted_at IS NULL`,
        [decoded.userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(403).json({ message: 'Account unavailable (locked, suspended or deleted)' });
      }

      // Check if session exists (optional)
      const sessionResult = await db.query(
        `SELECT expires_at FROM user_sessions 
         WHERE token = $1 AND expires_at > NOW()`,
        [token]
      );

      // Update session last activity if exists
      if (sessionResult.rows.length > 0) {
        await db.query(
          `UPDATE user_sessions SET last_activity_at = NOW() WHERE token = $1`,
          [token]
        );
      }

      // Attach user to request
      req.user = {
        id: userResult.rows[0].id,
        username: userResult.rows[0].username,
        email: userResult.rows[0].email,
        emailVerified: userResult.rows[0].email_verified
      };

      next();
    } catch (dbError) {
      console.error('Database error during authentication:', dbError);
      return res.status(500).json({ message: 'Server error during authentication' });
    }
  } catch (jwtError) {
    // console.error('JWT verification error:', jwtError);
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

const requireRole = (roleName) => checkPermissions([] , roleName); // adjust as needed

module.exports = { authenticateJWT, checkPermissions, authenticateToken };
