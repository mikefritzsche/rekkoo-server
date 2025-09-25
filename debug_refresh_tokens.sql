-- Test script to verify refresh token functionality

-- 1. First, let's check if the refresh_tokens table exists and has data
SELECT
    'Refresh Tokens Table Check' as check_name,
    COUNT(*) as token_count,
    MAX(expires_at) as latest_expiration
FROM refresh_tokens
WHERE created_at > NOW() - INTERVAL '1 day';

-- 2. Check if users have refresh tokens
SELECT
    u.username,
    u.email,
    u.last_login_at,
    COUNT(rt.id) as refresh_token_count
FROM users u
LEFT JOIN refresh_tokens rt ON u.id = rt.user_id
    AND rt.revoked = false
    AND rt.expires_at > NOW()
WHERE u.deleted_at IS NULL
GROUP BY u.id, u.username, u.email, u.last_login_at
HAVING COUNT(rt.id) = 0 OR u.last_login_at > NOW() - INTERVAL '1 day'
ORDER BY u.last_login_at DESC NULLS LAST
LIMIT 10;

-- 3. Check recent auth logs to see if refresh tokens are being used
SELECT
    event_type,
    COUNT(*) as count,
    MAX(created_at) as last_occurrence
FROM auth_logs
WHERE event_type IN ('login', 'refresh_token_success', 'refresh_token_failed')
    AND created_at > NOW() - INTERVAL '1 day'
GROUP BY event_type
ORDER BY last_occurrence DESC;

-- 4. Verify the auth endpoint structure
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'refresh_tokens'
    AND table_schema = 'public'
ORDER BY ordinal_position;