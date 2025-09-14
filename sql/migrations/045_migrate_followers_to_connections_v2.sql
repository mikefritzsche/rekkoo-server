-- Migration: 045_migrate_followers_to_connections_v2.sql
-- Purpose: Migrate existing followers data to unified connections table
-- Version 2: Handles duplicate rows in followers table
-- Date: 2025-09-14

BEGIN;

-- Step 0: Clean up any leftover temp tables from failed previous runs
DROP TABLE IF EXISTS followers_deduplicated;

-- Step 1: Create a deduplicated temporary table
-- This handles the case where followers table has duplicate (follower_id, followed_id) pairs
CREATE TEMP TABLE followers_deduplicated AS
WITH ranked_followers AS (
    SELECT
        follower_id,
        followed_id,
        created_at,
        updated_at,
        deleted_at,
        ROW_NUMBER() OVER (
            PARTITION BY follower_id, followed_id
            ORDER BY
                CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,  -- Prefer active rows
                created_at ASC  -- Then prefer older rows
        ) as rn
    FROM followers
    WHERE follower_id IS NOT NULL
      AND followed_id IS NOT NULL
)
SELECT
    follower_id,
    followed_id,
    created_at,
    updated_at
FROM ranked_followers
WHERE rn = 1  -- Keep only one row per (follower_id, followed_id) pair
  AND deleted_at IS NULL;  -- Only migrate active relationships

-- Step 2: Report on deduplication
DO $$
DECLARE
    original_count INTEGER;
    deduplicated_count INTEGER;
    duplicates_removed INTEGER;
BEGIN
    -- Count original non-deleted followers
    SELECT COUNT(*) INTO original_count
    FROM followers
    WHERE deleted_at IS NULL
      AND follower_id IS NOT NULL
      AND followed_id IS NOT NULL;

    -- Count deduplicated rows
    SELECT COUNT(*) INTO deduplicated_count
    FROM followers_deduplicated;

    duplicates_removed := original_count - deduplicated_count;

    RAISE NOTICE '=== Deduplication Report ===';
    RAISE NOTICE 'Original follower rows (active): %', original_count;
    RAISE NOTICE 'After deduplication: %', deduplicated_count;
    RAISE NOTICE 'Duplicate rows removed: %', duplicates_removed;
END $$;

-- Step 3: Check for orphaned records and remove them
DELETE FROM followers_deduplicated f
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = f.follower_id)
   OR NOT EXISTS (SELECT 1 FROM users WHERE id = f.followed_id);

DO $$
DECLARE
    orphans_removed INTEGER;
BEGIN
    GET DIAGNOSTICS orphans_removed = ROW_COUNT;
    IF orphans_removed > 0 THEN
        RAISE NOTICE 'Removed % orphaned follower records (users no longer exist)', orphans_removed;
    END IF;
END $$;

-- Step 4: Count what we're about to migrate
DO $$
DECLARE
    to_migrate INTEGER;
    will_update INTEGER;
    will_insert INTEGER;
BEGIN
    SELECT COUNT(*) INTO to_migrate FROM followers_deduplicated;

    SELECT COUNT(*) INTO will_update
    FROM followers_deduplicated f
    WHERE EXISTS (
        SELECT 1 FROM connections c
        WHERE c.user_id = f.follower_id
          AND c.connection_id = f.followed_id
    );

    will_insert := to_migrate - will_update;

    RAISE NOTICE '';
    RAISE NOTICE '=== Migration Plan ===';
    RAISE NOTICE 'Total relationships to migrate: %', to_migrate;
    RAISE NOTICE 'Existing connections to update: %', will_update;
    RAISE NOTICE 'New connections to create: %', will_insert;
END $$;

-- Step 5: Perform the migration using UPSERT
-- Using INSERT ... ON CONFLICT to handle existing connections
INSERT INTO connections (
    user_id,
    connection_id,
    status,
    connection_type,
    initiated_by,
    auto_accepted,
    visibility_level,
    created_at,
    accepted_at
)
SELECT
    f.follower_id as user_id,
    f.followed_id as connection_id,
    'following' as status,
    'following' as connection_type,
    f.follower_id as initiated_by,
    true as auto_accepted,
    'public' as visibility_level,
    f.created_at,
    f.created_at as accepted_at
FROM followers_deduplicated f
ON CONFLICT (user_id, connection_id) DO UPDATE
SET
    -- Only update if it's not already a mutual accepted connection
    connection_type = CASE
        WHEN connections.connection_type = 'mutual' AND connections.status = 'accepted'
        THEN connections.connection_type  -- Preserve mutual connections
        ELSE 'following'
    END,
    status = CASE
        WHEN connections.connection_type = 'mutual' AND connections.status = 'accepted'
        THEN connections.status  -- Preserve accepted status
        ELSE 'following'
    END,
    auto_accepted = CASE
        WHEN connections.connection_type = 'mutual' AND connections.status = 'accepted'
        THEN connections.auto_accepted
        ELSE true
    END,
    accepted_at = COALESCE(connections.accepted_at, EXCLUDED.accepted_at),
    updated_at = CURRENT_TIMESTAMP
WHERE
    -- Only update if not a mutual accepted connection
    NOT (connections.connection_type = 'mutual' AND connections.status = 'accepted');

-- Step 6: Report migration results
DO $$
DECLARE
    total_following INTEGER;
    total_mutual INTEGER;
    total_connections INTEGER;
    rows_affected INTEGER;
BEGIN
    GET DIAGNOSTICS rows_affected = ROW_COUNT;

    SELECT COUNT(*) INTO total_following
    FROM connections
    WHERE connection_type = 'following';

    SELECT COUNT(*) INTO total_mutual
    FROM connections
    WHERE connection_type = 'mutual';

    total_connections := total_following + total_mutual;

    RAISE NOTICE '';
    RAISE NOTICE '=== Migration Results ===';
    RAISE NOTICE 'Rows affected by migration: %', rows_affected;
    RAISE NOTICE 'Total following connections: %', total_following;
    RAISE NOTICE 'Total mutual connections: %', total_mutual;
    RAISE NOTICE 'Total connections in table: %', total_connections;
END $$;

-- Step 7: Identify reciprocal following relationships
DO $$
DECLARE
    reciprocal_count INTEGER;
BEGIN
    SELECT COUNT(*) / 2 INTO reciprocal_count
    FROM connections c1
    JOIN connections c2 ON c1.user_id = c2.connection_id
                       AND c1.connection_id = c2.user_id
    WHERE c1.connection_type = 'following'
      AND c2.connection_type = 'following'
      AND c1.user_id < c1.connection_id;

    IF reciprocal_count > 0 THEN
        RAISE NOTICE '';
        RAISE NOTICE '💡 Found % reciprocal following relationships', reciprocal_count;
        RAISE NOTICE '   These users follow each other and could be upgraded to mutual connections';
        RAISE NOTICE '   Run the upgrade_reciprocal_follows.sql script if you want to convert them';
    END IF;
END $$;

-- Step 8: Create verification view
CREATE OR REPLACE VIEW migration_verification AS
SELECT
    'followers_original' as source,
    COUNT(*) as total_count,
    COUNT(DISTINCT follower_id) as unique_followers,
    COUNT(DISTINCT followed_id) as unique_followed,
    COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) as active_count
FROM followers
UNION ALL
SELECT
    'connections_following' as source,
    COUNT(*) as total_count,
    COUNT(DISTINCT user_id) as unique_followers,
    COUNT(DISTINCT connection_id) as unique_followed,
    COUNT(*) as active_count
FROM connections
WHERE connection_type = 'following'
UNION ALL
SELECT
    'connections_mutual' as source,
    COUNT(*) as total_count,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT connection_id) as unique_connections,
    COUNT(*) as active_count
FROM connections
WHERE connection_type = 'mutual';

-- Step 9: Final verification
DO $$
DECLARE
    source_count INTEGER;
    migrated_count INTEGER;
    difference INTEGER;
BEGIN
    SELECT COUNT(*) INTO source_count FROM followers_deduplicated;

    SELECT COUNT(*) INTO migrated_count
    FROM connections c
    WHERE EXISTS (
        SELECT 1 FROM followers_deduplicated f
        WHERE f.follower_id = c.user_id
          AND f.followed_id = c.connection_id
    );

    difference := source_count - migrated_count;

    RAISE NOTICE '';
    RAISE NOTICE '=== Final Verification ===';
    IF difference = 0 THEN
        RAISE NOTICE '✅ SUCCESS: All deduplicated followers have been migrated';
    ELSIF difference > 0 THEN
        RAISE WARNING '⚠️  WARNING: % records were not migrated', difference;
        RAISE NOTICE 'Run this query to investigate:';
        RAISE NOTICE 'SELECT * FROM followers_deduplicated f WHERE NOT EXISTS (';
        RAISE NOTICE '  SELECT 1 FROM connections c WHERE c.user_id = f.follower_id';
        RAISE NOTICE '  AND c.connection_id = f.followed_id);';
    ELSE
        RAISE NOTICE '✅ Migration complete';
    END IF;
END $$;

-- Step 10: Mark followers table as deprecated
DO $$
DECLARE
    comment_text TEXT;
BEGIN
    comment_text := 'DEPRECATED: Migrated to connections table with connection_type=following on ' || NOW()::text || '.
 Original table had duplicates which were deduplicated during migration.
 Retain for rollback purposes only.';

    EXECUTE 'COMMENT ON TABLE followers IS ' || quote_literal(comment_text);
END $$;

-- Step 11: Create index for performance
CREATE INDEX IF NOT EXISTS idx_connections_following
ON connections(user_id, connection_id)
WHERE connection_type = 'following';

COMMIT;

-- ============================================
-- Post-migration queries you can run:
-- ============================================

-- View the verification summary:
-- SELECT * FROM migration_verification;

-- Check for reciprocal follows that could be mutual:
/*
SELECT
    c1.user_id,
    u1.username as user1,
    c1.connection_id,
    u2.username as user2,
    'Both follow each other' as relationship
FROM connections c1
JOIN connections c2 ON c1.user_id = c2.connection_id AND c1.connection_id = c2.user_id
JOIN users u1 ON u1.id = c1.user_id
JOIN users u2 ON u2.id = c1.connection_id
WHERE c1.connection_type = 'following'
  AND c2.connection_type = 'following'
  AND c1.user_id < c1.connection_id
LIMIT 10;
*/