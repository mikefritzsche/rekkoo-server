-- Check current privacy settings distribution
SELECT
    privacy_settings->>'privacy_mode' as privacy_mode,
    privacy_settings->>'show_in_suggestions' as show_in_suggestions,
    COUNT(*) as user_count
FROM user_settings
GROUP BY
    privacy_settings->>'privacy_mode',
    privacy_settings->>'show_in_suggestions'
ORDER BY privacy_mode, show_in_suggestions;

-- Preview which users would be updated
SELECT
    u.username,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->>'show_in_suggestions' as current_show_in_suggestions,
    CASE
        WHEN us.privacy_settings->>'privacy_mode' IN ('private', 'standard', 'public') THEN 'true'
        WHEN us.privacy_settings->>'privacy_mode' = 'ghost' THEN 'false'
        ELSE us.privacy_settings->>'show_in_suggestions'
    END as new_show_in_suggestions
FROM users u
JOIN user_settings us ON u.id = us.user_id
WHERE u.deleted_at IS NULL
ORDER BY u.username
LIMIT 20;

-- Count how many users would become visible after the fix
SELECT
    COUNT(*) as will_be_visible
FROM user_settings
WHERE privacy_settings->>'privacy_mode' IN ('private', 'standard', 'public')
  AND (privacy_settings->>'show_in_suggestions' = 'false'
       OR privacy_settings->>'show_in_suggestions' IS NULL);