// auth/controllers.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { jwtSecret, bcryptSaltRounds } = require('./config');

const authController = {
  async register(req, res) {
    const { email, username, password } = req.body;

    try {
      // Check if user already exists
      const userCheck = await db.query(
        'SELECT id FROM users WHERE email = $1 OR username = $2',
        [email, username]
      );

      if (userCheck.rows.length > 0) {
        return res.status(400).json({
          error: 'User with this email or username already exists'
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, bcryptSaltRounds);

      // Insert new user
      const result = await db.query(
        `INSERT INTO users (email, username, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, username, created_at`,
        [email, username, passwordHash]
      );

      // Create default user profile
      await db.query(
        `INSERT INTO user_profiles (user_id, display_name)
         VALUES ($1, $2)`,
        [result.rows[0].id, username]
      );

      // Generate JWT token
      const token = jwt.sign(
        {
          id: result.rows[0].id,
          email: result.rows[0].email,
          username: result.rows[0].username
        },
        jwtSecret,
        { expiresIn: '24h' }
      );

      res.status(201).json({
        message: 'Registration successful',
        user: {
          id: result.rows[0].id,
          email: result.rows[0].email,
          username: result.rows[0].username
        },
        token
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async login(req, res) {
    const { email, password } = req.body;

    try {
      // Get user
      const result = await db.query(
        'SELECT id, email, username, password_hash FROM users WHERE email = $1',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials - no rows auth/controllers' });
      }

      const user = result.rows[0];

      // Check password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials - password  auth/controllers' });
      }

      // Update last login
      await db.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );

      // Generate token
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          username: user.username
        },
        jwtSecret,
        { expiresIn: '24h' }
      );

      res.json({
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          username: user.username
        },
        token
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getProfile(req, res) {
    try {
      const result = await db.query(
        `SELECT u.email, u.username, u.created_at, 
                up.display_name, up.avatar_url, up.bio
         FROM users u
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ profile: result.rows[0] });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

module.exports = authController;
