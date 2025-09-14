-- Optional: Clean up duplicate rows in followers table
-- Run this BEFORE migration if you want to clean the source table first
-- This will keep the oldest active record for each (follower_id, followed_id) pair

BEGIN;

-- Step 1: Analyze duplicates before cleanup
DO $$
DECLARE
    total_rows INTEGER;
    unique_pairs INTEGER;
    duplicate_rows INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_rows FROM followers;

    SELECT COUNT(*) INTO unique_pairs
    FROM (
        SELECT DISTINCT follower_id, followed_id
        FROM followers
    ) unique_follows;

    duplicate_rows := total_rows - unique_pairs;

    RAISE NOTICE '=== Followers Table Analysis ===';
    RAISE NOTICE 'Total rows: %', total_rows;
    RAISE NOTICE 'Unique follower pairs: %', unique_pairs;
    RAISE NOTICE 'Duplicate rows to remove: %', duplicate_rows;
END $$;

-- Step 2: Create a backup table before cleanup
CREATE TABLE IF NOT EXISTS followers_backup_before_cleanup AS
SELECT * FROM followers;

DO $$
BEGIN
    RAISE NOTICE 'Created backup table: followers_backup_before_cleanup';
END $$;

-- Step 3: Delete duplicate rows, keeping the best one for each pair
-- Keep: active over deleted, then oldest created_at
WITH rows_to_keep AS (
    SELECT id
    FROM (
        SELECT
            id,
            ROW_NUMBER() OVER (
                PARTITION BY follower_id, followed_id
                ORDER BY
                    CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,  -- Prefer active
                    created_at ASC  -- Then prefer oldest
            ) as rn
        FROM followers
    ) ranked
    WHERE rn = 1
)
DELETE FROM followers
WHERE id NOT IN (SELECT id FROM rows_to_keep);

-- Step 4: Report cleanup results
DO $$
DECLARE
    rows_deleted INTEGER;
    rows_remaining INTEGER;
    unique_pairs_after INTEGER;
BEGIN
    GET DIAGNOSTICS rows_deleted = ROW_COUNT;

    SELECT COUNT(*) INTO rows_remaining FROM followers;

    SELECT COUNT(*) INTO unique_pairs_after
    FROM (
        SELECT DISTINCT follower_id, followed_id
        FROM followers
    ) unique_follows;

    RAISE NOTICE '';
    RAISE NOTICE '=== Cleanup Results ===';
    RAISE NOTICE 'Rows deleted: %', rows_deleted;
    RAISE NOTICE 'Rows remaining: %', rows_remaining;
    RAISE NOTICE 'Unique pairs after cleanup: %', unique_pairs_after;
END $$;

-- Step 5: Verify no duplicates remain
DO $$
DECLARE
    remaining_duplicates INTEGER;
BEGIN
    SELECT COUNT(*) INTO remaining_duplicates
    FROM (
        SELECT follower_id, followed_id, COUNT(*) as cnt
        FROM followers
        GROUP BY follower_id, followed_id
        HAVING COUNT(*) > 1
    ) dups;

    IF remaining_duplicates = 0 THEN
        RAISE NOTICE '';
        RAISE NOTICE '✅ SUCCESS: No duplicate follower pairs remain';
    ELSE
        RAISE WARNING '⚠️  WARNING: % duplicate pairs still exist', remaining_duplicates;
    END IF;
END $$;

-- Step 6: Add a unique constraint to prevent future duplicates
-- This will fail if duplicates still exist
ALTER TABLE followers
ADD CONSTRAINT unique_follower_pair UNIQUE (follower_id, followed_id);

DO $$
BEGIN
    RAISE NOTICE '✅ Added unique constraint to prevent future duplicates';
END $$;

COMMIT;

-- To restore from backup if needed:
/*
BEGIN;
DROP TABLE followers;
ALTER TABLE followers_backup_before_cleanup RENAME TO followers;
COMMIT;
*/

-- To view what was cleaned up:
/*
SELECT
    'Removed' as status,
    f_backup.*
FROM followers_backup_before_cleanup f_backup
WHERE NOT EXISTS (
    SELECT 1 FROM followers f
    WHERE f.id = f_backup.id
)
LIMIT 20;
*/