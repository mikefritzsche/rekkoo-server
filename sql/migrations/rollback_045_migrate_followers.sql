-- Rollback Script for Migration 045
-- Purpose: Rollback the followers to connections migration if needed
-- Date: 2025-09-14

BEGIN;

-- Step 1: Remove all following connections that were migrated
-- (This assumes we want to preserve any NEW following connections made after migration)
DELETE FROM connections
WHERE connection_type = 'following'
  AND (user_id, connection_id) IN (
    SELECT follower_id, followed_id
    FROM followers
    WHERE deleted_at IS NULL
  );

-- Step 2: Remove migration tracking record
DELETE FROM migrations WHERE name = '045_migrate_followers_to_connections';

-- Step 3: Drop the verification view
DROP VIEW IF EXISTS migration_verification;

-- Step 4: Remove the deprecation comment from followers table
COMMENT ON TABLE followers IS NULL;

-- Step 5: Drop the index if it was created by this migration
DROP INDEX IF EXISTS idx_connections_following;

-- Log rollback completion
DO $$
BEGIN
    RAISE NOTICE 'Rollback completed successfully';
    RAISE NOTICE 'Followers table has been restored as the primary source';
    RAISE NOTICE 'Following connections have been removed from connections table';
END $$;

COMMIT;