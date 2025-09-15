-- Migration: Fix show_in_suggestions for private mode users
-- Previous migrations incorrectly set all private users to show_in_suggestions = false
-- This migration fixes that by allowing private users to be discoverable for connection requests

BEGIN;

-- Update existing users to show in suggestions (except ghost mode)
-- Private users should be discoverable for connection requests
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object(
    'show_in_suggestions', true
)
WHERE privacy_settings->>'privacy_mode' IN ('private', 'standard', 'public')
  AND (privacy_settings->>'show_in_suggestions' = 'false'
       OR privacy_settings->>'show_in_suggestions' IS NULL);

-- Only ghost mode users should be hidden from suggestions by default
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object(
    'show_in_suggestions', false
)
WHERE privacy_settings->>'privacy_mode' = 'ghost';

-- Update the trigger function to not force private users to hide from suggestions
CREATE OR REPLACE FUNCTION public.update_user_privacy_settings()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate connection code if user is in private mode and doesn't have one
    IF NEW.privacy_settings->>'privacy_mode' = 'private'
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object('connection_code', public.generate_user_connection_code());
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
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'public' THEN
        -- Public mode: fully discoverable
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', true,
                'searchable_by_name', true,
                'show_in_suggestions', true,
                'auto_accept_connections', COALESCE((NEW.privacy_settings->>'auto_accept_connections')::boolean, false)
            );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add a comment explaining the privacy modes
COMMENT ON COLUMN public.user_settings.privacy_settings IS
'User privacy preferences. Privacy modes:
- ghost: Completely invisible, only discoverable via connection code (show_in_suggestions always false)
- private: Limited visibility, requires connection to see details (show_in_suggestions can be true/false)
- standard: Balanced privacy with user controls (show_in_suggestions defaults to true)
- public: Fully discoverable and visible (show_in_suggestions always true)

Key settings:
- show_in_suggestions: Whether user appears in connection suggestions (user-controlled except for ghost/public modes)
- searchable_by_username/email/name: Search visibility controls
- auto_accept_connections: Automatically accept connection requests (public mode only)
- connection_code: Required for private mode users to be discovered';

-- Log the changes
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM public.user_settings
    WHERE privacy_settings->>'privacy_mode' IN ('private', 'standard', 'public')
      AND privacy_settings->>'show_in_suggestions' = 'true';

    RAISE NOTICE 'Updated % users to show in suggestions', v_count;
END $$;

COMMIT;