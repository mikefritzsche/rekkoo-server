-- Script to update a specific user's auto-add preferences in the database
-- This will fix the stored values to match what the user wants

-- First, check the current values
SELECT
    u.id,
    u.email,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->'autoAddPreferences' as current_auto_add_preferences
FROM users u
JOIN user_settings us ON u.id = us.user_id
WHERE u.email = 'demo1@mikefritzsche.com'; -- Replace with the user's email

-- Update the user's auto-add preferences to be disabled
UPDATE user_settings
SET privacy_settings = jsonb_set(
    privacy_settings,
    '{autoAddPreferences,allowAutomaticGroupAdditions}',
    'false'::jsonb
)
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'; -- Replace with actual user ID

UPDATE user_settings
SET privacy_settings = jsonb_set(
    privacy_settings,
    '{autoAddPreferences,allowAutomaticListAdditions}',
    'false'::jsonb
)
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'; -- Replace with actual user ID

-- Verify the update
SELECT
    u.id,
    u.email,
    us.privacy_settings->>'privacy_mode' as privacy_mode,
    us.privacy_settings->'autoAddPreferences' as updated_auto_add_preferences
FROM users u
JOIN user_settings us ON u.id = us.user_id
WHERE u.id = '0320693e-043b-4750-92b4-742e298a5f7f'; -- Replace with actual user ID