-- Run this manually on your remote database to fix auto-add preferences
-- This will update the get_user_auto_add_preferences function to respect user choices

-- First, check the current function
SELECT 'Current function definition:' as note;
SELECT pg_get_functiondef('get_user_auto_add_preferences'::regproc);

-- Update the function
CREATE OR REPLACE FUNCTION get_user_auto_add_preferences(p_user_id uuid)
RETURNS jsonb AS $$
DECLARE
    v_privacy_settings jsonb;
    v_auto_add_preferences jsonb;
    v_privacy_mode text;
BEGIN
    -- Get user's privacy settings
    SELECT privacy_settings INTO v_privacy_settings
    FROM user_settings
    WHERE user_id = p_user_id;

    -- Get privacy mode
    v_privacy_mode := COALESCE(v_privacy_settings->>'privacy_mode', 'standard');

    -- If no settings found, return defaults with auto-add disabled for privacy
    IF v_privacy_settings IS NULL THEN
        RETURN jsonb_build_object(
            'allowAutomaticGroupAdditions', false,
            'allowAutomaticListAdditions', false,
            'notifyOnAutomaticAddition', true,
            'notificationChannels', jsonb_build_object(
                'in_app', true,
                'email', false,
                'push', false
            )
        );
    END IF;

    -- Get auto_add_preferences if it exists, otherwise use defaults
    v_auto_add_preferences := COALESCE(
        v_privacy_settings->'autoAddPreferences',
        jsonb_build_object(
            'allowAutomaticGroupAdditions', false,
            'allowAutomaticListAdditions', false,
            'notifyOnAutomaticAddition', true,
            'notificationChannels', jsonb_build_object(
                'in_app', true,
                'email', false,
                'push', false
            )
        )
    );

    -- Only enforce mode-specific overrides for ghost and public modes
    -- Standard and private modes should respect user choice
    CASE v_privacy_mode
        WHEN 'ghost' THEN
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticGroupAdditions}',
                to_jsonb(false)
            );
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticListAdditions}',
                to_jsonb(false)
            );
        WHEN 'public' THEN
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticGroupAdditions}',
                to_jsonb(true)
            );
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticListAdditions}',
                to_jsonb(true)
            );
            -- Also enable all notification channels in public mode
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{notificationChannels,email}',
                to_jsonb(true)
            );
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{notificationChannels,push}',
                to_jsonb(true)
            );
        ELSE
            -- For standard and private modes, respect the user's explicit choice
            -- Don't override auto-add preferences
    END CASE;

    RETURN v_auto_add_preferences;
END;
$$ LANGUAGE plpgsql STABLE;

-- Add comment
COMMENT ON FUNCTION get_user_auto_add_preferences(uuid) IS 'Returns user''s auto-add preferences, respecting explicit choices for standard/private modes, enforcing only for ghost/public modes';

-- Verify the update
SELECT 'Updated function definition:' as note;
SELECT pg_get_functiondef('get_user_auto_add_preferences'::regproc);

-- Test with a specific user (replace with actual user ID)
-- SELECT get_user_auto_add_preferences('your-user-id-here');