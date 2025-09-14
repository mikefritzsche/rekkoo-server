-- Migration: 045_migrate_followers_to_connections_fixed.sql
-- Purpose: Migrate existing followers data to unified connections table (with conflict handling)
-- Date: 2025-09-14
-- FIXED VERSION: Handles unique_connection constraint properly

BEGIN;

-- Step 0: Clean up any leftover temp tables from failed previous runs
DROP TABLE IF EXISTS followers_backup;

-- Step 1: Create a temporary backup of followers data
CREATE TEMP TABLE followers_backup AS
SELECT * FROM followers
WHERE deleted_at IS NULL
  AND follower_id IS NOT NULL
  AND followed_id IS NOT NULL;

-- Step 2: Count initial statistics
DO $$
DECLARE
    total_followers INTEGER;
    existing_conflicts INTEGER;
    safe_to_migrate INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_followers FROM followers_backup;

    SELECT COUNT(*) INTO existing_conflicts
    FROM followers_backup f
    WHERE EXISTS (
        SELECT 1 FROM connections c
        WHERE c.user_id = f.follower_id
          AND c.connection_id = f.followed_id
    );

    safe_to_migrate := total_followers - existing_conflicts;

    RAISE NOTICE 'Migration Pre-Check:';
    RAISE NOTICE '  Total followers to process: %', total_followers;
    RAISE NOTICE '  Existing connections (will update): %', existing_conflicts;
    RAISE NOTICE '  New connections to create: %', safe_to_migrate;
END $$;

-- Step 3: Insert follower relationships into connections table with ON CONFLICT handling
-- This will either insert new records or update existing ones to 'following' type
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
    f.created_at as accepted_at  -- Following relationships are auto-accepted
FROM followers_backup f
-- Add an extra check to ensure users exist
WHERE EXISTS (SELECT 1 FROM users WHERE id = f.follower_id)
  AND EXISTS (SELECT 1 FROM users WHERE id = f.followed_id)
ON CONFLICT (user_id, connection_id) DO UPDATE
SET
    -- Only update if the existing connection is not already a following type
    -- This preserves mutual connections if they exist
    connection_type = CASE
        WHEN connections.connection_type = 'mutual' AND connections.status = 'accepted'
        THEN connections.connection_type  -- Keep mutual if already accepted mutual
        ELSE 'following'  -- Otherwise set to following
    END,
    status = CASE
        WHEN connections.connection_type = 'mutual' AND connections.status = 'accepted'
        THEN connections.status  -- Keep accepted status for mutual connections
        ELSE 'following'  -- Otherwise set to following status
    END,
    auto_accepted = CASE
        WHEN connections.connection_type = 'mutual' AND connections.status = 'accepted'
        THEN connections.auto_accepted  -- Keep original auto_accepted value
        ELSE true  -- Following relationships are auto-accepted
    END,
    -- Update the accepted_at only if it wasn't already accepted
    accepted_at = COALESCE(connections.accepted_at, EXCLUDED.accepted_at),
    updated_at = CURRENT_TIMESTAMP
WHERE
    -- Only update if the existing record is not a mutual accepted connection
    NOT (connections.connection_type = 'mutual' AND connections.status = 'accepted');

-- Step 4: Handle reciprocal following relationships
-- If A follows B and B follows A, consider upgrading them to mutual connections
DO $$
DECLARE
    reciprocal_count INTEGER;
    upgraded_count INTEGER := 0;
BEGIN
    -- Count reciprocal following relationships
    SELECT COUNT(*) / 2 INTO reciprocal_count
    FROM connections c1
    JOIN connections c2 ON c1.user_id = c2.connection_id
                       AND c1.connection_id = c2.user_id
    WHERE c1.connection_type = 'following'
      AND c2.connection_type = 'following'
      AND c1.user_id < c1.connection_id;  -- Avoid counting twice

    IF reciprocal_count > 0 THEN
        RAISE NOTICE 'Found % reciprocal following relationships', reciprocal_count;
        RAISE NOTICE 'These could be upgraded to mutual connections if desired';
        -- Uncomment below to automatically upgrade reciprocal follows to mutual connections
        /*
        UPDATE connections c1
        SET connection_type = 'mutual',
            status = 'accepted',
            updated_at = CURRENT_TIMESTAMP
        FROM connections c2
        WHERE c1.user_id = c2.connection_id
          AND c1.connection_id = c2.user_id
          AND c1.connection_type = 'following'
          AND c2.connection_type = 'following';

        GET DIAGNOSTICS upgraded_count = ROW_COUNT;
        RAISE NOTICE 'Upgraded % reciprocal follows to mutual connections', upgraded_count / 2;
        */
    END IF;
END $$;

-- Step 5: Log migration results
DO $$
DECLARE
    migrated_count INTEGER;
    existing_count INTEGER;
    total_followers INTEGER;
    following_connections INTEGER;
    mutual_connections INTEGER;
BEGIN
    -- Count how many records were in the backup
    SELECT COUNT(*) INTO total_followers FROM followers_backup;

    -- Count following connections in the connections table
    SELECT COUNT(*) INTO following_connections
    FROM connections
    WHERE connection_type = 'following';

    -- Count mutual connections
    SELECT COUNT(*) INTO mutual_connections
    FROM connections
    WHERE connection_type = 'mutual';

    RAISE NOTICE '';
    RAISE NOTICE '=== Migration Summary ===';
    RAISE NOTICE 'Total followers in original table: %', total_followers;
    RAISE NOTICE 'Following connections after migration: %', following_connections;
    RAISE NOTICE 'Mutual connections (preserved): %', mutual_connections;
    RAISE NOTICE 'Total connections: %', following_connections + mutual_connections;
END $$;

-- Step 6: Create a verification view to compare data
CREATE OR REPLACE VIEW migration_verification AS
SELECT
    'followers_original' as source,
    COUNT(*) as count,
    COUNT(DISTINCT follower_id) as unique_followers,
    COUNT(DISTINCT followed_id) as unique_followed
FROM followers
WHERE deleted_at IS NULL
UNION ALL
SELECT
    'connections_following' as source,
    COUNT(*) as count,
    COUNT(DISTINCT user_id) as unique_followers,
    COUNT(DISTINCT connection_id) as unique_followed
FROM connections
WHERE connection_type = 'following'
UNION ALL
SELECT
    'connections_mutual' as source,
    COUNT(*) as count,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT connection_id) as unique_connections
FROM connections
WHERE connection_type = 'mutual';

-- Step 7: Create indexes if they don't exist for better query performance
CREATE INDEX IF NOT EXISTS idx_connections_following
ON connections(user_id, connection_id)
WHERE connection_type = 'following';

-- Step 8: Add comment to followers table indicating it's deprecated
DO $$
DECLARE
    comment_text TEXT;
BEGIN
    comment_text := 'DEPRECATED: This table has been migrated to the connections table with connection_type=following.
 Migration completed on ' || NOW()::text || '.
 This table is retained for rollback purposes only and should be dropped after verification.';

    EXECUTE 'COMMENT ON TABLE followers IS ' || quote_literal(comment_text);
END $$;

-- Step 9: Verify no data was lost
DO $$
DECLARE
    original_count INTEGER;
    migrated_count INTEGER;
    difference INTEGER;
BEGIN
    -- Count non-deleted followers
    SELECT COUNT(*) INTO original_count
    FROM followers
    WHERE deleted_at IS NULL
      AND follower_id IS NOT NULL
      AND followed_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM users WHERE id = follower_id)
      AND EXISTS (SELECT 1 FROM users WHERE id = followed_id);

    -- Count connections that came from followers (either following type or were already there)
    SELECT COUNT(*) INTO migrated_count
    FROM connections c
    WHERE EXISTS (
        SELECT 1 FROM followers f
        WHERE f.follower_id = c.user_id
          AND f.followed_id = c.connection_id
          AND f.deleted_at IS NULL
    );

    difference := original_count - migrated_count;

    IF difference = 0 THEN
        RAISE NOTICE '✓ All followers successfully migrated or already existed';
    ELSIF difference > 0 THEN
        RAISE WARNING '⚠ % follower records were not migrated (likely orphaned)', difference;
    ELSE
        RAISE NOTICE '✓ Migration complete (some connections may have been pre-existing)';
    END IF;
END $$;

COMMIT;

-- To verify the migration:
-- SELECT * FROM migration_verification;

-- To see reciprocal relationships that could be upgraded:
/*
SELECT c1.user_id, u1.username, c1.connection_id, u2.username
FROM connections c1
JOIN connections c2 ON c1.user_id = c2.connection_id AND c1.connection_id = c2.user_id
JOIN users u1 ON u1.id = c1.user_id
JOIN users u2 ON u2.id = c1.connection_id
WHERE c1.connection_type = 'following'
  AND c2.connection_type = 'following'
  AND c1.user_id < c1.connection_id
LIMIT 10;
*/