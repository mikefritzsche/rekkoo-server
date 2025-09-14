-- Verification Script for Migration 045
-- Purpose: Verify the followers to connections migration
-- Date: 2025-09-14
-- Run this before and after migration to compare results

-- 1. Check current state of followers table
SELECT 'Followers Table Status' as check_type;
SELECT
    COUNT(*) as total_records,
    COUNT(DISTINCT follower_id) as unique_followers,
    COUNT(DISTINCT followed_id) as unique_followed,
    COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) as deleted_records,
    MIN(created_at) as earliest_follow,
    MAX(created_at) as latest_follow
FROM followers;

-- 2. Check for any existing following connections
SELECT 'Existing Following Connections' as check_type;
SELECT
    COUNT(*) as total_following,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT connection_id) as unique_connections,
    MIN(created_at) as earliest_connection,
    MAX(created_at) as latest_connection
FROM connections
WHERE connection_type = 'following';

-- 3. Check for potential duplicates/conflicts
SELECT 'Potential Conflicts' as check_type;
SELECT
    f.follower_id,
    f.followed_id,
    f.created_at as follower_created_at,
    c.created_at as connection_created_at,
    c.status as connection_status,
    c.connection_type
FROM followers f
LEFT JOIN connections c ON
    c.user_id = f.follower_id
    AND c.connection_id = f.followed_id
WHERE f.deleted_at IS NULL
  AND c.id IS NOT NULL
LIMIT 10;

-- 4. Sample of followers to be migrated
SELECT 'Sample Followers to Migrate' as check_type;
SELECT
    f.follower_id,
    u1.username as follower_username,
    f.followed_id,
    u2.username as followed_username,
    f.created_at
FROM followers f
LEFT JOIN users u1 ON u1.id = f.follower_id
LEFT JOIN users u2 ON u2.id = f.followed_id
WHERE f.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM connections c
    WHERE c.user_id = f.follower_id
      AND c.connection_id = f.followed_id
      AND c.connection_type = 'following'
  )
LIMIT 10;

-- 5. Check migration history
SELECT 'Migration History' as check_type;
SELECT
    name,
    executed_at,
    success,
    notes
FROM migrations
WHERE name LIKE '%followers%' OR name LIKE '%connections%'
ORDER BY executed_at DESC
LIMIT 10;

-- 6. Data integrity check
SELECT 'Data Integrity Check' as check_type;
SELECT
    'Orphaned follower records (no user)' as issue,
    COUNT(*) as count
FROM followers f
WHERE f.deleted_at IS NULL
  AND (
    NOT EXISTS (SELECT 1 FROM users WHERE id = f.follower_id)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = f.followed_id)
  )
UNION ALL
SELECT
    'Self-following records' as issue,
    COUNT(*) as count
FROM followers
WHERE deleted_at IS NULL
  AND follower_id = followed_id
UNION ALL
SELECT
    'Duplicate follower records' as issue,
    COUNT(*) as count
FROM (
    SELECT follower_id, followed_id, COUNT(*) as cnt
    FROM followers
    WHERE deleted_at IS NULL
    GROUP BY follower_id, followed_id
    HAVING COUNT(*) > 1
) duplicates;

-- 7. After migration - verify the migration view
-- This will only work after migration is complete
-- SELECT * FROM migration_verification;