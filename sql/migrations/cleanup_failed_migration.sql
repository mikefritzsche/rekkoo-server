-- Cleanup Script: Remove artifacts from failed migration attempts
-- Run this if you encounter errors about existing tables/views from previous failed migrations
COMMIT;
BEGIN;

-- Check if followers_deduplicated exists as a regular table (not temp)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'followers_deduplicated'
    ) THEN
        DROP TABLE public.followers_deduplicated;
        RAISE NOTICE 'Dropped table: public.followers_deduplicated';
    END IF;
END $$;

-- Check if it exists in pg_temp schema (temp tables)
DO $$
BEGIN
    -- Drop any temp table with this name from current session
    DROP TABLE IF EXISTS pg_temp.followers_deduplicated;
    RAISE NOTICE 'Dropped any temp table: followers_deduplicated';
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'No temp table followers_deduplicated found';
END $$;

-- Clean up the migration verification view if it exists
DROP VIEW IF EXISTS migration_verification CASCADE;

-- Check current state of migrations
SELECT 'Current Migration State' as status;
SELECT
    'Followers table rows' as metric,
    COUNT(*) as count
FROM followers
WHERE deleted_at IS NULL
UNION ALL
SELECT
    'Connections following type' as metric,
    COUNT(*) as count
FROM connections
WHERE connection_type = 'following'
UNION ALL
SELECT
    'Connections mutual type' as metric,
    COUNT(*) as count
FROM connections
WHERE connection_type = 'mutual';

COMMIT;

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '✅ Cleanup complete. You can now run the migration again.';
END $$;