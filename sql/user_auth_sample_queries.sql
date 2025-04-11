-- =============================================
-- User Registration & Account Management
-- =============================================

-- Register a new user
INSERT INTO users (username, email, password_hash, verification_token, verification_token_expires_at)
VALUES (
           'johndoe',
           'john@example.com',
           '$2a$10$somehashvalue', -- Use bcrypt for password hashing
           '7c9e6679-7425-40de-944b-e07fc1f90ae7', -- Generate a UUID for verification
           CURRENT_TIMESTAMP + INTERVAL '24 hours'
       );

-- After registration, assign the default 'user' role
INSERT INTO user_roles (user_id, role_id)
VALUES (
           (SELECT id FROM users WHERE email = 'john@example.com'),
           (SELECT id FROM roles WHERE name = 'user')
       );

-- Verify email address
UPDATE users
SET email_verified = true,
    verification_token = NULL,
    verification_token_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE verification_token = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  AND verification_token_expires_at > CURRENT_TIMESTAMP;

-- Initiate password reset
UPDATE users
SET reset_password_token = '8d7e5f3a-2b1c-40de-944b-e07fc1f90ae7',
    reset_password_token_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 hour',
    updated_at = CURRENT_TIMESTAMP
WHERE email = 'john@example.com'
  AND account_locked = false
RETURNING reset_password_token;

-- Complete password reset
UPDATE users
SET password_hash = '$2a$10$newhashvalue',
    reset_password_token = NULL,
    reset_password_token_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE reset_password_token = '8d7e5f3a-2b1c-40de-944b-e07fc1f90ae7'
  AND reset_password_token_expires_at > CURRENT_TIMESTAMP;

-- Change password (when user knows current password)
UPDATE users
SET password_hash = '$2a$10$newhashvalue',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Delete account (soft delete approach)
-- First, create a deleted_users table to keep records
CREATE TABLE deleted_users (
                               id SERIAL PRIMARY KEY,
                               original_user_id INTEGER NOT NULL,
                               username VARCHAR(50),
                               email VARCHAR(255),
                               reason TEXT,
                               deleted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                               metadata JSONB
);

-- Then perform soft delete
BEGIN;
-- Store information about deleted user
INSERT INTO deleted_users (original_user_id, username, email, reason, metadata)
SELECT id, username, email, 'User requested account deletion',
       jsonb_build_object(
               'last_login', last_login_at,
               'account_created', created_at,
               'lists_count', (SELECT COUNT(*) FROM lists WHERE owner_id = users.id)
       )
FROM users
WHERE id = 1;

-- Then delete the user (this will cascade to all related tables)
DELETE FROM users
WHERE id = 1;
COMMIT;

-- =============================================
-- Authentication & Login
-- =============================================

-- Get user by email or username for login
SELECT id, username, email, password_hash, email_verified, account_locked,
       failed_login_attempts, lockout_until
FROM users
WHERE (username = 'johndoe' OR email = 'john@example.com');

-- Record failed login attempt
UPDATE users
SET failed_login_attempts = failed_login_attempts + 1,
    -- Lock account after 5 failed attempts
    account_locked = CASE WHEN failed_login_attempts + 1 >= 5 THEN true ELSE account_locked END,
    -- Lock for 30 minutes
    lockout_until = CASE WHEN failed_login_attempts + 1 >= 5
                             THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes'
                         ELSE lockout_until END,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
RETURNING account_locked, lockout_until;

-- Record failed login in auth logs
INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
VALUES (
           1,
           'failed_login',
           '192.168.1.1',
           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
           '{"reason": "incorrect_password", "attempt": 3}'
       );

-- Reset failed login attempts on successful login
UPDATE users
SET failed_login_attempts = 0,
    account_locked = false,
    lockout_until = NULL,
    last_login_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

-- Create a new session on successful login
INSERT INTO user_sessions (user_id, token, ip_address, user_agent, expires_at)
VALUES (
           1,
           '93d3a3bf-57e4-4d6d-9ae5-137262a8cbf4', -- Generate a secure token
           '192.168.1.1',
           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
           CURRENT_TIMESTAMP + INTERVAL '30 days' -- Session expires in 30 days
       )
RETURNING token;

-- Record successful login in auth logs
INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
VALUES (
           1,
           'login',
           '192.168.1.1',
           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
           '{"session_id": "93d3a3bf-57e4-4d6d-9ae5-137262a8cbf4"}'
       );

-- Validate session (check if token is valid)
SELECT u.id, u.username, u.email, u.email_verified,
       s.expires_at, s.last_activity_at
FROM user_sessions s
         JOIN users u ON s.user_id = u.id
WHERE s.token = '93d3a3bf-57e4-4d6d-9ae5-137262a8cbf4'
  AND s.expires_at > CURRENT_TIMESTAMP
  AND u.account_locked = false;

-- Update session last activity timestamp
UPDATE user_sessions
SET last_activity_at = CURRENT_TIMESTAMP
WHERE token = '93d3a3bf-57e4-4d6d-9ae5-137262a8cbf4';

-- Logout (invalidate session)
DELETE FROM user_sessions
WHERE token = '93d3a3bf-57e4-4d6d-9ae5-137262a8cbf4';

-- Record logout in auth logs
INSERT INTO auth_logs (user_id, event_type, ip_address, user_agent, details)
VALUES (
           1,
           'logout',
           '192.168.1.1',
           'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
           '{"session_id": "93d3a3bf-57e4-4d6d-9ae5-137262a8cbf4"}'
       );

-- Logout from all devices
DELETE FROM user_sessions
WHERE user_id = 1;

-- =============================================
-- OAuth Authentication
-- =============================================

-- Find user by OAuth provider and provider user ID
SELECT u.*
FROM users u
         JOIN user_oauth_connections uoc ON u.id = uoc.user_id
         JOIN oauth_providers op ON uoc.provider_id = op.id
WHERE op.provider_name = 'google'
  AND uoc.provider_user_id = '123456789';

-- Create new OAuth connection for existing user
INSERT INTO user_oauth_connections (
    user_id,
    provider_id,
    provider_user_id,
    access_token,
    refresh_token,
    token_expires_at,
    profile_data
)
VALUES (
           1, -- Existing user ID
           (SELECT id FROM oauth_providers WHERE provider_name = 'google'),
           '123456789', -- Provider's user ID
           'ya29.a0AfB_byC3...', -- Access token
           '1//0eXYZ...', -- Refresh token
           CURRENT_TIMESTAMP + INTERVAL '1 hour', -- Token expiry
           '{"name": "John Doe", "picture": "https://example.com/photo.jpg", "email": "john@example.com"}'
       );

-- Register new user from OAuth (if user doesn't exist)
WITH new_user AS (
    INSERT INTO users (username, email, email_verified, password_hash)
        VALUES (
                   'john.doe.123', -- Generate a username based on OAuth data
                   'john@example.com',
                   true, -- Email is verified since it comes from OAuth provider
                   '' -- No password for OAuth users (or generate a random one)
               )
        RETURNING id
),
     role_assignment AS (
         INSERT INTO user_roles (user_id, role_id)
             SELECT
                 (SELECT id FROM new_user),
                 (SELECT id FROM roles WHERE name = 'user')
     )
INSERT INTO user_oauth_connections (
    user_id,
    provider_id,
    provider_user_id,
    access_token,
    refresh_token,
    token_expires_at,
    profile_data
)
VALUES (
           (SELECT id FROM new_user),
           (SELECT id FROM oauth_providers WHERE provider_name = 'google'),
           '123456789',
           'ya29.a0AfB_byC3...',
           '1//0eXYZ...',
           CURRENT_TIMESTAMP + INTERVAL '1 hour',
           '{"name": "John Doe", "picture": "https://example.com/photo.jpg", "email": "john@example.com"}'
       )
RETURNING user_id;

-- Update OAuth tokens
UPDATE user_oauth_connections
SET access_token = 'ya29.a0AfB_byC3_NEW...',
    refresh_token = '1//0eXYZ_NEW...',
    token_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 hour',
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 1
  AND provider_id = (SELECT id FROM oauth_providers WHERE provider_name = 'google');

-- Remove OAuth connection
DELETE FROM user_oauth_connections
WHERE user_id = 1
  AND provider_id = (SELECT id FROM oauth_providers WHERE provider_name = 'google');

-- =============================================
-- Role-Based Access Control
-- =============================================

-- Get all user's roles
SELECT r.name, r.description
FROM roles r
         JOIN user_roles ur ON r.id = ur.role_id
WHERE ur.user_id = 1;

-- Get all permissions for a user
SELECT DISTINCT p.name, p.description
FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         JOIN user_roles ur ON rp.role_id = ur.role_id
WHERE ur.user_id = 1;

-- Check if user has specific permission
SELECT EXISTS (
    SELECT 1
    FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             JOIN user_roles ur ON rp.role_id = ur.role_id
    WHERE ur.user_id = 1
      AND p.name = 'list:create'
) as has_permission;

-- Assign role to user
INSERT INTO user_roles (user_id, role_id, assigned_by)
VALUES (
           1, -- User to assign role to
           (SELECT id FROM roles WHERE name = 'moderator'),
           2  -- Admin user making the assignment
       );

-- Remove role from user
DELETE FROM user_roles
WHERE user_id = 1
  AND role_id = (SELECT id FROM roles WHERE name = 'moderator');

-- =============================================
-- Security and Audit
-- =============================================

-- Get recent login attempts for a user
SELECT event_type, ip_address, user_agent, details, created_at
FROM auth_logs
WHERE user_id = 1
  AND (event_type = 'login' OR event_type = 'failed_login')
ORDER BY created_at DESC
LIMIT 10;

-- Get active sessions for a user
SELECT id, ip_address, user_agent, created_at, last_activity_at, expires_at
FROM user_sessions
WHERE user_id = 1
  AND expires_at > CURRENT_TIMESTAMP
ORDER BY last_activity_at DESC;

-- Clean up expired sessions
DELETE FROM user_sessions
WHERE expires_at < CURRENT_TIMESTAMP;

-- Look for suspicious activity (multiple failed logins from different IPs)
SELECT ip_address, COUNT(*) as attempt_count
FROM auth_logs
WHERE event_type = 'failed_login'
  AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
GROUP BY ip_address
HAVING COUNT(*) > 10
ORDER BY attempt_count DESC;

-- Get locked accounts
SELECT id, username, email, failed_login_attempts, lockout_until
FROM users
WHERE account_locked = true
  AND lockout_until > CURRENT_TIMESTAMP;

-- Unlock account manually (admin function)
UPDATE users
SET account_locked = false,
    failed_login_attempts = 0,
    lockout_until = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;