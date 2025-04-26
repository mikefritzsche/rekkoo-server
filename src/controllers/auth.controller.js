// =============================================
// Authentication Routes
// =============================================
const db = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const saltRounds = 12;
const { authenticateJWT, checkPermissions } = require('../auth/middleware');
const Mailjet = require('node-mailjet');
const emailService = require('../services/emailService');
const { validationResult } = require('express-validator');

const mailjet = new Mailjet({
  apiKey: process.env.MJ_APIKEY_PUBLIC,
  apiSecret: process.env.MJ_APIKEY_PRIVATE
});

// Helper function to generate a refresh token
const generateRefreshToken = () => {
  return crypto.randomBytes(40).toString('hex');
};

/**
 * Register a new user
 * @route POST /auth/register
 */
const register = async (req, res) => {
  // Your existing register implementation
  try {
    const { username, email, password } = req.body;

    const result = await db.transaction(async (client) => {
      // Check if user already exists
      const userExists = await client.query(
        `SELECT id FROM users WHERE username = $1 OR email = $2`,
        [username, email]
      );

      if (userExists.rows.length > 0) {
        throw { status: 409, message: 'Username or email already exists' };
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Generate verification token
      const verificationToken = uuidv4();

      // Create user
      const newUser = await client.query(
        `INSERT INTO users (
           username, email, password_hash, verification_token, 
           verification_token_expires_at, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours', NOW(), NOW())
         RETURNING id`,
        [username, email, passwordHash, verificationToken]
      );

      const userId = newUser.rows[0].id;

      // Assign default user role
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))`,
        [userId]
      );

      return { userId, verificationToken };
    });

    // TODO: Send verification email with the token

    return res.status(201).json({
      message: 'User registered successfully. Please check your email to verify your account.',
      userId: result.userId
    });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during registration' });
  }
};

/**
 * Verify email address
 * @route GET /auth/verify-email/:token
 */
const verifyEmail = async (req, res) => {
  // Your existing verifyEmail implementation
  try {
    const { token } = req.params;

    const result = await db.query(
      `UPDATE users 
       SET email_verified = true,
           verification_token = NULL,
           verification_token_expires_at = NULL,
           updated_at = NOW()
       WHERE verification_token = $1
         AND verification_token_expires_at > NOW()
       RETURNING id`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired verification token' });
    }

    return res.status(200).json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('Email verification error:', error);
    return res.status(500).json({ message: 'Server error during email verification' });
  }
};

/**
 * Login user
 * @route POST /auth/login
 */
const login = async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const identifier = username || email;

    const result = await db.transaction(async (client) => {
      // Get user
      const userResult = await client.query(
        `SELECT id, username, email, password_hash, email_verified, account_locked,
                failed_login_attempts, lockout_until
         FROM users 
         WHERE (username = $1 OR email = $1)`,
        [identifier]
      );

      if (userResult.rows.length === 0) {
        throw { status: 401, message: 'Invalid credentials auth.controller.js 125' };
      }

      const user = userResult.rows[0];

      // Check if account is locked
      if (user.account_locked) {
        if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
          throw {
            status: 403,
            message: 'Account is locked due to too many failed attempts. Try again later.'
          };
        } else {
          // Unlock account if lockout period has passed
          await client.query(
            `UPDATE users 
             SET account_locked = false,
                 lockout_until = NULL,
                 failed_login_attempts = 0,
                 updated_at = NOW()
             WHERE id = $1`,
            [user.id]
          );
        }
      }

      // Verify password
      const passwordValid = await bcrypt.compare(password, user.password_hash);

      if (!passwordValid) {
        // Record failed login attempt
        await client.query(
          `UPDATE users 
           SET failed_login_attempts = failed_login_attempts + 1,
               account_locked = CASE WHEN failed_login_attempts + 1 >= 5 THEN true ELSE false END,
               lockout_until = CASE WHEN failed_login_attempts + 1 >= 5 
                                   THEN NOW() + INTERVAL '30 minutes' 
                                   ELSE lockout_until END,
               updated_at = NOW()
           WHERE id = $1`,
          [user.id]
        );

        // Log failed login
        await client.query(
          `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
           VALUES ($1, 'failed_login', $2, $3, $4)`,
          [
            user.id,
            req.ip,
            req.headers['user-agent'],
            JSON.stringify({ reason: 'incorrect_password', attempt: user.failed_login_attempts + 1 })
          ]
        );

        throw { status: 401, message: 'Invalid credentials auth.controller 180' };
      }

      // Check if email is verified
      if (!user.email_verified) {
        throw { status: 403, message: 'Please verify your email address before logging in' };
      }

      // Reset failed login attempts
      await client.query(
        `UPDATE users 
         SET failed_login_attempts = 0,
             account_locked = false,
             lockout_until = NULL,
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      );

      // Generate JWT token (short-lived access token)
      const accessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
        expiresIn: '72h' // Token expires in 1 hour
      });

      // Generate refresh token
      const refreshToken = generateRefreshToken();
      const refreshTokenExpiresAt = new Date();
      refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 30); // 30 days from now

      // Store refresh token in database
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, $3)`,
        [user.id, refreshToken, refreshTokenExpiresAt]
      );

      // Create session (keep for compatibility)
      await client.query(
        `INSERT INTO user_sessions (user_id, token, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
        [user.id, accessToken, req.ip, req.headers['user-agent']]
      );

      // Log successful login
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'login', $2, $3, $4)`,
        [
          user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ session_token: accessToken })
        ]
      );

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email
        }
      };
    });

    return res.status(200).json({
      message: 'Login successful',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user
    });
  } catch (error) {
    console.error('Login error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during login' });
  }
};

/**
 * Refresh an access token using a refresh token
 * @route POST /auth/refresh
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' });
    }

    const result = await db.transaction(async (client) => {
      // Verify the refresh token exists and is not expired or revoked
      const tokenResult = await client.query(
        `SELECT user_id, token FROM refresh_tokens 
         WHERE token = $1 
         AND expires_at > NOW() 
         AND revoked = FALSE`,
        [refreshToken]
      );

      if (tokenResult.rows.length === 0) {
        throw { status: 401, message: 'Invalid or expired refresh token' };
      }

      const userId = tokenResult.rows[0].user_id;

      // Get the user associated with this token
      const userResult = await client.query(
        `SELECT id, username, email FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw { status: 401, message: 'User not found' };
      }

      const user = userResult.rows[0];

      // Generate new access token
      const newToken = jwt.sign({ userId }, process.env.JWT_SECRET, {
        expiresIn: '1h'
      });

      // Generate new refresh token (token rotation)
      const newRefreshToken = generateRefreshToken();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days from now

      // Revoke the old refresh token
      await client.query(
        `UPDATE refresh_tokens 
         SET revoked = TRUE, revoked_at = NOW() 
         WHERE token = $1`,
        [refreshToken]
      );

      // Store the new refresh token
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, $3)`,
        [userId, newRefreshToken, expiresAt]
      );

      // Log token refresh
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'token_refresh', $2, $3, $4)`,
        [
          userId,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ old_token: refreshToken.substring(0, 10) + '...' })
        ]
      );

      return {
        accessToken: newToken,
        refreshToken: newRefreshToken,
        user
      };
    });

    return res.status(200).json({
      message: 'Token refreshed successfully',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Logout user
 * @route POST /auth/logout
 */
const logout = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const refreshToken = req.body.refreshToken;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(400).json({ message: 'No session token provided' });
    }

    const token = authHeader.split(' ')[1];

    await db.transaction(async (client) => {
      // Get user ID from session
      const sessionResult = await client.query(
        `SELECT user_id FROM user_sessions WHERE token = $1`,
        [token]
      );

      if (sessionResult.rows.length > 0) {
        const userId = sessionResult.rows[0].user_id;

        // Delete session
        await client.query(
          `DELETE FROM user_sessions WHERE token = $1`,
          [token]
        );

        // Revoke refresh token if provided
        if (refreshToken) {
          await client.query(
            `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() 
             WHERE token = $1 AND user_id = $2`,
            [refreshToken, userId]
          );
        }

        // Log logout
        await client.query(
          `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
           VALUES ($1, 'logout', $2, $3, $4)`,
          [
            userId,
            req.ip,
            req.headers['user-agent'],
            JSON.stringify({
              session_token: token,
              refresh_token_revoked: !!refreshToken
            })
          ]
        );
      }
    });

    return res.status(200).json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ message: 'Server error during logout' });
  }
};

/**
 * Get current user profile
 * @route GET /auth/me
 */
const getCurrentUser = async (req, res) => {
  // Your existing getCurrentUser implementation
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const result = await db.transaction(async (client) => {
      // Get user details
      const userResult = await client.query(
        `SELECT u.id, u.username, u.email, u.email_verified, u.profile_image_url, 
                u.created_at, u.last_login_at,
                us.theme, us.notification_preferences, us.privacy_settings
         FROM users u
         LEFT JOIN user_settings us ON u.id = us.user_id
         WHERE u.id = $1`,
        [req.user.id]
      );

      if (userResult.rows.length === 0) {
        throw { status: 404, message: 'User not found' };
      }

      // Get user roles
      const rolesResult = await client.query(
        `SELECT r.name
         FROM roles r
         JOIN user_roles ur ON r.id = ur.role_id
         WHERE ur.user_id = $1`,
        [req.user.id]
      );

      const roles = rolesResult.rows.map(row => row.name);

      // Get active sessions
      const sessionsResult = await client.query(
        `SELECT id, ip_address, user_agent, created_at, last_activity_at, expires_at
         FROM user_sessions
         WHERE user_id = $1 AND expires_at > NOW()
         ORDER BY last_activity_at DESC`,
        [req.user.id]
      );

      return {
        ...userResult.rows[0],
        roles,
        sessions: sessionsResult.rows,
      };
    });

    return res.status(200).json({ user: result });
  } catch (error) {
    console.error('Get current user error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Request password reset
 * @route POST /auth/forgot-password
 */
const forgotPassword = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email } = req.body;

  try {
    console.log(`Forgot password request received for email: ${email}`);
    // Find user by email
    const userResult = await db.query('SELECT id, email FROM users WHERE email = $1', [email]);

    let result = {
      userFound: false,
      tokenGenerated: false,
    };

    if (userResult.rows.length > 0) {
      result.userFound = true;
      const user = userResult.rows[0];
      console.log(`User found: ${user.id}`);

      // Generate a secure reset token
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000); // Token expires in 1 hour
      console.log(`Generated reset token (expires ${expires.toISOString()})`);

      // Store token and expiry in the database
      await db.query(
        'UPDATE users SET reset_password_token = $1, reset_password_token_expires_at = $2 WHERE id = $3',
        [token, expires, user.id]
      );
      result.tokenGenerated = true;
      console.log(`Stored reset token for user ${user.id}`);

      // Send password reset email with token if user was found
      if (result.userFound && result.tokenGenerated) {
        // Send email with reset token
        try {
          await emailService.sendPasswordResetEmail(user.email, token);
          console.log(`Password reset email sent successfully to ${user.email}`);
        } catch (emailError) {
          console.error(`Failed to send password reset email to ${user.email}:`, emailError);
          // Respond with a generic error, but log the specific issue
          // Don't reveal if the email sending failed vs. user not found
          return res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });
        }
      }
    } else {
      console.log(`User not found for email: ${email}`);
      // Still return a generic success message even if user not found for security
    }

    // Always return a generic success message to prevent email enumeration attacks
    res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });

  } catch (error) {
    console.error('Error in forgot password controller:', error);
    res.status(500).json({ message: 'Internal server error during password reset process.' });
  }
};

/**
 * Reset password with token
 * @route POST /auth/reset-password
 */
const resetPassword = async (req, res) => {
  // Your existing resetPassword implementation with refresh token revocation
  try {
    const { token, newPassword } = req.body;

    const result = await db.transaction(async (client) => {
      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, saltRounds);

      // Update user password
      const result = await client.query(
        `UPDATE users 
         SET password_hash = $1,
             reset_password_token = NULL,
             reset_password_token_expires_at = NULL,
             updated_at = NOW()
         WHERE reset_password_token = $2
           AND reset_password_token_expires_at > NOW()
         RETURNING id`,
        [passwordHash, token]
      );

      if (result.rows.length === 0) {
        throw { status: 400, message: 'Invalid or expired reset token' };
      }

      const userId = result.rows[0].id;

      // Log password reset
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'password_reset', $2, $3, $4)`,
        [
          userId,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ status: 'success' })
        ]
      );

      // Invalidate all existing sessions
      await client.query(
        `DELETE FROM user_sessions WHERE user_id = $1`,
        [userId]
      );

      // Revoke all refresh tokens for security
      await client.query(
        `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() 
         WHERE user_id = $1 AND revoked = FALSE`,
        [userId]
      );

      return { success: true };
    });

    return res.status(200).json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Change password (when user is logged in)
 * @route POST /auth/change-password
 */
const changePassword = async (req, res) => {
  // Your existing changePassword implementation with refresh token revocation
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const { currentPassword, newPassword } = req.body;

    await db.transaction(async (client) => {
      // Get current password hash
      const userResult = await client.query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [req.user.id]
      );

      if (userResult.rows.length === 0) {
        throw { status: 404, message: 'User not found' };
      }

      // Verify current password
      const passwordValid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);

      if (!passwordValid) {
        throw { status: 401, message: 'Current password is incorrect' };
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, saltRounds);

      // Update password
      await client.query(
        `UPDATE users 
         SET password_hash = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, req.user.id]
      );

      // Log password change
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'password_change', $2, $3, $4)`,
        [
          req.user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ status: 'success' })
        ]
      );

      // Optional: Revoke all refresh tokens except the current one
      // This would require passing the current refreshToken in the request
      if (req.body.currentRefreshToken) {
        await client.query(
          `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() 
           WHERE user_id = $1 AND token != $2 AND revoked = FALSE`,
          [req.user.id, req.body.currentRefreshToken]
        );
      }
    });

    return res.status(200).json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Handle OAuth callback and login/registration
 * @route POST /auth/oauth/:provider
 */
const oauthCallback = async (req, res) => {
  // Your existing oauthCallback implementation
  try {
    const { provider } = req.params;
    const {
      providerUserId,
      email,
      name,
      accessToken,
      refreshToken: oauthRefreshToken,
      expiresIn,
      profileData
    } = req.body;

    const result = await db.transaction(async (client) => {
      // Check if provider exists
      const providerResult = await client.query(
        `SELECT id FROM oauth_providers WHERE provider_name = $1 AND is_active = true`,
        [provider]
      );

      if (providerResult.rows.length === 0) {
        throw { status: 400, message: `OAuth provider '${provider}' is not supported` };
      }

      const providerId = providerResult.rows[0].id;

      // Check if user already exists with this OAuth connection
      const connectionResult = await client.query(
        `SELECT uc.user_id 
         FROM user_oauth_connections uc
         WHERE uc.provider_id = $1 AND uc.provider_user_id = $2`,
        [providerId, providerUserId]
      );

      let userId;

      if (connectionResult.rows.length > 0) {
        // User exists, update OAuth tokens
        userId = connectionResult.rows[0].user_id;

        await client.query(
          `UPDATE user_oauth_connections
           SET access_token = $1,
               refresh_token = $2,
               token_expires_at = NOW() + INTERVAL '${expiresIn} seconds',
               profile_data = $3,
               updated_at = NOW()
           WHERE provider_id = $4 AND provider_user_id = $5`,
          [accessToken, oauthRefreshToken, JSON.stringify(profileData), providerId, providerUserId]
        );
      } else {
        // Check if user exists with the same email
        const userResult = await client.query(
          `SELECT id FROM users WHERE email = $1`,
          [email]
        );

        if (userResult.rows.length > 0) {
          // Link OAuth to existing account
          userId = userResult.rows[0].id;

          await client.query(
            `INSERT INTO user_oauth_connections (
               user_id, provider_id, provider_user_id, access_token, 
               refresh_token, token_expires_at, profile_data
             )
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${expiresIn} seconds', $6)`,
            [userId, providerId, providerUserId, accessToken, oauthRefreshToken, JSON.stringify(profileData)]
          );
        } else {
          // Create new user from OAuth data
          // Generate username from email or name
          const baseUsername = (email || name).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
          let username = baseUsername;
          let usernameCounter = 1;

          // Check if username is available, if not append a number
          while (true) {
            const usernameCheck = await client.query(
              `SELECT id FROM users WHERE username = $1`,
              [username]
            );

            if (usernameCheck.rows.length === 0) {
              break;
            }

            username = `${baseUsername}${usernameCounter++}`;
          }

          // Create user
          const newUser = await client.query(
            `INSERT INTO users (
               username, email, email_verified, password_hash,
               created_at, updated_at
             )
             VALUES ($1, $2, true, '', NOW(), NOW())
             RETURNING id`,
            [username, email]
          );

          userId = newUser.rows[0].id;

          // Assign default role
          await client.query(
            `INSERT INTO user_roles (user_id, role_id)
             VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))`,
            [userId]
          );

          // Create OAuth connection
          await client.query(
            `INSERT INTO user_oauth_connections (
               user_id, provider_id, provider_user_id, access_token, 
               refresh_token, token_expires_at, profile_data
             )
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${expiresIn} seconds', $6)`,
            [userId, providerId, providerUserId, accessToken, oauthRefreshToken, JSON.stringify(profileData)]
          );
        }
      }

      // Update user's last login
      await client.query(
        `UPDATE users 
         SET last_login_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );

      // Generate JWT token
      const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
        expiresIn: '1h'
      });

      // Generate refresh token
      const refreshToken = generateRefreshToken();
      const refreshTokenExpiresAt = new Date();
      refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 30); // 30 days from now

      // Store refresh token in database
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, $3)`,
        [userId, refreshToken, refreshTokenExpiresAt]
      );

      // Create session
      await client.query(
        `INSERT INTO user_sessions (user_id, token, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
        [userId, token, req.ip, req.headers['user-agent']]
      );

      // Log OAuth login
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'oauth_login', $2, $3, $4)`,
        [
          userId,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ provider, provider_user_id: providerUserId, session_token: token })
        ]
      );

      // Get user information
      const userInfoResult = await client.query(
        `SELECT id, username, email, profile_image_url
         FROM users
         WHERE id = $1`,
        [userId]
      );

      return {
        token,
        refreshToken,
        user: userInfoResult.rows[0]
      };
    });

    return res.status(200).json({
      message: 'OAuth login successful',
      token: result.token,
      refreshToken: result.refreshToken,
      user: result.user
    });
  } catch (error) {
    console.error('OAuth callback error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during OAuth authentication' });
  }
};

// =============================================
// Export authentication functions
// =============================================

module.exports = {
  // Middleware
  authenticateJWT,
  checkPermissions,

  // Auth routes
  register,
  verifyEmail,
  login,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
  refreshToken,
  changePassword,
  oauthCallback
}
