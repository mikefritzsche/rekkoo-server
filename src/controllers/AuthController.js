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
const fetch = require('node-fetch');

// Prevent crash in dev when Mailjet keys are absent
const MAILJET_ENABLED = !!process.env.MJ_APIKEY_PUBLIC && !!process.env.MJ_APIKEY_PRIVATE;

let mailjet = null;
if (MAILJET_ENABLED) {
  mailjet = new Mailjet({
    apiKey: process.env.MJ_APIKEY_PUBLIC,
    apiSecret: process.env.MJ_APIKEY_PRIVATE,
  });
} else {
  console.warn('[AuthController] Mailjet disabled – missing env keys');
}

const { jwtExpiresIn } = require('../auth/config');

// Helper function to generate a refresh token
const generateRefreshToken = () => {
  return crypto.randomBytes(40).toString('hex');
};

// Helper function to check if we're in production
const isProduction = () => ['production', 'prod'].includes(process.env.NODE_ENV);

// Helper function to get environment-aware URLs
const getClientUrl = (type) => {
  if (type === 'app') {
    return process.env.CLIENT_URL_APP || (isProduction() ? 'https://app.rekkoo.com' : 'http://localhost:8081');
  } else if (type === 'admin') {
    return process.env.CLIENT_URL_ADMIN || (isProduction() ? 'https://admin.rekkoo.com' : 'https://admin-dev.rekkoo.com');
  }
  throw new Error(`Unknown client type: ${type}`);
};

/**
 * Register a new user
 * @route POST /auth/register
 */
const register = async (req, res) => {
  // Your existing register implementation
  try {
    const { username, email, password, invitationCode } = req.body;

    // Import invitation service
    const invitationService = require('../services/invitationService');

    // Validate invitation code before proceeding
    if (!invitationCode) {
      return res.status(400).json({ message: 'Invitation code is required for beta registration' });
    }

    const validation = await invitationService.validateInvitation(invitationCode);
    if (!validation.valid) {
      return res.status(400).json({
        message: validation.error || 'Invalid or expired invitation code'
      });
    }

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

      // Create user settings with private mode and connection code
      const connectionCodeResult = await client.query(
        `SELECT public.generate_user_connection_code() as code`
      );

      await client.query(
        `INSERT INTO user_settings (user_id, privacy_settings, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, JSON.stringify({
          privacy_mode: 'standard',
          show_email_to_connections: false,
          allow_connection_requests: true,
          allow_group_invites_from_connections: true,
          searchable_by_username: false,
          searchable_by_email: false,
          searchable_by_name: false,
          show_mutual_connections: false,
          connection_code: connectionCodeResult.rows[0].code
        })]
      );

      // Accept the invitation
      await invitationService.acceptInvitation(validation.invitation.id, userId, client);

      return { userId, verificationToken, username, email, invitationId: validation.invitation.id };
    });

    // Send verification email
    try {
      await emailService.sendVerificationEmail(email, username, result.verificationToken);
      console.log(`Verification email sent to ${email}`);
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      // Continue with registration even if email fails
      // We could log this to a monitoring system or queue for retry
    }

    return res.status(201).json({
      message: 'Welcome to the beta! Please check your email to verify your account.',
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
 * Resend verification email
 * @route POST /auth/resend-verification
 */
const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Check if user exists and needs verification
    const userResult = await db.query(
      `SELECT id, username, email, email_verified, verification_token, verification_token_expires_at
       FROM users 
       WHERE email = $1`,
      [email]
    );

    if (userResult.rows.length === 0) {
      // For security reasons, always return a generic success message
      // to prevent user enumeration attacks
      return res.status(200).json({ 
        message: 'If the email exists in our system, a verification link has been sent.' 
      });
    }

    const user = userResult.rows[0];

    // If email is already verified, no need to resend
    if (user.email_verified) {
      return res.status(200).json({ 
        message: 'Your email is already verified. You can log in to your account.'
      });
    }

    // Generate a new verification token and update expiration
    const verificationToken = uuidv4();
    
    await db.query(
      `UPDATE users 
       SET verification_token = $1,
           verification_token_expires_at = NOW() + INTERVAL '24 hours',
           updated_at = NOW()
       WHERE id = $2`,
      [verificationToken, user.id]
    );

    // Send new verification email
    try {
      await emailService.sendVerificationEmail(user.email, user.username, verificationToken);
      console.log(`New verification email sent to ${user.email}`);
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      return res.status(500).json({ message: 'Failed to send verification email' });
    }

    return res.status(200).json({ 
      message: 'A new verification link has been sent to your email address.'
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    return res.status(500).json({ message: 'Server error during verification email resend' });
  }
};

/**
 * Login user
 * @route POST /auth/login
 */
const login = async (req, res) => {
  console.log('login process.env.JWT_SECRET', process.env.JWT_SECRET);
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
        expiresIn: jwtExpiresIn
      });

      // Generate refresh token
      const refreshTokenValue = generateRefreshToken(); // Renamed from refreshToken to avoid conflict
      const refreshTokenExpiresAt = new Date();
      refreshTokenExpiresAt.setDate(refreshTokenExpiresAt.getDate() + 30); // 30 days from now

      // Store refresh token in database
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) 
         VALUES ($1, $2, $3)`,
        [user.id, refreshTokenValue, refreshTokenExpiresAt]
      );

      // Create session (keep for compatibility)
      await client.query(
        `INSERT INTO user_sessions (user_id, token, refresh_token, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 days')`,
        [user.id, accessToken, refreshTokenValue, req.ip, req.headers['user-agent']]
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

      return { accessToken, refreshToken: refreshTokenValue, user }; // Return refreshTokenValue
    });

    return res.status(200).json({
      message: 'Login successful',
      accessToken: result.accessToken,
      refreshToken: result.refreshToken, // Send refreshTokenValue to client
      user: {
        id: result.user.id,
        username: result.user.username,
        email: result.user.email,
        email_verified: result.user.email_verified
        // Add other user fields you want to return
      }
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
 * Refresh JWT token
 * @route POST /auth/refresh-token
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required' });
    }

    // Use a transaction to ensure atomicity
    const result = await db.transaction(async (client) => {
      // Find the refresh token in the database
      const tokenResult = await client.query(
        `SELECT user_id, expires_at, revoked, created_at
         FROM refresh_tokens
         WHERE token = $1`,
        [refreshToken]
      );

      if (tokenResult.rows.length === 0) {
        // Log this attempt for security monitoring
        console.warn(`[Auth] Refresh token not found: ${refreshToken.substring(0, 10)}...`);
        throw { status: 401, message: 'Invalid refresh token' };
      }

      const tokenData = tokenResult.rows[0];

      // Check if the token is revoked or expired
      if (tokenData.revoked) {
        // IMPLEMENTATION OF GRACE PERIOD:
        // If a revoked token is used, it could be a sign of token theft or a race condition.
        // A simple grace period can help with race conditions where a client makes multiple
        // requests with the same token before receiving the new one.
        const gracePeriod = 10000; // 10 seconds
        const tokenAge = Date.now() - new Date(tokenData.created_at).getTime();

        if (tokenAge > gracePeriod) {
            // If the token is old, it's more likely a security issue. Invalidate all user's tokens.
            await client.query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [tokenData.user_id]);
             console.error(`[Auth] Attempted reuse of revoked refresh token for user ${tokenData.user_id}. All tokens revoked.`);
            throw { status: 401, message: 'Refresh token has been revoked. Please log in again.' };
        }
        
        // If within grace period, it might be a race condition.
        // We can choose to re-send the latest active token if one exists.
        // For now, we will still treat it as an error but with a less severe message.
        console.warn(`[Auth] Revoked refresh token used within grace period for user ${tokenData.user_id}. Potential race condition.`);
        throw { status: 401, message: 'Refresh token has been revoked' };
      }

      if (new Date(tokenData.expires_at) < new Date()) {
        throw { status: 401, message: 'Refresh token has expired' };
      }

      // Invalidate the old refresh token by revoking it
      await client.query(
        `UPDATE refresh_tokens SET revoked = true WHERE token = $1`,
        [refreshToken]
      );

      // Fetch user data for the new access token payload
      const userResult = await client.query(
        `SELECT u.id, u.username, u.email,
                COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON u.id = ur.user_id
         LEFT JOIN roles r ON ur.role_id = r.id
         WHERE u.id = $1
         GROUP BY u.id`,
        [tokenData.user_id]
      );

      if (userResult.rows.length === 0) {
        throw { status: 404, message: 'User not found' };
      }

      const user = userResult.rows[0];

      // Generate a new access token
      const accessToken = jwt.sign(
        { userId: user.id, username: user.username, roles: user.roles },
        process.env.JWT_SECRET,
        { expiresIn: jwtExpiresIn }
      );

      // Generate a new refresh token
      const newRefreshToken = generateRefreshToken();
      await client.query(
        `INSERT INTO refresh_tokens (token, user_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
        [newRefreshToken, user.id]
      );

      return { accessToken, refreshToken: newRefreshToken, userId: user.id };
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('Token refresh error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during token refresh' });
  }
};

/**
 * Logout user
 * @route POST /auth/logout
 */
const logout = async (req, res) => {
  try {
    const { refreshToken } = req.body; // Expect refresh token from client
    const userId = req.user.id; // from authenticateJWT middleware

    if (!refreshToken) {
      return res.status(400).json({ message: 'Refresh token is required for logout' });
    }

    const result = await db.transaction(async (client) => {
      // Delete the specific refresh token
      const deleteTokenResult = await client.query(
        `DELETE FROM refresh_tokens WHERE token = $1 AND user_id = $2 RETURNING id`,
        [refreshToken, userId]
      );
      
      if(deleteTokenResult.rowCount === 0){
        console.warn(`Logout attempt with non-existent or non-matching refresh token for user ${userId}`);
        // Even if token doesn't match/exist, proceed to log out from session if applicable
      }

      // Soft delete the user session (set deleted_at)
      await client.query(
        `UPDATE user_sessions
         SET deleted_at = NOW()
         WHERE refresh_token = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [refreshToken, userId]
      );

      // Log logout event
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'logout', $2, $3, $4)`,
        [
          userId,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ invalidated_refresh_token: refreshToken })
        ]
      );
      return deleteTokenResult.rowCount > 0; // Indicate if a token was actually deleted
    });
    
    // Clear any cookies if you were using them (e.g., for httpOnly refresh token)
    // res.clearCookie('refreshToken'); 

    return res.status(200).json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ message: 'Server error during logout' });
  }
};

/**
 * Get current user details
 * @route GET /auth/me
 */
const getCurrentUser = async (req, res) => {
  try {
    const userId = req.user.id; // from authenticateJWT middleware

    const result = await db.query(
      `SELECT u.id, u.username, u.email, u.email_verified, u.created_at, u.updated_at,
              u.profile_image_url, u.bio, u.last_login_at, u.full_name,
              array_agg(r.name) as roles,
              us.theme AS user_theme,
              us.notification_preferences AS user_notification_preferences,
              us.privacy_settings AS user_privacy_settings,
              us.lists_header_image_url AS user_lists_header_image_url,
              us.lists_header_background_type AS user_lists_header_background_type,
              us.lists_header_background_value AS user_lists_header_background_value
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       LEFT JOIN user_settings us ON u.id = us.user_id
       WHERE u.id = $1 AND u.deleted_at IS NULL
       GROUP BY u.id, us.user_id, us.theme, us.notification_preferences, us.privacy_settings, us.lists_header_image_url, us.lists_header_background_type, us.lists_header_background_value`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const dbUser = result.rows[0];

    // Optionally, fetch other related data like active sessions, recent activity etc.

    return res.status(200).json({
      user: {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        email_verified: dbUser.email_verified,
        roles: dbUser.roles || [],
        profile_image_url: dbUser.profile_image_url,
        bio: dbUser.bio,
        full_name: dbUser.full_name,
        last_login_at: dbUser.last_login_at,
        settings: {
          theme: dbUser.user_theme,
          notification_preferences: dbUser.user_notification_preferences,
          privacy_settings: dbUser.user_privacy_settings,
          lists_header_image_url: dbUser.user_lists_header_image_url,
          lists_header_background_type: dbUser.user_lists_header_background_type,
          lists_header_background_value: dbUser.user_lists_header_background_value
        },
        created_at: dbUser.created_at,
        updated_at: dbUser.updated_at
      }
    });
  } catch (error) {
    console.error('Get current user error:', error);
    return res.status(500).json({ message: 'Server error while fetching user data' });
  }
};

/**
 * Request password reset
 * @route POST /auth/forgot-password
 */
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    const result = await db.transaction(async (client) => {
      const userResult = await client.query(
        `SELECT id, email, username FROM users WHERE email = $1 AND deleted_at IS NULL`,
        [email]
      );

      if (userResult.rows.length === 0) {
        // Don't reveal if email exists or not for security reasons
        return null; 
      }
      const user = userResult.rows[0];

      const resetToken = uuidv4();
      const resetTokenExpiresAt = new Date(Date.now() + 3600000); // 1 hour from now

      await client.query(
        `UPDATE users 
         SET reset_password_token = $1,
             reset_password_token_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [resetToken, resetTokenExpiresAt, user.id]
      );
      return { user, resetToken };
    });

    if (result && result.user && result.resetToken) {
      // Send password reset email
      const resetLink = `${getClientUrl('admin')}/reset-password?token=${result.resetToken}`;
      await emailService.sendPasswordResetEmail(result.user.email, result.user.username, resetLink);
    }

    return res.status(200).json({ message: 'If your email is registered, you will receive a password reset link.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ message: 'Server error during password reset request' });
  }
};

/**
 * Reset password with token
 * @route POST /auth/reset-password
 */
const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  try {
    const result = await db.transaction(async (client) => {
      const userResult = await client.query(
        `SELECT id FROM users 
         WHERE reset_password_token = $1 
           AND reset_password_token_expires_at > NOW()
           AND deleted_at IS NULL`,
        [token]
      );

      if (userResult.rows.length === 0) {
        throw { status: 400, message: 'Invalid or expired password reset token' };
      }
      const user = userResult.rows[0];

      const passwordHash = await bcrypt.hash(newPassword, saltRounds);

      await client.query(
        `UPDATE users 
         SET password_hash = $1,
             reset_password_token = NULL,
             reset_password_token_expires_at = NULL,
             failed_login_attempts = 0, -- Reset failed attempts
             account_locked = false,    -- Unlock account
             lockout_until = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, user.id]
      );

      // Log password reset
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'password_reset', $2, $3, $4)`,
        [
          user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ method: 'token_reset' })
        ]
      );
      return user.id;
    });

    return res.status(200).json({ message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during password reset' });
  }
};

/**
 * Change password for logged-in user
 * @route POST /auth/change-password
 */
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id; // from authenticateJWT

  try {
    const result = await db.transaction(async (client) => {
      const userResult = await client.query(
        `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        throw { status: 404, message: 'User not found' };
      }
      const user = userResult.rows[0];

      const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!passwordValid) {
        throw { status: 401, message: 'Incorrect current password' };
      }

      const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

      await client.query(
        `UPDATE users 
         SET password_hash = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [newPasswordHash, userId]
      );

      // Log password change
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'password_change', $2, $3, $4)`,
        [
          userId,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ method: 'user_initiated' })
        ]
      );
      return true;
    });

    return res.status(200).json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during password change' });
  }
};

// =============================================
// OAuth Placeholder - Example for Google
// =============================================

// This is a simplified placeholder. A real OAuth implementation would involve:
// 1. Redirecting to Google's consent screen.
// 2. Google redirecting back to your /auth/google/callback with an authorization code.
// 3. Exchanging the code for tokens (access, refresh, ID token).
// 4. Using the ID token or userinfo endpoint to get user details.
// 5. Finding or creating a user in your database.
// 6. Generating your own JWTs for the user.

const oauthCallback = async (req, res) => {
  // This function would be the callback URL you register with the OAuth provider.
  // e.g., /auth/google/callback
  const { code } = req.query; // Authorization code from OAuth provider
  const provider = req.params.provider; // e.g., 'google', 'facebook'

  try {
    // --- Step 1: Exchange authorization code for tokens ---
    // This part is specific to each OAuth provider.
    // Example for Google (you'd use a library like `googleapis` or `openid-client`):
    // const { tokens } = await oauth2Client.getToken(code);
    // const idToken = tokens.id_token;
    // const accessTokenFromProvider = tokens.access_token;
    // const refreshTokenFromProvider = tokens.refresh_token; 
    
    // --- Mocking this step for placeholder ---
    if (!code) {
      return res.status(400).json({ message: 'Authorization code missing.' });
    }
    console.log(`[OAuth ${provider}] Received authorization code: ${code}`)
    // --- End Mock ---

    // --- Step 2: Get user profile from OAuth provider ---
    // Use the provider's access token to fetch user details.
    // Example for Google:
    // const ticket = await oauth2Client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    // const payload = ticket.getPayload();
    // const email = payload.email;
    // const googleId = payload.sub;
    // const name = payload.name;
    // const profileImageUrl = payload.picture;
    // const emailVerified = payload.email_verified;

    // --- Mocking user profile data for placeholder ---
    const mockUser = {
      email: `user_${Date.now()}@${provider}.example.com`,
      providerId: `mock_${provider}_${Date.now()}`,
      name: `Mock ${provider} User`,
      profileImageUrl: 'https://via.placeholder.com/150',
      emailVerified: true
    };
    // --- End Mock ---

    const { email, providerId, name, profileImageUrl, emailVerified } = mockUser;

    const result = await db.transaction(async (client) => {
      // Look up provider row
      let providerRes = await client.query(`SELECT id FROM oauth_providers WHERE provider_name = $1`, [provider]);
      let providerRowId = providerRes.rows.length ? providerRes.rows[0].id : null;

      // Insert provider row if missing
      if (!providerRowId) {
        const insertProv = await client.query(
          `INSERT INTO oauth_providers (provider_name) VALUES ($1) RETURNING id`,
          [provider]
        );
        providerRowId = insertProv.rows[0].id;
      }

      let userResult = await client.query(
        `SELECT u.*
         FROM users u
         JOIN user_oauth_connections c ON u.id = c.user_id
         WHERE c.provider_id = $1 AND c.provider_user_id = $2 AND u.deleted_at IS NULL`,
        [providerRowId, providerId]
      );
      let user = userResult.rows[0];

      if (!user) {
        // If not found by provider ID, check by email (if verified)
        if (email && emailVerified) {
          userResult = await client.query(
            `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
            [email]
          );
          user = userResult.rows[0];

          if (user) {
            // User exists with this email, link OAuth identity
            await client.query(
              `DELETE FROM user_oauth_connections WHERE user_id = $1 AND provider_id = $2`,
              [user.id, providerRowId]
            );
            await client.query(
              `INSERT INTO user_oauth_connections (user_id, provider_id, provider_user_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NULL, NOW() + INTERVAL '1 hour', NOW(), NOW())`,
              [user.id, providerRowId, providerId, accessToken]
            );
          } else {
            // New user: Create user and link OAuth identity
            const newUserResult = await client.query(
              `INSERT INTO users (username, email, email_verified, profile_image_url, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NOW(), NOW())
               RETURNING *`,
              [name || email.split('@')[0], email, emailVerified, profileImageUrl]
            );
            user = newUserResult.rows[0];

            await client.query(
              `INSERT INTO user_oauth_connections (user_id, provider_id, provider_user_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NULL, NOW() + INTERVAL '1 hour', NOW(), NOW())`,
              [user.id, providerRowId, providerId, accessToken]
            );

            // Assign default role
            await client.query(
              `INSERT INTO user_roles (user_id, role_id)
               VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))`,
              [user.id]
            );

            // Create user settings with private mode and connection code
            const connectionCodeResult = await client.query(
              `SELECT public.generate_user_connection_code() as code`
            );

            await client.query(
              `INSERT INTO user_settings (user_id, privacy_settings, created_at, updated_at)
               VALUES ($1, $2, NOW(), NOW())
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, JSON.stringify({
                privacy_mode: 'standard',
                show_email_to_connections: false,
                allow_connection_requests: true,
                allow_group_invites_from_connections: true,
                searchable_by_username: false,
                searchable_by_email: false,
                searchable_by_name: false,
                show_mutual_connections: false,
                connection_code: connectionCodeResult.rows[0].code
              })]
            );
          }
        } else {
          // No verified email, cannot link or create securely without more info/steps
          // Or, if you allow unverified emails for OAuth, handle accordingly
          throw { status: 400, message: 'OAuth sign-in requires a verified email or existing linked account.' };
        }
      }

      // User is now found or created, and linked
      // Update last login, etc.
      await client.query(
        `UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [user.id]
      );

      // Log successful OAuth login
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'login', $2, $3, $4)`,
        [
          user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ method: provider, oauth: true })
        ]
      );

      // Generate your application's JWTs
      const appAccessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: jwtExpiresIn });
      const appRefreshToken = generateRefreshToken();
      const appRefreshTokenExpiresAt = new Date();
      appRefreshTokenExpiresAt.setDate(appRefreshTokenExpiresAt.getDate() + 30);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token) DO UPDATE SET expires_at = $3`,
        [user.id, appRefreshToken, appRefreshTokenExpiresAt]
      );

      await client.query(
        `INSERT INTO user_sessions (user_id, token, refresh_token, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '30 days')
         ON CONFLICT DO NOTHING`,
        [user.id, appAccessToken, appRefreshToken, req.ip, req.headers['user-agent']]
      );

      return { appAccessToken, appRefreshToken, user };
    });

    // Redirect to frontend with tokens, or set cookies (legacy - now handled by passportCallback)
    const adminUrl = getClientUrl('admin');
    const redirectUrl = `${adminUrl}/oauth/callback?accessToken=${result.appAccessToken}&refreshToken=${result.appRefreshToken}&userId=${result.user.id}`;
    return res.redirect(redirectUrl);

  } catch (error) {
    console.error(`[OAuth ${provider}] Callback error:`, error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    // Redirect to an error page on the frontend
    const adminUrl = getClientUrl('admin');
    return res.redirect(`${adminUrl}/auth/error?message=oauth_failed`);
  }
};

/**
 * Passport OAuth success handler – issues JWT + refresh token for the user set by passport.
 * This is called after passport has attached req.user.
 */
const passportCallback = async (req, res) => {
  try {
    console.log('[passportCallback] cookies header:', req.headers.cookie);
    if (!req.user || !req.user.id) {
      return res.status(400).json({ message: 'OAuth authentication failed – no user in request.' });
    }

    const user = req.user;

    const result = await db.transaction(async (client) => {
      const accessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: jwtExpiresIn });

      const refreshTokenValue = generateRefreshToken();
      const rtExpires = new Date();
      rtExpires.setDate(rtExpires.getDate() + 30);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, token) DO UPDATE SET expires_at = $3`,
        [user.id, refreshTokenValue, rtExpires]
      );

      await client.query(
        `INSERT INTO user_sessions (user_id, token, refresh_token, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '30 days')
         ON CONFLICT DO NOTHING`,
        [user.id, accessToken, refreshTokenValue, req.ip, req.headers['user-agent']]
      );

      // Log successful OAuth login
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'login', $2, $3, $4)`,
        [
          user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ method: 'oauth', oauth: true })
        ]
      );

      return { accessToken, refreshToken: refreshTokenValue };
    });

    // Try to fetch roles for convenience
    const rolesRes = await db.query(
      `SELECT r.name FROM roles r JOIN user_roles ur ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [user.id]
    );
    const roles = rolesRes.rows.map(r => r.name);

    // Decide which frontend should receive the tokens
    const queryRedirect = req.query.state; // Google returns state param unchanged

    const redirectFlag = req.session?.oauthRedirect || queryRedirect;
    console.log('[passportCallback] redirectFlag:', redirectFlag, 'sessionID', req.sessionID);
    
    let redirectUrl;
    if (redirectFlag === 'app') {
      // For mobile app, determine the redirect approach based on user agent
      const userAgent = req.get('User-Agent') || '';
      const isMobileBrowser = /Mobile|Android|iPhone|iPad/.test(userAgent);
      const isWebBrowser = !isMobileBrowser || /Chrome/.test(userAgent) || /Firefox/.test(userAgent) || /Edge/.test(userAgent);
      
      console.log('[passportCallback] User agent detection:', {
        userAgent,
        isMobileBrowser,
        isWebBrowser,
        redirectFlag
      });
      
      // Prefer the origin we captured at the start of the flow (domain user used to initiate login)
      // Fallback to configured CLIENT_URL_APP
      const detectedOrigin = req.session?.oauthOrigin;
      const appUrl = detectedOrigin || getClientUrl('app');
      
      if (isWebBrowser) {
        // For web browsers (desktop/laptop), redirect to oauth-callback route
        redirectUrl = `${appUrl}/oauth/callback?accessToken=${result.accessToken}&refreshToken=${result.refreshToken}&userId=${user.id}`;
        console.log('[passportCallback] Using web browser approach:', redirectUrl);
      } else {
        // For mobile browsers (iOS Safari, Android Chrome, etc.), use mobile platform flag
        redirectUrl = `${appUrl}/oauth/callback?accessToken=${result.accessToken}&refreshToken=${result.refreshToken}&userId=${user.id}&platform=mobile`;
        console.log('[passportCallback] Using mobile browser approach:', redirectUrl);
      }
    } else if (redirectFlag === 'admin') {
      const adminUrl = getClientUrl('admin');
      redirectUrl = `${adminUrl}/oauth/callback?accessToken=${result.accessToken}&refreshToken=${result.refreshToken}&userId=${user.id}`;
    } else {
      // Default to app client for better UX
      const detectedOrigin = req.session?.oauthOrigin;
      const appUrl = detectedOrigin || getClientUrl('app');
      redirectUrl = `${appUrl}/oauth/callback?accessToken=${result.accessToken}&refreshToken=${result.refreshToken}&userId=${user.id}`;
    }
    
    if (req.session) delete req.session.oauthRedirect;

    console.log('[passportCallback] Redirecting to:', redirectUrl);
    return res.redirect(redirectUrl);
  } catch (error) {
    console.error('passportCallback error:', error);
    
    // Handle error redirects based on the target
    const redirectFlag = req.session?.oauthRedirect || req.query.state;
    let errorRedirectUrl;
    
    if (redirectFlag === 'app') {
      const detectedOrigin = req.session?.oauthOrigin;
      const appUrl = detectedOrigin || getClientUrl('app');
      errorRedirectUrl = `${appUrl}/oauth/callback?error=authentication_failed`;
    } else {
      const adminUrl = getClientUrl('admin');
      errorRedirectUrl = `${adminUrl}/login?oauth=google&error=1`;
    }
    
    return res.redirect(errorRedirectUrl);
  }
};

// Admin-only route example
const getAllUsers = [ // Array for multiple middleware + handler
  authenticateJWT, 
  checkPermissions(['admin', 'manage_users']), // User must have 'admin' OR 'manage_users' permission
  async (req, res) => {
    try {
      const users = await db.query('SELECT id, username, email, created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC');
      res.json(users.rows);
    } catch (error) {
      console.error('Get all users error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
];

// --- New: mobile OAuth token exchange (installed-app flow) ---
const mobileOauth = async (req, res) => {
  const { provider } = req.params;
  if (!['google', 'apple', 'facebook'].includes(provider)) {
    return res.status(400).json({ message: 'Unsupported provider' });
  }

  const { accessToken, idToken, userInfo, invitationCode } = req.body || {};

  if (!idToken && !accessToken) {
    return res.status(400).json({ message: 'idToken or accessToken is required' });
  }

  try {
    let email, emailVerified, providerId, name, profileImageUrl;

    if (provider === 'google') {
      // Verify idToken with Google tokeninfo endpoint (lightweight; for production use google-auth-library).
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
      if (!verifyRes.ok) {
        return res.status(401).json({ message: 'Invalid Google ID token' });
      }
      const payload = await verifyRes.json();

      email = payload.email;
      emailVerified = payload.email_verified === 'true' || payload.email_verified === true;
      providerId = payload.sub;
      name = payload.name;
      profileImageUrl = payload.picture;
    } else if (provider === 'apple') {
      // For Apple, we trust the client-side verification since it's done by Apple's SDK
      // The idToken contains the user identifier, and userInfo contains additional details
      if (!idToken) {
        return res.status(400).json({ message: 'Apple idToken is required' });
      }

      // Decode the JWT payload (we're trusting client-side verification for now)
      // In production, you should verify the JWT signature with Apple's public keys
      const base64Payload = idToken.split('.')[1];
      const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString());
      
      providerId = payload.sub;
      email = payload.email || userInfo?.email;
      emailVerified = !!email; // Apple emails are verified
      name = userInfo?.name ? `${userInfo.name.firstName || ''} ${userInfo.name.lastName || ''}`.trim() : null;
      profileImageUrl = null; // Apple doesn't provide profile images
    } else if (provider === 'facebook') {
      // Verify via Graph API
      if (!accessToken) {
        return res.status(400).json({ message: 'Facebook accessToken is required' });
      }
      const resp = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}`);
      if (!resp.ok) {
        return res.status(401).json({ message: 'Invalid Facebook access token' });
      }
      const fb = await resp.json();
      providerId = fb.id;
      email = fb.email || null;
      emailVerified = !!email; // Facebook emails are verified when present
      name = fb.name;
      profileImageUrl = fb?.picture?.data?.url || null;
    }

    // Re-use logic from oauthCallback (manual copy) to find/create user and issue tokens

    const result = await db.transaction(async (client) => {
      // Ensure required OAuth tables exist (development convenience)
      await client.query(`CREATE TABLE IF NOT EXISTS oauth_providers (
        id SERIAL PRIMARY KEY,
        provider_name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`);

      await client.query(`CREATE TABLE IF NOT EXISTS user_oauth_connections (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id INTEGER NOT NULL REFERENCES oauth_providers(id) ON DELETE CASCADE,
        provider_user_id TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at TIMESTAMPTZ,
        profile_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, provider_id)
      );`);

      // Look up provider row
      let providerRes = await client.query(`SELECT id FROM oauth_providers WHERE provider_name = $1`, [provider]);
      let providerRowId = providerRes.rows.length ? providerRes.rows[0].id : null;

      // Insert provider row if missing
      if (!providerRowId) {
        const insertProv = await client.query(
          `INSERT INTO oauth_providers (provider_name) VALUES ($1) RETURNING id`,
          [provider]
        );
        providerRowId = insertProv.rows[0].id;
      }

      let userResult = await client.query(
        `SELECT u.*
         FROM users u
         JOIN user_oauth_connections c ON u.id = c.user_id
         WHERE c.provider_id = $1 AND c.provider_user_id = $2 AND u.deleted_at IS NULL`,
        [providerRowId, providerId]
      );
      let user = userResult.rows[0];

      if (!user) {
        if (email && emailVerified) {
          userResult = await client.query(
            `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
            [email]
          );
          user = userResult.rows[0];

          if (user) {
            await client.query(
              `DELETE FROM user_oauth_connections WHERE user_id = $1 AND provider_id = $2`,
              [user.id, providerRowId]
            );
            await client.query(
              `INSERT INTO user_oauth_connections (user_id, provider_id, provider_user_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NULL, NOW() + INTERVAL '1 hour', NOW(), NOW())`,
              [user.id, providerRowId, providerId, accessToken]
            );
          } else {
            // For new OAuth users, require invitation code
            if (!invitationCode) {
              throw { status: 400, message: 'Invitation code required for beta registration' };
            }

            // Import invitation service (inside try-catch to avoid import issues)
            const invitationService = require('../services/invitationService');
            const validation = await invitationService.validateInvitation(invitationCode);
            if (!validation.valid) {
              throw { status: 400, message: validation.error || 'Invalid or expired invitation code' };
            }

            const newUserResult = await client.query(
              `INSERT INTO users (username, email, email_verified, profile_image_url, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING *`,
              [name || email.split('@')[0], email, emailVerified, profileImageUrl]
            );
            user = newUserResult.rows[0];

            await client.query(
              `INSERT INTO user_oauth_connections (user_id, provider_id, provider_user_id, access_token, refresh_token, token_expires_at, created_at, updated_at)
               VALUES ($1, $2, $3, $4, NULL, NOW() + INTERVAL '1 hour', NOW(), NOW())`,
              [user.id, providerRowId, providerId, accessToken]
            );

            await client.query(
              `INSERT INTO user_roles (user_id, role_id)
               VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))`,
              [user.id]
            );

            // Create user settings with private mode and connection code
            const connectionCodeResult = await client.query(
              `SELECT public.generate_user_connection_code() as code`
            );

            await client.query(
              `INSERT INTO user_settings (user_id, privacy_settings, created_at, updated_at)
               VALUES ($1, $2, NOW(), NOW())
               ON CONFLICT (user_id) DO NOTHING`,
              [user.id, JSON.stringify({
                privacy_mode: 'standard',
                show_email_to_connections: false,
                allow_connection_requests: true,
                allow_group_invites_from_connections: true,
                searchable_by_username: false,
                searchable_by_email: false,
                searchable_by_name: false,
                show_mutual_connections: false,
                connection_code: connectionCodeResult.rows[0].code
              })]
            );

            // Accept the invitation
            await invitationService.acceptInvitation(validation.invitation.id, user.id);
          }
        } else {
          throw { status: 400, message: 'Verified email required' };
        }
      }

      await client.query(
        `UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [user.id]
      );

      // Log successful mobile OAuth login
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'login', $2, $3, $4)`,
        [
          user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ method: provider, oauth: true, mobile: true })
        ]
      );

      const appAccessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: jwtExpiresIn });
      const appRefreshToken = generateRefreshToken();
      const rtExpires = new Date();
      rtExpires.setDate(rtExpires.getDate() + 30);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, token) DO UPDATE SET expires_at = $3`,
        [user.id, appRefreshToken, rtExpires]
      );

      await client.query(
        `INSERT INTO user_sessions (user_id, token, refresh_token, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '30 days')
         ON CONFLICT DO NOTHING`,
        [user.id, appAccessToken, appRefreshToken, req.ip, req.headers['user-agent']]
      );

      return { accessToken: appAccessToken, refreshToken: appRefreshToken, userId: user.id };
    });

    return res.json(result);
  } catch (error) {
    console.error('[mobileOauth] error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Server error during mobile OAuth' });
  }
};

/**
 * Link an OAuth provider to an existing user account
 * @route POST /auth/oauth/link
 * @access Private (requires authentication)
 */
const linkOAuthAccount = async (req, res) => {
  try {
    const { provider, providerUserId, accessToken, refreshToken, profileData } = req.body;
    const userId = req.user.id;

    if (!provider || !providerUserId || !accessToken) {
      return res.status(400).json({ 
        message: 'Provider, providerUserId, and accessToken are required' 
      });
    }

    const result = await db.transaction(async (client) => {
      // Get or create provider
      let providerRes = await client.query(
        `SELECT id FROM oauth_providers WHERE provider_name = $1`,
        [provider]
      );
      let providerId = providerRes.rows.length ? providerRes.rows[0].id : null;

      if (!providerId) {
        const insertProv = await client.query(
          `INSERT INTO oauth_providers (provider_name) VALUES ($1) RETURNING id`,
          [provider]
        );
        providerId = insertProv.rows[0].id;
      }

      // Check if this provider account is already linked to another user
      const existingLink = await client.query(
        `SELECT user_id FROM user_oauth_connections 
         WHERE provider_id = $1 AND provider_user_id = $2 AND deleted_at IS NULL`,
        [providerId, providerUserId]
      );

      if (existingLink.rows.length > 0) {
        const linkedUserId = existingLink.rows[0].user_id;
        if (linkedUserId !== userId) {
          throw { 
            status: 409, 
            message: `This ${provider} account is already linked to another user` 
          };
        }
        // Already linked to this user, update tokens
        await client.query(
          `UPDATE user_oauth_connections 
           SET access_token = $1, refresh_token = $2, token_expires_at = NOW() + INTERVAL '1 hour', 
               profile_data = $3, updated_at = NOW()
           WHERE user_id = $4 AND provider_id = $5 AND provider_user_id = $6`,
          [accessToken, refreshToken || null, profileData ? JSON.stringify(profileData) : null, 
           userId, providerId, providerUserId]
        );
      } else {
        // Create new link
        await client.query(
          `INSERT INTO user_oauth_connections 
           (user_id, provider_id, provider_user_id, access_token, refresh_token, 
            token_expires_at, profile_data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour', $6, NOW(), NOW())`,
          [userId, providerId, providerUserId, accessToken, refreshToken || null, 
           profileData ? JSON.stringify(profileData) : null]
        );
      }

      return { success: true, message: `${provider} account linked successfully` };
    });

    res.json(result);
  } catch (error) {
    console.error('linkOAuthAccount error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    res.status(500).json({ message: 'Failed to link OAuth account' });
  }
};

/**
 * Unlink an OAuth provider from user account
 * @route DELETE /auth/oauth/unlink/:provider
 * @access Private (requires authentication)
 */
const unlinkOAuthAccount = async (req, res) => {
  try {
    const { provider } = req.params;
    const userId = req.user.id;

    const result = await db.transaction(async (client) => {
      // Get provider ID
      const providerRes = await client.query(
        `SELECT id FROM oauth_providers WHERE provider_name = $1`,
        [provider]
      );

      if (providerRes.rows.length === 0) {
        throw { status: 404, message: 'Provider not found' };
      }

      const providerId = providerRes.rows[0].id;

      // Check if user has password or other OAuth providers
      const userRes = await client.query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [userId]
      );

      const otherOAuthRes = await client.query(
        `SELECT COUNT(*) as count FROM user_oauth_connections 
         WHERE user_id = $1 AND provider_id != $2 AND deleted_at IS NULL`,
        [userId, providerId]
      );

      const hasPassword = userRes.rows[0]?.password_hash;
      const hasOtherOAuth = parseInt(otherOAuthRes.rows[0].count) > 0;

      if (!hasPassword && !hasOtherOAuth) {
        throw { 
          status: 400, 
          message: 'Cannot unlink the only authentication method. Please set a password first.' 
        };
      }

      // Soft delete the connection
      await client.query(
        `UPDATE user_oauth_connections 
         SET deleted_at = NOW() 
         WHERE user_id = $1 AND provider_id = $2`,
        [userId, providerId]
      );

      return { success: true, message: `${provider} account unlinked successfully` };
    });

    res.json(result);
  } catch (error) {
    console.error('unlinkOAuthAccount error:', error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    res.status(500).json({ message: 'Failed to unlink OAuth account' });
  }
};

/**
 * Get all linked OAuth accounts for current user
 * @route GET /auth/oauth/accounts
 * @access Private (requires authentication)
 */
const getLinkedAccounts = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      `SELECT 
         op.provider_name,
         uoc.provider_user_id,
         uoc.created_at as linked_at,
         uoc.profile_data
       FROM user_oauth_connections uoc
       JOIN oauth_providers op ON uoc.provider_id = op.id
       WHERE uoc.user_id = $1 AND uoc.deleted_at IS NULL
       ORDER BY uoc.created_at DESC`,
      [userId]
    );

    const linkedAccounts = result.rows.map(row => ({
      provider: row.provider_name,
      providerUserId: row.provider_user_id,
      linkedAt: row.linked_at,
      profileData: row.profile_data ? JSON.parse(row.profile_data) : null
    }));

    res.json({ linkedAccounts });
  } catch (error) {
    console.error('getLinkedAccounts error:', error);
    res.status(500).json({ message: 'Failed to get linked accounts' });
  }
};

/**
 * Enhanced OAuth callback that supports manual linking
 * @route POST /auth/oauth/:provider/callback
 * @access Public
 */
const enhancedOAuthCallback = async (req, res) => {
  try {
    const { provider } = req.params;
    const { 
      providerUserId, 
      accessToken, 
      refreshToken, 
      profileData, 
      linkToUserId, // Optional: link to specific user
      email,
      emailVerified 
    } = req.body;

    if (!providerUserId || !accessToken) {
      return res.status(400).json({ 
        message: 'providerUserId and accessToken are required' 
      });
    }

    const result = await db.transaction(async (client) => {
      // Get or create provider
      let providerRes = await client.query(
        `SELECT id FROM oauth_providers WHERE provider_name = $1`,
        [provider]
      );
      let providerId = providerRes.rows.length ? providerRes.rows[0].id : null;

      if (!providerId) {
        const insertProv = await client.query(
          `INSERT INTO oauth_providers (provider_name) VALUES ($1) RETURNING id`,
          [provider]
        );
        providerId = insertProv.rows[0].id;
      }

      let user = null;

      // If linking to specific user (manual linking)
      if (linkToUserId) {
        const userRes = await client.query(
          `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [linkToUserId]
        );
        user = userRes.rows[0];
        
        if (!user) {
          throw { status: 404, message: 'User not found' };
        }

        // Check if provider is already linked to another user
        const existingLink = await client.query(
          `SELECT user_id FROM user_oauth_connections 
           WHERE provider_id = $1 AND provider_user_id = $2 AND deleted_at IS NULL`,
          [providerId, providerUserId]
        );

        if (existingLink.rows.length > 0 && existingLink.rows[0].user_id !== linkToUserId) {
          throw { 
            status: 409, 
            message: `This ${provider} account is already linked to another user` 
          };
        }

        // Link the account
        await client.query(
          `INSERT INTO user_oauth_connections 
           (user_id, provider_id, provider_user_id, access_token, refresh_token, 
            token_expires_at, profile_data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour', $6, NOW(), NOW())
           ON CONFLICT (user_id, provider_id) 
           DO UPDATE SET 
             provider_user_id = $3,
             access_token = $4,
             refresh_token = $5,
             token_expires_at = NOW() + INTERVAL '1 hour',
             profile_data = $6,
             updated_at = NOW()`,
          [linkToUserId, providerId, providerUserId, accessToken, refreshToken || null, 
           profileData ? JSON.stringify(profileData) : null]
        );

        return { 
          success: true, 
          message: `${provider} account linked successfully`,
          user: { id: user.id, username: user.username, email: user.email }
        };
      }

      // Standard OAuth flow (find/create user)
      // 1. Check by provider ID first
      let userResult = await client.query(
        `SELECT u.*
         FROM users u
         JOIN user_oauth_connections c ON u.id = c.user_id
         WHERE c.provider_id = $1 AND c.provider_user_id = $2 AND u.deleted_at IS NULL`,
        [providerId, providerUserId]
      );
      user = userResult.rows[0];

      if (!user && email && emailVerified) {
        // 2. Check by email if verified
        userResult = await client.query(
          `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
          [email]
        );
        user = userResult.rows[0];

        if (user) {
          // Link existing user
          await client.query(
            `INSERT INTO user_oauth_connections 
             (user_id, provider_id, provider_user_id, access_token, refresh_token, 
              token_expires_at, profile_data, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour', $6, NOW(), NOW())
             ON CONFLICT (user_id, provider_id) 
             DO UPDATE SET 
               provider_user_id = $3,
               access_token = $4,
               refresh_token = $5,
               token_expires_at = NOW() + INTERVAL '1 hour',
               profile_data = $6,
               updated_at = NOW()`,
            [user.id, providerId, providerUserId, accessToken, refreshToken || null, 
             profileData ? JSON.stringify(profileData) : null]
          );
        }
      }

      if (!user) {
        // 3. Create new user (if email provided)
        if (email) {
          const name = profileData?.name || email.split('@')[0];
          const profileImageUrl = profileData?.picture || null;
          
          const newUserResult = await client.query(
            `INSERT INTO users (username, email, email_verified, profile_image_url, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             RETURNING *`,
            [name, email, emailVerified || false, profileImageUrl]
          );
          user = newUserResult.rows[0];

          // Link OAuth account
          await client.query(
            `INSERT INTO user_oauth_connections 
             (user_id, provider_id, provider_user_id, access_token, refresh_token, 
              token_expires_at, profile_data, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour', $6, NOW(), NOW())`,
            [user.id, providerId, providerUserId, accessToken, refreshToken || null, 
             profileData ? JSON.stringify(profileData) : null]
          );

          // Assign default role
          await client.query(
            `INSERT INTO user_roles (user_id, role_id)
             VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))`,
            [user.id]
          );

          // Create user settings with private mode and connection code
          const connectionCodeResult = await client.query(
            `SELECT public.generate_user_connection_code() as code`
          );

          await client.query(
            `INSERT INTO user_settings (user_id, privacy_settings, created_at, updated_at)
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id, JSON.stringify({
              privacy_mode: 'standard',
              show_email_to_connections: false,
              allow_connection_requests: true,
              allow_group_invites_from_connections: true,
              searchable_by_username: false,
              searchable_by_email: false,
              searchable_by_name: false,
              show_mutual_connections: false,
              connection_code: connectionCodeResult.rows[0].code
            })]
          );
        } else {
          // No email provided and no existing user found
          throw { 
            status: 400, 
            message: 'Unable to link account. Please provide an email or link to an existing account.' 
          };
        }
      }

      // Update last login
      await client.query(
        `UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [user.id]
      );

      // Log successful OAuth login
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'login', $2, $3, $4)`,
        [
          user.id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ method: provider, oauth: true })
        ]
      );

      // Generate JWT tokens
      const appAccessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: jwtExpiresIn });
      const appRefreshToken = generateRefreshToken();
      const appRefreshTokenExpiresAt = new Date();
      appRefreshTokenExpiresAt.setDate(appRefreshTokenExpiresAt.getDate() + 30);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token) DO UPDATE SET expires_at = $3`,
        [user.id, appRefreshToken, appRefreshTokenExpiresAt]
      );

      await client.query(
        `INSERT INTO user_sessions (user_id, token, refresh_token, ip_address, user_agent, expires_at)
         VALUES ($1,$2,$3,$4,$5, NOW() + INTERVAL '30 days')
         ON CONFLICT DO NOTHING`,
        [user.id, appAccessToken, appRefreshToken, req.ip, req.headers['user-agent']]
      );

      return { 
        appAccessToken, 
        appRefreshToken, 
        user: { id: user.id, username: user.username, email: user.email }
      };
    });

    res.json(result);
  } catch (error) {
    console.error(`[Enhanced OAuth ${provider}] Callback error:`, error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    res.status(500).json({ message: 'OAuth authentication failed' });
  }
};

module.exports = {
  register,
  verifyEmail,
  resendVerification,
  login,
  refreshToken,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
  changePassword,
  oauthCallback,
  passportCallback,
  mobileOauth,
  getAllUsers,
  linkOAuthAccount,
  unlinkOAuthAccount,
  getLinkedAccounts,
  enhancedOAuthCallback
}; 
