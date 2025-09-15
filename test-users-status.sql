-- Check the status of all users in the database
-- This query shows why users might not appear in suggestions

SELECT
    u.id,
    u.username,
    u.email,
    u.email_verified,
    u.deleted_at,
    u.created_at,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->>'show_in_suggestions' as show_in_suggestions,
    us.privacy_settings->>'searchable_by_username' as searchable_by_username,
    us.privacy_settings->>'allow_connection_requests' as allow_connection_requests,
    CASE
        WHEN u.deleted_at IS NOT NULL THEN 'EXCLUDED: deleted'
        WHEN COALESCE(us.privacy_settings->>'privacy_mode', 'standard') = 'ghost' THEN 'EXCLUDED: ghost mode'
        WHEN us.privacy_settings->>'show_in_suggestions' = 'false' THEN 'EXCLUDED: hidden by preference'
        ELSE 'ELIGIBLE'
    END as suggestion_eligibility,
    CASE
        WHEN u.email_verified IS NULL THEN 'NULL'
        WHEN u.email_verified = true THEN 'VERIFIED'
        ELSE 'NOT VERIFIED'
    END as email_status
FROM users u
LEFT JOIN user_settings us ON u.id = us.user_id
ORDER BY u.created_at DESC
LIMIT 20;

-- Count by eligibility
SELECT
    CASE
        WHEN u.deleted_at IS NOT NULL THEN 'deleted'
        WHEN COALESCE(us.privacy_settings->>'privacy_mode', 'standard') = 'ghost' THEN 'ghost mode'
        WHEN us.privacy_settings->>'show_in_suggestions' = 'false' THEN 'hidden by preference'
        ELSE 'eligible'
    END as status,
    COUNT(*) as count
FROM users u
LEFT JOIN user_settings us ON u.id = us.user_id
GROUP BY status
ORDER BY count DESC;

-- Check if there are any user_settings records at all
SELECT
    COUNT(*) as total_users,
    COUNT(us.user_id) as users_with_settings,
    COUNT(*) - COUNT(us.user_id) as users_without_settings
FROM users u
LEFT JOIN user_settings us ON u.id = us.user_id
WHERE u.deleted_at IS NULL;