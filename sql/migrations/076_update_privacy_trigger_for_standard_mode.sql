-- Migration: Update privacy settings trigger to properly handle Standard Mode
-- This ensures Standard Mode users get appropriate default settings

BEGIN;

-- Update the update_user_privacy_settings function to include Standard Mode logic
CREATE OR REPLACE FUNCTION public.update_user_privacy_settings()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate connection code if user is in private mode and doesn't have one
    IF NEW.privacy_settings->>'privacy_mode' = 'private'
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object('connection_code', public.generate_user_connection_code());
    END IF;

    -- Remove connection code if not in private mode
    IF NEW.privacy_settings->>'privacy_mode' != 'private' THEN
        NEW.privacy_settings = NEW.privacy_settings - 'connection_code';
    END IF;

    -- Update settings based on privacy mode
    IF NEW.privacy_settings->>'privacy_mode' = 'ghost' THEN
        -- Ghost mode: completely invisible
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', false,
                'searchable_by_email', false,
                'searchable_by_name', false,
                'show_in_suggestions', false,
                'show_in_group_members', false,
                'anonymous_in_groups', true
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'private' THEN
        -- Private mode: limited visibility but can be discovered for connections
        -- Don't force show_in_suggestions to false - let users control this
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', false,
                'searchable_by_email', false,
                'searchable_by_name', false
                -- Remove forced 'show_in_suggestions', false
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'standard' THEN
        -- Standard mode: balanced privacy with auto-additions enabled by default
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', true,
                'show_in_suggestions', true,
                'show_mutual_connections', true,
                'show_in_group_members', true
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'public' THEN
        -- Public mode: fully discoverable
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', true,
                'searchable_by_name', true,
                'searchable_by_email', true,
                'show_in_suggestions', true,
                'auto_accept_connections', COALESCE((NEW.privacy_settings->>'auto_accept_connections')::boolean, true)
            );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update the comment to reflect Standard Mode as the default
COMMENT ON COLUMN public.user_settings.privacy_settings IS
'User privacy preferences. Privacy modes:
- ghost: Completely invisible, only discoverable via connection code (show_in_suggestions always false)
- private: Limited visibility, requires connection to see details (show_in_suggestions can be true/false)
- standard: Balanced privacy with user controls (show_in_suggestions defaults to true, auto-additions enabled)
- public: Fully discoverable and visible (show_in_suggestions always true)

Key settings:
- show_in_suggestions: Whether user appears in connection suggestions (user-controlled except for ghost/public modes)
- searchable_by_username/email/name: Search visibility controls
- auto_accept_connections: Automatically accept connection requests (public mode only)
- connection_code: Required for private mode users to be discovered
- autoAddPreferences: Control automatic group/list additions (enabled by default in standard mode)';

-- Log the migration
DO $$
BEGIN
    RAISE NOTICE 'Updated privacy settings trigger to properly handle Standard Mode defaults';
END $$;

COMMIT;