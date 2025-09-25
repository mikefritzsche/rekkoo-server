-- Migration: Set new users to Standard Mode by default
-- This changes the default privacy mode from 'private' to 'standard' for new user registrations

BEGIN;

-- Update the user_settings table default value for privacy_settings
ALTER TABLE public.user_settings
ALTER COLUMN privacy_settings SET DEFAULT jsonb_build_object(
    'privacy_mode', 'standard',
    'show_email_to_connections', false,
    'allow_connection_requests', true,
    'allow_group_invites_from_connections', true,
    'searchable_by_username', true,  -- Enable username search in Standard Mode
    'searchable_by_email', false,     -- Keep email search disabled by default
    'searchable_by_name', false,      -- Keep name search disabled by default
    'show_mutual_connections', true,   -- Show mutual connections in Standard Mode
    'show_in_suggestions', true,      -- Allow discovery in suggestions
    'auto_accept_connections', false, -- Don't auto-accept by default
    'require_approval_for_all', true,  -- Require approval for connections
    'allowListInvitations', 'connections', -- Only connections can send list invitations
    'show_in_group_members', true,    -- Show in group member lists
    'anonymous_in_groups', false       -- Don't be anonymous in groups
);

-- Update existing users who are still in private mode and haven't customized their settings
-- Only update users who have the exact private mode defaults (to avoid overriding customized settings)
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object(
    'privacy_mode', 'standard',
    'searchable_by_username', true,
    'show_mutual_connections', true,
    'show_in_suggestions', true
)
WHERE privacy_settings->>'privacy_mode' = 'private'
  AND privacy_settings->>'searchable_by_username' = 'false'
  AND privacy_settings->>'show_mutual_connections' = 'false'
  AND privacy_settings->>'searchable_by_email' = 'false'
  AND privacy_settings->>'searchable_by_name' = 'false'
  AND (privacy_settings->>'show_in_suggestions' IS NULL
       OR privacy_settings->>'show_in_suggestions' = 'false');

-- Create or replace function to ensure Standard Mode defaults for new users
CREATE OR REPLACE FUNCTION public.ensure_standard_mode_defaults()
RETURNS TRIGGER AS $$
BEGIN
    -- Only set defaults if privacy_settings is null or doesn't have privacy_mode
    IF NEW.privacy_settings IS NULL OR NOT (NEW.privacy_settings ? 'privacy_mode') THEN
        NEW.privacy_settings = jsonb_build_object(
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
            'anonymous_in_groups', false
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS ensure_user_privacy_defaults ON public.user_settings;

-- Create trigger to apply Standard Mode defaults
CREATE TRIGGER ensure_user_privacy_defaults
BEFORE INSERT OR UPDATE OF privacy_settings ON public.user_settings
FOR EACH ROW
WHEN (NEW.privacy_settings IS NULL OR NOT (NEW.privacy_settings ? 'privacy_mode'))
EXECUTE FUNCTION public.ensure_standard_mode_defaults();

-- Log the changes
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM public.user_settings
    WHERE privacy_settings->>'privacy_mode' = 'standard';

    RAISE NOTICE 'Updated default privacy mode to Standard. % users now in Standard Mode.', v_count;
END $$;

COMMIT;