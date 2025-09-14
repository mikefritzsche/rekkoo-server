-- MIGRATION: 052_set_all_users_private_mode.sql
-- Description: Set all existing users to private mode and update defaults for new users

-- Update all existing users to private mode
UPDATE public.user_settings
SET privacy_settings = jsonb_set(
    COALESCE(privacy_settings, '{}'::jsonb),
    '{privacy_mode}',
    '"private"'
),
updated_at = NOW()
WHERE user_id IS NOT NULL;

-- Generate connection codes for all users who don't have one
DO $$
DECLARE
    user_record RECORD;
    new_code VARCHAR(20);
BEGIN
    FOR user_record IN
        SELECT user_id, privacy_settings
        FROM public.user_settings
        WHERE (privacy_settings->>'connection_code' IS NULL
           OR privacy_settings->>'connection_code' = '')
    LOOP
        -- Generate unique connection code
        SELECT public.generate_user_connection_code() INTO new_code;

        -- Update the user's privacy settings with the connection code
        UPDATE public.user_settings
        SET privacy_settings = jsonb_set(
            COALESCE(privacy_settings, '{}'::jsonb),
            '{connection_code}',
            to_jsonb(new_code)
        )
        WHERE user_id = user_record.user_id;
    END LOOP;
END $$;

-- Update privacy settings to enforce private mode defaults
UPDATE public.user_settings
SET privacy_settings = privacy_settings || jsonb_build_object(
    'searchable_by_username', false,
    'searchable_by_email', false,
    'searchable_by_name', false,
    'allow_connection_requests', true,
    'allow_group_invites_from_connections', true,
    'show_mutual_connections', false,
    'show_email_to_connections', false
)
WHERE privacy_settings->>'privacy_mode' = 'private';

-- Update the default privacy_settings for the user_settings table
-- This ensures new rows get private mode by default
ALTER TABLE public.user_settings
ALTER COLUMN privacy_settings
SET DEFAULT jsonb_build_object(
    'privacy_mode', 'private',
    'show_email_to_connections', false,
    'allow_connection_requests', true,
    'allow_group_invites_from_connections', true,
    'searchable_by_username', false,
    'searchable_by_email', false,
    'searchable_by_name', false,
    'show_mutual_connections', false,
    'connection_code', null
);

-- Create or replace function to ensure new users get private mode
CREATE OR REPLACE FUNCTION public.ensure_private_mode_defaults()
RETURNS TRIGGER AS $$
BEGIN
    -- If privacy_settings is null or doesn't have privacy_mode, set to private
    IF NEW.privacy_settings IS NULL OR NOT (NEW.privacy_settings ? 'privacy_mode') THEN
        NEW.privacy_settings = jsonb_build_object(
            'privacy_mode', 'private',
            'show_email_to_connections', false,
            'allow_connection_requests', true,
            'allow_group_invites_from_connections', true,
            'searchable_by_username', false,
            'searchable_by_email', false,
            'searchable_by_name', false,
            'show_mutual_connections', false,
            'connection_code', public.generate_user_connection_code()
        );
    ELSIF NEW.privacy_settings->>'privacy_mode' IS NULL THEN
        -- If privacy_mode is null, set it to private
        NEW.privacy_settings = NEW.privacy_settings || jsonb_build_object(
            'privacy_mode', 'private',
            'connection_code', public.generate_user_connection_code()
        );
    END IF;

    -- Ensure private mode users have a connection code
    IF NEW.privacy_settings->>'privacy_mode' = 'private'
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = jsonb_set(
            NEW.privacy_settings,
            '{connection_code}',
            to_jsonb(public.generate_user_connection_code())
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists and create new one
DROP TRIGGER IF EXISTS ensure_private_mode_defaults_trigger ON public.user_settings;
CREATE TRIGGER ensure_private_mode_defaults_trigger
    BEFORE INSERT ON public.user_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.ensure_private_mode_defaults();

-- Verify the update
DO $$
DECLARE
    total_users INTEGER;
    private_users INTEGER;
    users_with_codes INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_users FROM public.user_settings;

    SELECT COUNT(*) INTO private_users
    FROM public.user_settings
    WHERE privacy_settings->>'privacy_mode' = 'private';

    SELECT COUNT(*) INTO users_with_codes
    FROM public.user_settings
    WHERE privacy_settings->>'connection_code' IS NOT NULL
      AND privacy_settings->>'connection_code' != '';

    RAISE NOTICE 'Total users: %', total_users;
    RAISE NOTICE 'Users set to private mode: %', private_users;
    RAISE NOTICE 'Users with connection codes: %', users_with_codes;

    IF total_users != private_users THEN
        RAISE WARNING 'Not all users were set to private mode!';
    END IF;
END $$;