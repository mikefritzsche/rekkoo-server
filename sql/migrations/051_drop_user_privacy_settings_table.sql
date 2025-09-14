-- MIGRATION: 051_drop_user_privacy_settings_table.sql
-- Description: Drop the user_privacy_settings table after successful migration to user_settings.privacy_settings
-- WARNING: Only run this after verifying all data has been successfully migrated!

-- First verify that all privacy settings have been migrated
DO $$
DECLARE
    original_count INTEGER;
    migrated_count INTEGER;
BEGIN
    -- Count original privacy settings
    SELECT COUNT(*) INTO original_count FROM public.user_privacy_settings;

    -- Count migrated privacy settings
    SELECT COUNT(*) INTO migrated_count
    FROM public.user_settings
    WHERE privacy_settings ? 'privacy_mode';

    IF original_count > 0 AND migrated_count < original_count THEN
        RAISE EXCEPTION 'Not all privacy settings have been migrated. Original: %, Migrated: %',
                        original_count, migrated_count;
    END IF;

    RAISE NOTICE 'Verified % privacy settings have been migrated', migrated_count;
END $$;

-- Drop triggers first
DROP TRIGGER IF EXISTS set_privacy_settings_defaults ON public.user_privacy_settings;
DROP TRIGGER IF EXISTS update_user_privacy_settings_updated_at ON public.user_privacy_settings;
DROP TRIGGER IF EXISTS sync_log_trigger_user_privacy_settings ON public.user_privacy_settings;

-- Drop indexes
DROP INDEX IF EXISTS idx_user_privacy_settings_privacy_mode;
DROP INDEX IF EXISTS idx_user_privacy_settings_searchable;
DROP INDEX IF EXISTS idx_user_privacy_settings_connection_code;

-- Drop the table
DROP TABLE IF EXISTS public.user_privacy_settings;

-- Drop the old functions that were specific to user_privacy_settings
DROP FUNCTION IF EXISTS public.set_user_connection_code();

-- Note: We keep generate_connection_code() and generate_user_connection_code()
-- as they're now used by the user_settings trigger

-- Verify the table has been dropped
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public'
               AND table_name = 'user_privacy_settings') THEN
        RAISE EXCEPTION 'Failed to drop table public.user_privacy_settings';
    ELSE
        RAISE NOTICE 'Table public.user_privacy_settings has been successfully dropped';
    END IF;
END $$;

-- Add comment to document the migration
COMMENT ON COLUMN public.user_settings.privacy_settings IS
'User privacy preferences migrated from user_privacy_settings table. Includes visibility settings, connection settings, and privacy mode (private/standard/public)';