-- Migration: 045_migrate_followers_to_connections.sql
-- Purpose: Migrate existing followers data to unified connections table
-- Date: 2025-09-14

BEGIN;

-- Step 1: Create a temporary backup of followers data
CREATE TEMP TABLE followers_backup AS
SELECT * FROM followers
WHERE deleted_at IS NULL;

-- Step 2: Insert follower relationships into connections table
-- Each follower relationship becomes a 'following' connection type
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
FROM followers f
WHERE f.deleted_at IS NULL
  AND f.follower_id IS NOT NULL
  AND f.followed_id IS NOT NULL
  -- Only insert if not already exists in connections
  AND NOT EXISTS (
    SELECT 1 FROM connections c
    WHERE c.user_id = f.follower_id
      AND c.connection_id = f.followed_id
      AND c.connection_type = 'following'
  );

-- Step 3: Log migration results
DO $$
DECLARE
    migrated_count INTEGER;
    existing_count INTEGER;
    total_followers INTEGER;
BEGIN
    -- Count how many records were migrated
    SELECT COUNT(*) INTO total_followers FROM followers_backup;

    SELECT COUNT(*) INTO migrated_count
    FROM connections
    WHERE connection_type = 'following'
      AND created_at >= NOW() - INTERVAL '1 minute';

    SELECT COUNT(*) INTO existing_count
    FROM connections
    WHERE connection_type = 'following';

    RAISE NOTICE 'Migration Summary:';
    RAISE NOTICE '  Total followers in original table: %', total_followers;
    RAISE NOTICE '  Records migrated in this run: %', migrated_count;
    RAISE NOTICE '  Total following connections after migration: %', existing_count;
END $$;

-- Step 4: Create a verification view to compare data
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
WHERE connection_type = 'following';

-- Step 5: Add migration tracking record
INSERT INTO migrations (name, executed_at, success, notes)
VALUES (
    '045_migrate_followers_to_connections',
    NOW(),
    true,
    'Migrated followers table data to unified connections table with connection_type=following'
)
ON CONFLICT (name) DO NOTHING;

-- Step 6: Create indexes if they don't exist for better query performance
CREATE INDEX IF NOT EXISTS idx_connections_following
ON connections(user_id, connection_id)
WHERE connection_type = 'following';

-- Step 7: Add comment to followers table indicating it's deprecated
DO $$
DECLARE
    comment_text TEXT;
BEGIN
    comment_text := 'DEPRECATED: This table has been migrated to the connections table with connection_type=following.
 Migration completed on ' || NOW()::text || '.
 This table is retained for rollback purposes only and should be dropped after verification.';

    EXECUTE 'COMMENT ON TABLE followers IS ' || quote_literal(comment_text);
END $$;

COMMIT;

-- Rollback script (save separately as rollback_045_migrate_followers.sql)
-- BEGIN;
-- DELETE FROM connections WHERE connection_type = 'following';
-- DELETE FROM migrations WHERE name = '045_migrate_followers_to_connections';
-- DROP VIEW IF EXISTS migration_verification;
-- COMMENT ON TABLE followers IS NULL;
-- COMMIT;