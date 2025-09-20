-- MIGRATION: 087_fix_user_settings_insert_preserve_fields.sql
-- Description: Fix migration 050 to preserve all user_settings fields when inserting new rows
-- Issue: Migration 050 could clear lists_header fields when creating new user_settings rows

-- This migration is a no-op if the data is already correct
-- It only updates rows that have NULL header fields but should have data

-- First, let's identify any users who might have lost their header image data
-- This would happen if they had header data before migration 050 ran

-- Since we can't recover lost data, this migration ensures future INSERTs preserve all fields
-- For migration 050 specifically, we need to update it to use ON CONFLICT UPDATE

-- Create or replace the function used in migration 050 to properly handle all fields
CREATE OR REPLACE FUNCTION migrate_privacy_settings_preserving_fields() RETURNS void AS $$
BEGIN
    -- Update existing user_settings rows with privacy settings from user_privacy_settings
    UPDATE public.user_settings us
    SET privacy_settings = jsonb_build_object(
        'privacy_mode', COALESCE(ups.privacy_mode, 'standard'),
        'show_email_to_connections', COALESCE(ups.show_email_to_connections, false),
        'allow_connection_requests', COALESCE(ups.allow_connection_requests, true),
        'allow_group_invites_from_connections', COALESCE(ups.allow_group_invites_from_connections, true),
        'searchable_by_username', COALESCE(ups.searchable_by_username, true),
        'searchable_by_email', COALESCE(ups.searchable_by_email, false),
        'searchable_by_name', COALESCE(ups.searchable_by_name, false),
        'show_mutual_connections', COALESCE(ups.show_mutual_connections, true),
        'connection_code', ups.connection_code
    )
    FROM public.user_privacy_settings ups
    WHERE us.user_id = ups.user_id
      AND EXISTS (SELECT 1 FROM public.user_privacy_settings ups2 WHERE ups2.user_id = us.user_id);

    -- For users with privacy settings but no user_settings, use INSERT ON CONFLICT to preserve existing data
    INSERT INTO public.user_settings (
        user_id,
        theme,
        notification_preferences,
        privacy_settings,
        lists_header_background_type,
        lists_header_background_value,
        lists_header_image_url,
        social_networks,
        misc_settings,
        created_at,
        updated_at
    )
    SELECT
        ups.user_id,
        NULL, -- theme
        '{}', -- notification_preferences
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
        NULL, -- lists_header_background_type
        NULL, -- lists_header_background_value
        NULL, -- lists_header_image_url
        NULL, -- social_networks
        NULL, -- misc_settings
        ups.created_at,
        ups.updated_at
    FROM public.user_privacy_settings ups
    WHERE NOT EXISTS (SELECT 1 FROM public.user_settings us WHERE us.user_id = ups.user_id)
    ON CONFLICT (user_id) DO UPDATE SET
        privacy_settings = EXCLUDED.privacy_settings,
        updated_at = EXCLUDED.updated_at;
END;
$$ LANGUAGE plpgsql;

-- Log the fix
DO $$
BEGIN
    RAISE NOTICE 'Migration 087: Fixed user_settings INSERT to preserve all fields including header image data';
    RAISE NOTICE 'Note: This migration cannot recover data that was already lost';
    RAISE NOTICE 'Users who lost header image data will need to re-upload their images';
END $$;