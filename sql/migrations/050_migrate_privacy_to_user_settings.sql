-- MIGRATION: 050_migrate_privacy_to_user_settings.sql
-- Description: Migrate privacy settings to user_settings.privacy_settings JSONB field
-- This consolidates privacy settings into the existing user_settings table instead of using a separate table

-- Update the privacy_settings JSONB field structure in user_settings
UPDATE public.user_settings
SET privacy_settings = jsonb_build_object(
    'privacy_mode', COALESCE(
        (SELECT privacy_mode FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        'standard'
    ),
    'show_email_to_connections', COALESCE(
        (SELECT show_email_to_connections FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        false
    ),
    'allow_connection_requests', COALESCE(
        (SELECT allow_connection_requests FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        true
    ),
    'allow_group_invites_from_connections', COALESCE(
        (SELECT allow_group_invites_from_connections FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        true
    ),
    'searchable_by_username', COALESCE(
        (SELECT searchable_by_username FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        true
    ),
    'searchable_by_email', COALESCE(
        (SELECT searchable_by_email FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        false
    ),
    'searchable_by_name', COALESCE(
        (SELECT searchable_by_name FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        false
    ),
    'show_mutual_connections', COALESCE(
        (SELECT show_mutual_connections FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id),
        true
    ),
    'connection_code', (SELECT connection_code FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id)
)
WHERE EXISTS (SELECT 1 FROM public.user_privacy_settings ups WHERE ups.user_id = user_settings.user_id);

-- For users without user_settings but with user_privacy_settings, insert new rows
INSERT INTO public.user_settings (user_id, privacy_settings, created_at, updated_at)
SELECT
    ups.user_id,
    jsonb_build_object(
        'privacy_mode', ups.privacy_mode,
        'show_email_to_connections', ups.show_email_to_connections,
        'allow_connection_requests', ups.allow_connection_requests,
        'allow_group_invites_from_connections', ups.allow_group_invites_from_connections,
        'searchable_by_username', ups.searchable_by_username,
        'searchable_by_email', ups.searchable_by_email,
        'searchable_by_name', ups.searchable_by_name,
        'show_mutual_connections', ups.show_mutual_connections,
        'connection_code', ups.connection_code
    ),
    ups.created_at,
    ups.updated_at
FROM public.user_privacy_settings ups
WHERE NOT EXISTS (SELECT 1 FROM public.user_settings us WHERE us.user_id = ups.user_id);

-- Set default privacy_settings for users without any privacy settings
UPDATE public.user_settings
SET privacy_settings = jsonb_build_object(
    'privacy_mode', 'standard',
    'show_email_to_connections', false,
    'allow_connection_requests', true,
    'allow_group_invites_from_connections', true,
    'searchable_by_username', true,
    'searchable_by_email', false,
    'searchable_by_name', false,
    'show_mutual_connections', true,
    'connection_code', null
)
WHERE privacy_settings IS NULL
   OR privacy_settings = '{}'::jsonb
   OR NOT (privacy_settings ? 'privacy_mode');

-- Create a function to generate unique connection codes (if it doesn't exist from the other migration)
CREATE OR REPLACE FUNCTION public.generate_user_connection_code()
RETURNS VARCHAR(20) AS $$
DECLARE
    code VARCHAR(20);
    code_exists BOOLEAN;
BEGIN
    LOOP
        -- Generate a random 4-digit code
        code := LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');

        -- Check if code already exists in user_settings
        SELECT EXISTS(
            SELECT 1 FROM public.user_settings
            WHERE privacy_settings->>'connection_code' = code
        ) INTO code_exists;

        EXIT WHEN NOT code_exists;
    END LOOP;

    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Function to update privacy settings and handle connection codes
CREATE OR REPLACE FUNCTION public.update_user_privacy_settings()
RETURNS TRIGGER AS $$
BEGIN
    -- Generate connection code if user is in private mode and doesn't have one
    IF NEW.privacy_settings->>'privacy_mode' = 'private'
       AND (NEW.privacy_settings->>'connection_code' IS NULL OR NEW.privacy_settings->>'connection_code' = '') THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object('connection_code', public.generate_user_connection_code());
    END IF;

    -- Update searchable settings based on privacy mode
    IF NEW.privacy_settings->>'privacy_mode' = 'private' THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', false,
                'searchable_by_email', false,
                'searchable_by_name', false
            );
    ELSIF NEW.privacy_settings->>'privacy_mode' = 'public' THEN
        NEW.privacy_settings = NEW.privacy_settings ||
            jsonb_build_object(
                'searchable_by_username', true,
                'searchable_by_name', true
            );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to handle privacy settings updates
DROP TRIGGER IF EXISTS update_user_privacy_settings_trigger ON public.user_settings;
CREATE TRIGGER update_user_privacy_settings_trigger
    BEFORE INSERT OR UPDATE OF privacy_settings ON public.user_settings
    FOR EACH ROW
    WHEN (NEW.privacy_settings IS NOT NULL)
    EXECUTE FUNCTION public.update_user_privacy_settings();

-- Add index for connection_code lookups
CREATE INDEX IF NOT EXISTS idx_user_settings_connection_code
    ON public.user_settings ((privacy_settings->>'connection_code'))
    WHERE privacy_settings->>'connection_code' IS NOT NULL;

-- Add index for privacy_mode lookups
CREATE INDEX IF NOT EXISTS idx_user_settings_privacy_mode
    ON public.user_settings ((privacy_settings->>'privacy_mode'));

-- Add comment
COMMENT ON COLUMN public.user_settings.privacy_settings IS 'User privacy preferences including visibility settings, connection settings, and privacy mode';

-- Note: The user_privacy_settings table will be dropped in a future migration after verifying data migration success
-- For now, we'll keep it for rollback purposes

-- Verify migration success
DO $$
DECLARE
    migrated_count INTEGER;
    original_count INTEGER;
BEGIN
    -- Count original privacy settings
    SELECT COUNT(*) INTO original_count FROM public.user_privacy_settings;

    -- Count migrated privacy settings
    SELECT COUNT(*) INTO migrated_count
    FROM public.user_settings
    WHERE privacy_settings ? 'privacy_mode';

    IF original_count > 0 THEN
        RAISE NOTICE 'Migrated % privacy settings from user_privacy_settings table', original_count;
    END IF;

    RAISE NOTICE 'Total user_settings with privacy settings: %', migrated_count;
END $$;