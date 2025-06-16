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

      return { userId, verificationToken, username, email };
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
        expiresIn: '30 days' // Token expires in 1 hour
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
const refreshToken = async (req, res) => { // This is the function declaration for refreshToken
  try {
    let { token } = req.body;
    if (!token) {
      // Allow client to send { refreshToken }
      token = req.body.refreshToken;
    }
    if (!token) {
      return res.status(401).json({ message: 'Refresh token is required' });
    }

    const result = await db.transaction(async (client) => {
      // Find refresh token in database
      const tokenResult = await client.query(
        `SELECT user_id, expires_at FROM refresh_tokens WHERE token = $1`,
        [token]
      );

      if (tokenResult.rows.length === 0) {
        throw { status: 403, message: 'Invalid refresh token' };
      }

      const refreshTokenData = tokenResult.rows[0];

      // Check if refresh token has expired
      if (new Date(refreshTokenData.expires_at) < new Date()) {
        // Optionally, delete expired token
        await client.query(`DELETE FROM refresh_tokens WHERE token = $1`, [token]);
        throw { status: 403, message: 'Refresh token has expired' };
      }

      // Generate new access token
      const newAccessToken = jwt.sign({ userId: refreshTokenData.user_id }, process.env.JWT_SECRET, {
        expiresIn: '1h' // New access token expires in 1 hour
      });

      // Generate new refresh token
      const newRefreshTokenValue = generateRefreshToken();
      const newRefreshTokenExpiresAt = new Date();
      newRefreshTokenExpiresAt.setDate(newRefreshTokenExpiresAt.getDate() + 30); // 30 days

      // Update the existing refresh token with the new one and new expiry
      // Or, if you prefer a rolling refresh token, insert a new one and delete the old one
      await client.query(
        `UPDATE refresh_tokens 
         SET token = $1, expires_at = $2 
         WHERE user_id = $3 AND token = $4`,
        [newRefreshTokenValue, newRefreshTokenExpiresAt, refreshTokenData.user_id, token]
      );
      
      // Log token refresh event
      await client.query(
        `INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
         VALUES ($1, 'token_refresh', $2, $3, $4)`,
        [
          refreshTokenData.user_id,
          req.ip,
          req.headers['user-agent'],
          JSON.stringify({ new_access_token: newAccessToken, old_refresh_token: token, new_refresh_token: newRefreshTokenValue })
        ]
      );

      // Fetch user basic profile for response
      const userRes = await client.query(
        `SELECT id, username, email, full_name, profile_image_url FROM users WHERE id = $1`,
        [refreshTokenData.user_id]
      );
      const userObj = userRes.rows[0] || { id: refreshTokenData.user_id };

      return { newAccessToken, newRefreshToken: newRefreshTokenValue, userObj }; // Return with user
    });

    return res.status(200).json({
      accessToken: result.newAccessToken,
      refreshToken: result.newRefreshToken,
      user: result.userObj,
    });
  } catch (error) {
    console.error('Refresh token error:', error);
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

      // For traditional session-based logout (if applicable) you might clear session here
      // e.g., req.session.destroy(); 
      // For JWT, client just needs to discard the token. Server can blacklist it if needed.

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
         SET password_reset_token = $1,
             password_reset_token_expires_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [resetToken, resetTokenExpiresAt, user.id]
      );
      return { user, resetToken };
    });

    if (result && result.user && result.resetToken) {
      // Send password reset email
      const resetLink = `${process.env.CLIENT_URL}/reset-password?token=${result.resetToken}`;
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
         WHERE password_reset_token = $1 
           AND password_reset_token_expires_at > NOW()
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
             password_reset_token = NULL,
             password_reset_token_expires_at = NULL,
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
      // Check if user exists via OAuth provider ID
      let userResult = await client.query(
        `SELECT u.* 
         FROM users u 
         JOIN user_oauth_identities oi ON u.id = oi.user_id 
         WHERE oi.provider = $1 AND oi.provider_user_id = $2 AND u.deleted_at IS NULL`,
        [provider, providerId]
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
              `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (user_id, provider) DO UPDATE SET provider_user_id = $3`,
              [user.id, provider, providerId]
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
              `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id)
               VALUES ($1, $2, $3)`,
              [user.id, provider, providerId]
            );

            // Assign default role
            await client.query(
              `INSERT INTO user_roles (user_id, role_id)
               VALUES ($1, (SELECT id FROM roles WHERE name = 'user'))`,
              [user.id]
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

      // Generate your application's JWTs
      const appAccessToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
      const appRefreshToken = generateRefreshToken();
      const appRefreshTokenExpiresAt = new Date();
      appRefreshTokenExpiresAt.setDate(appRefreshTokenExpiresAt.getDate() + 30);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token) DO UPDATE SET expires_at = $3`,
        [user.id, appRefreshToken, appRefreshTokenExpiresAt]
      );

      return { appAccessToken, appRefreshToken, user };
    });

    // Redirect to frontend with tokens, or set cookies
    // Example: res.redirect(`${process.env.CLIENT_URL}/auth/callback?accessToken=${result.appAccessToken}&refreshToken=${result.appRefreshToken}`);
    return res.status(200).json({
      message: `Successfully authenticated with ${provider}`,
      accessToken: result.appAccessToken,
      refreshToken: result.appRefreshToken,
      user: {
        id: result.user.id,
        username: result.user.username,
        email: result.user.email
      }
    });

  } catch (error) {
    console.error(`[OAuth ${provider}] Callback error:`, error);
    if (error.status) {
      return res.status(error.status).json({ message: error.message });
    }
    // Redirect to an error page on the frontend
    // return res.redirect(`${process.env.CLIENT_URL}/auth/error?message=oauth_failed`);
    return res.status(500).json({ message: `Server error during ${provider} OAuth process` });
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
  getAllUsers
}; 