-- Script to update a user's auto-add preferences using their email
-- This will fix the stored values to match what the user wants (disabled)

-- First, find your user by email (replace with your actual email)
SELECT
    u.id,
    u.email,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->'autoAddPreferences' as current_auto_add_preferences
FROM users u
JOIN user_settings us ON u.id = us.user_id
WHERE u.email = 'your-email@example.com';  -- <-- REPLACE THIS WITH YOUR EMAIL

-- Once you have the user ID from the above query, use it in the UPDATE below:
-- Copy the ID from the first query result and paste it below

UPDATE user_settings
SET privacy_settings = jsonb_set(
    privacy_settings,
    '{autoAddPreferences,allowAutomaticGroupAdditions}',
    'false'::jsonb
)
WHERE user_id = 'PASTE_USER_ID_HERE';  -- <-- PASTE THE ACTUAL USER ID HERE

UPDATE user_settings
SET privacy_settings = jsonb_set(
    privacy_settings,
    '{autoAddPreferences,allowAutomaticListAdditions}',
    'false'::jsonb
)
WHERE user_id = 'PASTE_USER_ID_HERE';  <-- PASTE THE ACTUAL USER ID HERE

-- Verify the update worked
SELECT
    u.id,
    u.email,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->'autoAddPreferences' as updated_auto_add_preferences
FROM users u
JOIN user_settings us ON u.id = us.user_id
WHERE u.email = 'your-email@example.com';  -- <-- USE THE SAME EMAIL HERE