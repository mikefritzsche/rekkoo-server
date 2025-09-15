-- Quick fix to update connection code format from 4-digit to 6-character alphanumeric
-- Run this directly in your database to immediately fix the issue

-- First, update the function to generate 6-character codes
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

        -- Check if code already exists
        SELECT EXISTS(
            SELECT 1 FROM public.user_settings
            WHERE privacy_settings->>'connection_code' = code
        ) INTO code_exists;

        IF NOT code_exists THEN
            RETURN code;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Update all existing 4-digit codes to new format
DO $$
DECLARE
    user_record RECORD;
    new_code VARCHAR(20);
    updated_count INTEGER := 0;
BEGIN
    FOR user_record IN
        SELECT user_id, privacy_settings->>'connection_code' as old_code
        FROM public.user_settings
        WHERE privacy_settings->>'connection_code' IS NOT NULL
          AND LENGTH(privacy_settings->>'connection_code') = 4
    LOOP
        new_code := public.generate_user_connection_code();

        UPDATE public.user_settings
        SET privacy_settings = jsonb_set(
            privacy_settings,
            '{connection_code}',
            to_jsonb(new_code)
        )
        WHERE user_id = user_record.user_id;

        updated_count := updated_count + 1;
        RAISE NOTICE 'Updated user %: % -> %', user_record.user_id, user_record.old_code, new_code;
    END LOOP;

    RAISE NOTICE '';
    RAISE NOTICE 'Successfully updated % connection codes to 6-character format', updated_count;
END $$;

-- Show results
SELECT
    user_id,
    privacy_settings->>'connection_code' as connection_code,
    privacy_settings->>'privacy_mode' as privacy_mode
FROM public.user_settings
WHERE privacy_settings->>'connection_code' IS NOT NULL
ORDER BY user_id;