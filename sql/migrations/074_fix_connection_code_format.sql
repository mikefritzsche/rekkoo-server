-- Migration: Fix connection code format to be 6-character alphanumeric instead of 4-digit numeric
-- Purpose: Update the generate_user_connection_code function to create more secure and user-friendly codes

-- Drop the old function and create a new one with 6-character alphanumeric codes
CREATE OR REPLACE FUNCTION public.generate_user_connection_code()
RETURNS VARCHAR(20) AS $$
DECLARE
    code VARCHAR(20);
    code_exists BOOLEAN;
    chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    chars_length INTEGER := LENGTH(chars);
    i INTEGER;
BEGIN
    LOOP
        -- Generate a random 6-character alphanumeric code
        code := '';
        FOR i IN 1..6 LOOP
            code := code || SUBSTR(chars, FLOOR(RANDOM() * chars_length + 1)::INTEGER, 1);
        END LOOP;

        -- Check if code already exists in user_settings
        SELECT EXISTS(
            SELECT 1 FROM public.user_settings
            WHERE privacy_settings->>'connection_code' = code
        ) INTO code_exists;

        -- If code doesn't exist, we can use it
        IF NOT code_exists THEN
            RETURN code;
        END IF;
        -- Otherwise loop and try again
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Update all existing 4-digit codes to new 6-character format
-- This will regenerate codes for all users who have them
DO $$
DECLARE
    user_record RECORD;
    new_code VARCHAR(20);
BEGIN
    FOR user_record IN
        SELECT user_id, privacy_settings
        FROM public.user_settings
        WHERE privacy_settings->>'connection_code' IS NOT NULL
          AND LENGTH(privacy_settings->>'connection_code') = 4  -- Only update 4-digit codes
    LOOP
        -- Generate a new code for this user
        new_code := public.generate_user_connection_code();

        -- Update the user's connection code
        UPDATE public.user_settings
        SET privacy_settings = jsonb_set(
            privacy_settings,
            '{connection_code}',
            to_jsonb(new_code)
        )
        WHERE user_id = user_record.user_id;

        RAISE NOTICE 'Updated connection code for user %: % -> %',
            user_record.user_id,
            user_record.privacy_settings->>'connection_code',
            new_code;
    END LOOP;
END $$;

-- Add a comment about the new format
COMMENT ON FUNCTION public.generate_user_connection_code() IS 'Generates a unique 6-character alphanumeric connection code for users in private mode';

-- Verify the update
DO $$
DECLARE
    old_format_count INTEGER;
    new_format_count INTEGER;
    total_codes INTEGER;
BEGIN
    -- Count codes with old format (4 digits)
    SELECT COUNT(*) INTO old_format_count
    FROM public.user_settings
    WHERE privacy_settings->>'connection_code' ~ '^\d{4}$';

    -- Count codes with new format (6 alphanumeric)
    SELECT COUNT(*) INTO new_format_count
    FROM public.user_settings
    WHERE privacy_settings->>'connection_code' ~ '^[A-Z0-9]{6}$';

    -- Total codes
    SELECT COUNT(*) INTO total_codes
    FROM public.user_settings
    WHERE privacy_settings->>'connection_code' IS NOT NULL;

    RAISE NOTICE 'Connection code format update complete:';
    RAISE NOTICE '  Old format (4-digit): %', old_format_count;
    RAISE NOTICE '  New format (6-char alphanumeric): %', new_format_count;
    RAISE NOTICE '  Total connection codes: %', total_codes;

    IF old_format_count > 0 THEN
        RAISE WARNING 'There are still % codes in old format!', old_format_count;
    END IF;
END $$;