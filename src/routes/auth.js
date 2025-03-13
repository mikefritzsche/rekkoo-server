// routes/auth.js

// auth.routes.js - Authentication routes for Express backend
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const {
  register,
  verifyEmail,
  login,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
  changePassword,
  oauthCallback,
  authenticateJWT,
  checkPermissions,
  refreshToken
} = require('../controllers/auth.controller');

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// =============================================
// Authentication Routes
// =============================================

/**
 * @route POST /api/auth/register
 * @desc Register a new user
 * @access Public
 */
router.post('/register', [
  body('username')
  .isString()
  .isLength({ min: 3, max: 50 })
  .withMessage('Username must be between 3 and 50 characters')
  .matches(/^[a-zA-Z0-9_.]+$/)
  .withMessage('Username can only contain letters, numbers, underscores and periods'),
  body('email')
  .isEmail()
  .withMessage('Please provide a valid email address')
  .normalizeEmail(),
  body('password')
  .isString()
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters long')
  .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  validateRequest
], register);

/**
 * @route GET /auth/verify-email/:token
 * @desc Verify user email with token
 * @access Public
 */
router.get('/verify-email/:token', verifyEmail);

/**
 * @route POST /auth/login
 * @desc Login user and get token
 * @access Public
 */
router.post('/login', [
  body('username').optional().isString(),
  body('email').optional().isEmail().normalizeEmail(),
  body('password').isString(),
  validateRequest
], login);

/**
 * @route POST /auth/logout
 * @desc Logout user and invalidate token
 * @access Private
 */
router.post('/logout', authenticateJWT, logout);

/**
 * @route GET /auth/me
 * @desc Get current user profile
 * @access Private
 */
router.get('/me', authenticateJWT, getCurrentUser);

/**
 * @route POST /auth/forgot-password
 * @desc Request password reset email
 * @access Public
 */
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
  validateRequest
], forgotPassword);

/**
 * @route POST /auth/reset-password
 * @desc Reset password with token
 * @access Public
 */
router.post('/reset-password', [
  body('token').isString(),
  body('newPassword')
  .isString()
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters long')
  .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  validateRequest
], resetPassword);

/**
 * @route POST /auth/change-password
 * @desc Change password when logged in
 * @access Private
 */
router.post('/change-password', [
  authenticateJWT,
  body('currentPassword').isString(),
  body('newPassword')
  .isString()
  .isLength({ min: 8 })
  .withMessage('Password must be at least 8 characters long')
  .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  validateRequest
], changePassword);

/**
 * @route POST /auth/oauth/:provider
 * @desc Handle OAuth authentication
 * @access Public
 */
router.post('/oauth/:provider', [
  body('providerUserId').isString(),
  body('email').optional().isEmail().normalizeEmail(),
  body('name').optional().isString(),
  body('accessToken').isString(),
  body('refreshToken').optional().isString(),
  body('expiresIn').isNumeric(),
  body('profileData').optional(),
  validateRequest
], oauthCallback);

// Updated refresh token endpoint for auth.js routes file

/**
 * @route POST /auth/refresh
 * @desc Refresh access token using refresh token
 * @access Public
 */
router.post('/refresh', [
  body('refreshToken').isString().withMessage('Refresh token is required'),
  validateRequest
], refreshToken);

// =============================================
// Admin Routes (Example)
// =============================================

/**
 * @route GET /auth/users
 * @desc Get all users (admin only)
 * @access Private/Admin
 */
router.get('/users', [
  authenticateJWT,
  checkPermissions(['admin:manage_users'])
], async (req, res) => {
  try {
    // Implementation would be in a separate controller
    res.status(200).json({ message: 'Not implemented yet' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route POST /auth/users/:id/roles
 * @desc Assign roles to user (admin only)
 * @access Private/Admin
 */
router.post('/users/:id/roles', [
  authenticateJWT,
  checkPermissions(['admin:manage_users']),
  body('roles').isArray(),
  validateRequest
], async (req, res) => {
  try {
    // Implementation would be in a separate controller
    res.status(200).json({ message: 'Not implemented yet' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// http://localhost:8000/auth/amazon/callback
const REDIRECT_URI = 'https://api.rekkoo.com/auth/amazon/callback';
app.get('/auth/amazon', (req, res) => {
  res.redirect(`https://www.amazon.com/ap/oa?client_id=${process.env.AMAZON_CLIENT_ID}&scope=profile&response_type=code&redirect_uri=${REDIRECT_URI}`);
});

// Step 2: Handle the callback with authorization code
app.get('/auth/amazon/callback', async (req, res) => {
  const code = req.query.code;

  try {
    // Exchange code for tokens
    const response = await axios.post('https://api.amazon.com/auth/o2/token', null, {
      params: {
        grant_type: 'authorization_code',
        code,
        client_id: process.env.AMAZON_CLIENT_ID,
        client_secret: process.env.AMAZON_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      }
    });

    // Store these tokens securely
    const { access_token, refresh_token, expires_in } = response.data;

    // Now you can use access_token for SP-API calls
    res.send('Authentication successful');
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error);
    res.status(500).send('Authentication failed');
  }
});

module.exports = router;


