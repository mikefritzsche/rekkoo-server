-- Quick fix to make users visible in suggestions
-- Run this directly on the database as a temporary fix
-- The proper fix is in migration 073_fix_show_in_suggestions.sql

-- Show current state
SELECT
    privacy_settings->>'privacy_mode' as privacy_mode,
    privacy_settings->>'show_in_suggestions' as show_in_suggestions,
    COUNT(*) as user_count
FROM user_settings
GROUP BY
    privacy_settings->>'privacy_mode',
    privacy_settings->>'show_in_suggestions'
ORDER BY privacy_mode, show_in_suggestions;

-- Update all non-ghost users to show in suggestions
UPDATE user_settings
SET privacy_settings = jsonb_set(
    privacy_settings,
    '{show_in_suggestions}',
    'true'::jsonb
)
WHERE privacy_settings->>'privacy_mode' IN ('private', 'standard', 'public')
  AND (privacy_settings->>'show_in_suggestions' = 'false'
       OR privacy_settings->>'show_in_suggestions' IS NULL);

-- Verify the update
SELECT
    privacy_settings->>'privacy_mode' as privacy_mode,
    privacy_settings->>'show_in_suggestions' as show_in_suggestions,
    COUNT(*) as user_count
FROM user_settings
GROUP BY
    privacy_settings->>'privacy_mode',
    privacy_settings->>'show_in_suggestions'
ORDER BY privacy_mode, show_in_suggestions;

-- Show some sample users who should now be visible
SELECT
    u.username,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->>'show_in_suggestions' as show_in_suggestions
FROM users u
JOIN user_settings us ON u.id = us.user_id
WHERE u.deleted_at IS NULL
  AND us.privacy_settings->>'show_in_suggestions' = 'true'
LIMIT 10;