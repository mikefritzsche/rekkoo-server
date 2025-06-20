// auth.routes.js - Authentication routes for Express backend
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');
const { body, validationResult } = require('express-validator');
const AuthController = require('../controllers/AuthController');
const { authenticateJWT, checkPermissions } = require('../auth/middleware');
const passport = require('passport');
require('../auth/passport');

const {
  AMAZON_SELLER_ID,
  AMAZON_REFRESH_TOKEN,
  AMAZON_ACCESS_TOKEN,
  AMAZON_SANDBOX_CLIENT_ID,
  AMAZON_SANDBOX_CLIENT_SECRET,
  AMAZON_ACCESS_KEY,
  AMAZON_SECRET_KEY,
  AMAZON_ROLE_ARN,
  AMAZON_MARKETPLACE_ID,
  AMAZON_ASSOCIATE_ID,
  AMAZON_APP_ID,
  AMAZON_CLIENT_ID,
  AMAZON_CLIENT_SECRET,
  APP_URL,
} = process.env

const REDIRECT_URI = 'https://api.rekkoo.com/auth/amazon/spapi-callback';
const amazonAuthUrl = 'https://sellercentral.amazon.com/apps/authorize/consent';
const amazonTokenUrl = 'https://api.amazon.com/auth/o2/token';

// Store state for CSRF protection
const stateMap = new Map();

// Generate a random state for CSRF protection
const generateState = () => {
  const state = crypto.randomBytes(16).toString('hex');
  // Store state with expiration (5 minutes)
  stateMap.set(state, Date.now() + 300000); // 5 min expiration
  return state;
};

// Clean expired states
const cleanupStates = () => {
  const now = Date.now();
  for (const [state, expiry] of stateMap.entries()) {
    if (now > expiry) {
      stateMap.delete(state);
    }
  }
};

// Schedule cleanup every 10 minutes
setInterval(cleanupStates, 600000);

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

router.get('/amazon/spapi-authorize', (req, res) => {
  const state = generateState();

  const queryParams = {
    application_id: AMAZON_APP_ID,
    state,
    redirect_uri: REDIRECT_URI,
    version: 'beta',
    scope: 'sellingpartnerapi::notifications'
  };

  const authorizationUrl = `${amazonAuthUrl}?${qs.stringify(queryParams)}`;
  console.log(`auth url: `, authorizationUrl)

  // Redirect user to Amazon's authorization page
  res.redirect(authorizationUrl);
});

// Handle the OAuth callback from Amazon
router.get('/amazon/spapi-callback', async (req, res) => {
  const { state, spapi_oauth_code, selling_partner_id } = req.query;
  console.log(`amazon spapi auth callback: `, {state, spapi_oauth_code, selling_partner_id});

  // Verify state to prevent CSRF attacks
  if (!state || !stateMap.has(state)) {
    return res.status(400).send('Invalid state parameter. Possible CSRF attack or expired session.');
  }

  // Remove the used state
  stateMap.delete(state);

  if (!spapi_oauth_code) {
    return res.status(400).send('Authorization code not received from Amazon.');
  }

  try {
    // Exchange the authorization code for access tokens
    const tokenResponse = await axios.post(amazonTokenUrl, qs.stringify({
      grant_type: 'authorization_code',
      code: spapi_oauth_code,
      redirect_uri: REDIRECT_URI,
      client_id: AMAZON_CLIENT_ID,
      client_secret: AMAZON_CLIENT_SECRET,
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    console.log(`access/refresh tokens: `, [access_token, refresh_token]);
    console.log(`expires in: `, expires_in)

    // Store tokens in database or session (implementation depends on your app architecture)
    // For this example, we'll just create a user session
    req.session.spApiTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
      selling_partner_id
    };

    // Redirect to dashboard or confirmation page
    res.redirect(`${APP_URL}/dashboard`);

  } catch (error) {
    console.error('Error exchanging authorization code for tokens:', error.response?.data || error.message);
    res.status(500).send('Failed to complete OAuth process. Please try again.');
  }
});

// Refresh access token when it expires
router.get('/refresh-token', async (req, res) => {
  // Check if user has refresh token
  if (!req.session.spApiTokens || !req.session.spApiTokens.refresh_token) {
    return res.status(401).json({ error: 'No refresh token available. Please authenticate again.' });
  }

  try {
    const refreshResponse = await axios.post(amazonTokenUrl, qs.stringify({
      grant_type: 'refresh_token',
      refresh_token: req.session.spApiTokens.refresh_token,
      client_id: AMAZON_CLIENT_ID,
      client_secret: AMAZON_CLIENT_SECRET,
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token, expires_in } = refreshResponse.data;

    console.log(`refresh access/refresh token: `, [access_token, refresh_token])
    console.log(`refresh expires in: `, expires_in)

    // Update session with new tokens
    req.session.spApiTokens = {
      ...req.session.spApiTokens,
      access_token,
      // Amazon might not return a new refresh token every time
      refresh_token: refresh_token || req.session.spApiTokens.refresh_token,
      expires_at: Date.now() + expires_in * 1000
    };

    res.json({ success: true, expires_in });

  } catch (error) {
    console.error('Error refreshing token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to refresh access token.' });
  }
});

// https://www.amazon.com/ap/oa?client_id=amzn1.application-oa2-client.4ba4635cf6c941ee9ba658809a50d0c6&scope=profile:user_id%20profile:email%20profile:name%20profile:postal_code&response_type=code&redirect_uri=https%3A%2F%2Fapi.rekkoo.com%2Fauth%2Famazon%2Fcallback

router.get('/amazon', (req, res) => {
  const authUrl = `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${process.env.AMAZON_CLIENT_ID}&state=state&version=beta`;
  res.redirect(authUrl);
});

// Step 2: Handle the callback with authorization code
router.get('/amazon/callback', async (req, res) => {
  const code = req.query.code;

  try {
    // Exchange code for tokens
    const response = await axios.post('https://api.amazon.com/auth/o2/token', null, {
      params: {
        grant_type: 'authorization_code',
        code,
        client_id: AMAZON_CLIENT_ID,
        client_secret: AMAZON_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      }
    });

    // Store these tokens securely
    const { access_token, refresh_token, expires_in } = response.data;

    console.log(`Code: `, code)
    console.log('Access Token:', access_token);
    console.log('Refresh Token:', refresh_token);
    console.log('Expires In:', expires_in);

    // Now you can use access_token for SP-API calls
    res.send('Authentication successful');
  } catch (error) {
    console.error('OAuth error:', error.response?.data || error);
    res.status(500).send('Authentication failed');
  }
});

router.get('/amazon/spapi/refresh-token', async (req, res) => {
  const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

  try {
    const tokenResponse = await axios.post('https://api.amazon.com/auth/o2/token', null, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: REFRESH_TOKEN,
        client_id: process.env.AMAZON_CLIENT_ID,
        client_secret: process.env.AMAZON_CLIENT_SECRET,
      },
    });

    const { access_token } = tokenResponse.data;

    // Use the new access token for API requests
    console.log('New Access Token:', access_token);

    res.send('Token refreshed successfully!');
  } catch (error) {
    console.error('Error refreshing token:', error.response?.data || error.message);
    res.status(500).send('Error refreshing token');
  }
});

// Check authentication status
router.get('/amazon/status', (req, res) => {
  if (req.session.spApiTokens && req.session.spApiTokens.access_token) {
    // Check if token is expired
    const isExpired = Date.now() > req.session.spApiTokens.expires_at;

    res.json({
      authenticated: true,
      sellingPartnerId: req.session.spApiTokens.selling_partner_id,
      tokenExpired: isExpired
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout - clear tokens
router.get('/logout', (req, res) => {
  if (req.session.spApiTokens) {
    delete req.session.spApiTokens;
  }

  res.json({ success: true, message: 'Logged out successfully' });
});

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
], AuthController.register);

/**
 * @route GET /auth/verify-email/:token
 * @desc Verify user email with token
 * @access Public
 */
router.get('/verify-email/:token', AuthController.verifyEmail);

/**
 * @route POST /auth/resend-verification
 * @desc Resend verification email
 * @access Public
 */
router.post('/resend-verification', [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  validateRequest
], AuthController.resendVerification);

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
], AuthController.login);

/**
 * @route POST /auth/logout
 * @desc Logout user and invalidate token
 * @access Private
 */
router.post('/logout', authenticateJWT, AuthController.logout);

/**
 * @route GET /auth/me
 * @desc Get current user profile
 * @access Private
 */
router.get('/me', authenticateJWT, AuthController.getCurrentUser);

/**
 * @route POST /auth/forgot-password
 * @desc Request password reset email
 * @access Public
 */
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
  validateRequest
], AuthController.forgotPassword);

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
], AuthController.resetPassword);

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
], AuthController.changePassword);

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
], AuthController.oauthCallback);

// Updated refresh token endpoint for auth.js routes file

/**
 * @route POST /auth/refresh
 * @desc Refresh access token using refresh token
 * @access Public
 */
router.post('/refresh', [
  body('refreshToken').isString().withMessage('Refresh token is required'),
  validateRequest
], AuthController.refreshToken);

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

// <<< NEW: Add Auth Check Endpoint >>>
// Uses authenticateJWT middleware first, then sends 200 OK if successful
router.get('/check', authenticateJWT, (req, res) => {
  // If authenticateJWT middleware passes (calls next()), the token is valid.
  // req.user should be populated by the middleware.
  console.log(`Auth check successful for user: ${req.user?.id}`);
  res.status(200).json({ message: 'Session valid', userId: req.user?.id });
});

// ===================== Passport OAuth Routes =====================
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// Google
router.get('/oauth/google', (req, res, next) => {
  const target = req.query.redirect || 'admin';
  if (req.session) {
    req.session.oauthRedirect = target;
    console.log('[Google OAuth] Stored redirect in session:', req.sessionID, target);
  }
  passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account', state: target })(req, res, next);
});
router.get(
  '/oauth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${CLIENT_URL}/login?oauth=google&error=1` }),
  AuthController.passportCallback
);

// GitHub
router.get('/oauth/github', passport.authenticate('github', { scope: ['user:email'] }));
router.get(
  '/oauth/github/callback',
  passport.authenticate('github', { session: false, failureRedirect: `${CLIENT_URL}/login?oauth=github&error=1` }),
  AuthController.passportCallback
);

// Apple
router.get('/oauth/apple', (req, res, next) => {
  const target = req.query.redirect || 'admin';
  if (req.session) {
    req.session.oauthRedirect = target;
    console.log('[Apple OAuth] Stored redirect in session:', req.sessionID, target);
  }
  passport.authenticate('apple', { scope: ['name', 'email'], state: target })(req, res, next);
});
router.get(
  '/oauth/apple/callback',
  passport.authenticate('apple', { session: false, failureRedirect: `${CLIENT_URL}/login?oauth=apple&error=1` }),
  AuthController.passportCallback
);

// Mobile installed-app OAuth token exchange
router.post('/oauth/mobile/:provider', AuthController.mobileOauth);

module.exports = router;


