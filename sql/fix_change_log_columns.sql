-- Fix change_log table structure to match what the code expects
-- Run this to add missing columns and rename existing ones

-- 1. Check current structure
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'change_log'
ORDER BY ordinal_position;

-- 2. Add user_id column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'change_log'
        AND column_name = 'user_id'
    ) THEN
        ALTER TABLE change_log ADD COLUMN user_id UUID;

        -- Try to populate user_id from data if it's stored there
        UPDATE change_log
        SET user_id = (data->>'user_id')::uuid
        WHERE data->>'user_id' IS NOT NULL;
    END IF;
END $$;

-- 3. Rename changed_at to created_at if needed
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'change_log'
        AND column_name = 'changed_at'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'change_log'
        AND column_name = 'created_at'
    ) THEN
        ALTER TABLE change_log RENAME COLUMN changed_at TO created_at;
    END IF;
END $$;

-- 4. Add change_data column if it doesn't exist (rename data column if needed)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'change_log'
        AND column_name = 'data'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'change_log'
        AND column_name = 'change_data'
    ) THEN
        ALTER TABLE change_log RENAME COLUMN data TO change_data;
    END IF;
END $$;

-- 5. Create indexes after fixing columns
CREATE INDEX IF NOT EXISTS idx_change_log_user_created
ON change_log (user_id, created_at)
WHERE user_id IS NOT NULL;

-- 6. Show the final structure
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'change_log'
ORDER BY ordinal_position;

-- 7. Count records with and without user_id
SELECT
    COUNT(*) as total_records,
    COUNT(user_id) as records_with_user_id,
    COUNT(*) - COUNT(user_id) as records_without_user_id
FROM change_log;