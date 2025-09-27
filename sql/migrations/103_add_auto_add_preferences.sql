-- Migration: Add auto_add_preferences to user_settings
-- Description: Adds autoAddPreferences to privacy_settings and creates helper function
-- Date: 2025-09-26
commit;
BEGIN;

-- Create a function to get auto-add preferences with proper defaults
CREATE OR REPLACE FUNCTION get_user_auto_add_preferences(p_user_id uuid)
RETURNS jsonb AS $$
DECLARE
    v_privacy_settings jsonb;
    v_auto_add_preferences jsonb;
BEGIN
    -- Get user's privacy settings
    SELECT privacy_settings INTO v_privacy_settings
    FROM user_settings
    WHERE user_id = p_user_id;

    -- If no settings found, return defaults
    IF v_privacy_settings IS NULL THEN
        RETURN jsonb_build_object(
            'allowAutomaticGroupAdditions', true,
            'allowAutomaticListAdditions', true,
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
            'allowAutomaticGroupAdditions', true,
            'allowAutomaticListAdditions', true,
            'notifyOnAutomaticAddition', true,
            'notificationChannels', jsonb_build_object(
                'in_app', true,
                'email', false,
                'push', false
            )
        )
    );

    -- Apply privacy mode overrides
    CASE v_privacy_settings->>'privacy_mode'
        WHEN 'ghost' THEN
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticGroupAdditions}',
                to_jsonb(false)
            );
        WHEN 'public' THEN
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticGroupAdditions}',
                to_jsonb(true)
            );
        WHEN 'standard' THEN
            v_auto_add_preferences := jsonb_set(
                v_auto_add_preferences,
                '{allowAutomaticGroupAdditions}',
                to_jsonb(true)
            );
        ELSE
            -- Private mode - use user's preference
    END CASE;

    RETURN v_auto_add_preferences;
END;
$$ LANGUAGE plpgsql;

-- Create function to check if user allows automatic group additions
CREATE OR REPLACE FUNCTION user_allows_automatic_group_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_auto_add_preferences jsonb;
BEGIN
    SELECT get_user_auto_add_preferences(p_user_id) INTO v_auto_add_preferences;

    RETURN COALESCE(
        v_auto_add_preferences->>'allowAutomaticGroupAdditions',
        false
    )::boolean;
END;
$$ LANGUAGE plpgsql STABLE;

-- Create function to check if user allows automatic list additions
CREATE OR REPLACE FUNCTION user_allows_automatic_list_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_auto_add_preferences jsonb;
BEGIN
    SELECT get_user_auto_add_preferences(p_user_id) INTO v_auto_add_preferences;

    RETURN COALESCE(
        v_auto_add_preferences->>'allowAutomaticListAdditions',
        false
    )::boolean;
END;
$$ LANGUAGE plpgsql STABLE;

-- Update existing user_settings to include autoAddPreferences with defaults
-- This migration preserves existing settings while adding the new field
UPDATE user_settings
SET privacy_settings = jsonb_set(
    privacy_settings,
    '{autoAddPreferences}',
    jsonb_build_object(
        'allowAutomaticGroupAdditions',
        CASE
            WHEN privacy_settings->>'privacy_mode' = 'ghost' THEN false
            WHEN privacy_settings->>'privacy_mode' = 'public' THEN true
            WHEN privacy_settings->>'privacy_mode' = 'standard' THEN true
            ELSE true -- Default for private mode
        END,
        'allowAutomaticListAdditions',
        CASE
            WHEN privacy_settings->>'privacy_mode' = 'ghost' THEN false
            WHEN privacy_settings->>'privacy_mode' = 'public' THEN true
            WHEN privacy_settings->>'privacy_mode' = 'standard' THEN true
            ELSE true -- Default for private mode
        END,
        'notifyOnAutomaticAddition', true,
        'notificationChannels', jsonb_build_object(
            'in_app', true,
            'email', false,
            'push', false
        )
    )
)
WHERE NOT (privacy_settings ? 'autoAddPreferences');

-- Update the default value for future user_settings
ALTER TABLE user_settings
ALTER COLUMN privacy_settings
SET DEFAULT jsonb_build_object(
    'privacy_mode', 'standard',
    'show_email_to_connections', false,
    'allow_connection_requests', true,
    'allow_group_invites_from_connections', true,
    'searchable_by_username', true,
    'searchable_by_email', false,
    'searchable_by_name', false,
    'show_mutual_connections', true,
    'show_in_suggestions', true,
    'auto_accept_connections', false,
    'require_approval_for_all', true,
    'allowListInvitations', 'connections',
    'show_in_group_members', true,
    'anonymous_in_groups', false,
    'autoAddPreferences', jsonb_build_object(
        'allowAutomaticGroupAdditions', true,
        'allowAutomaticListAdditions', true,
        'notifyOnAutomaticAddition', true,
        'notificationChannels', jsonb_build_object(
            'in_app', true,
            'email', false,
            'push', false
        )
    )
);

-- Add comments for documentation
COMMENT ON FUNCTION get_user_auto_add_preferences(uuid) IS 'Returns user''s auto-add preferences with privacy mode overrides applied';
COMMENT ON FUNCTION user_allows_automatic_group_additions(uuid) IS 'Checks if user allows automatic group additions based on their preferences and privacy mode';
COMMENT ON FUNCTION user_allows_automatic_list_additions(uuid) IS 'Checks if user allows automatic list additions based on their preferences and privacy mode';

COMMIT;