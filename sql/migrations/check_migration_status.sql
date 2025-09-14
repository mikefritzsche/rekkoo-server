-- Quick Check: Migration Status
-- Run this to see if the followers to connections migration has been completed

-- Check current state
SELECT 'Migration Status Check' as report_type;

-- 1. Followers table status
SELECT
    'Followers Table' as table_name,
    COUNT(*) as total_rows,
    COUNT(CASE WHEN deleted_at IS NULL THEN 1 END) as active_rows,
    COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) as deleted_rows
FROM followers;

-- 2. Connections table status
SELECT
    'Connections by Type' as category,
    connection_type,
    status,
    COUNT(*) as count
FROM connections
GROUP BY connection_type, status
ORDER BY connection_type, status;

-- 3. Check if followers data exists in connections
SELECT
    'Migration Progress' as check_type,
    CASE
        WHEN NOT EXISTS (SELECT 1 FROM followers WHERE deleted_at IS NULL)
        THEN 'No active followers to migrate'
        WHEN EXISTS (
            SELECT 1 FROM connections WHERE connection_type = 'following'
        )
        THEN 'Migration appears complete (following connections exist)'
        ELSE 'Migration not yet run (no following connections found)'
    END as status;

-- 4. Check for duplicates in followers
SELECT
    'Duplicate Followers' as check_type,
    COUNT(*) as duplicate_pairs
FROM (
    SELECT follower_id, followed_id, COUNT(*) as cnt
    FROM followers
    WHERE deleted_at IS NULL
    GROUP BY follower_id, followed_id
    HAVING COUNT(*) > 1
) dups;

-- 5. Compare counts
WITH follower_stats AS (
    SELECT COUNT(DISTINCT CONCAT(follower_id, '-', followed_id)) as unique_follows
    FROM followers
    WHERE deleted_at IS NULL
      AND follower_id IS NOT NULL
      AND followed_id IS NOT NULL
),
connection_stats AS (
    SELECT COUNT(*) as following_connections
    FROM connections
    WHERE connection_type = 'following'
)
SELECT
    'Data Comparison' as comparison,
    f.unique_follows as followers_count,
    c.following_connections as following_connections_count,
    CASE
        WHEN f.unique_follows = 0 THEN 'No followers to migrate'
        WHEN c.following_connections >= f.unique_follows THEN '✅ All migrated'
        WHEN c.following_connections > 0 THEN '⚠️ Partially migrated'
        ELSE '❌ Not migrated'
    END as status
FROM follower_stats f, connection_stats c;

-- 6. Check for temp tables
SELECT
    'Temp Tables Check' as check_type,
    tablename
FROM pg_tables
WHERE schemaname LIKE 'pg_temp%'
  AND tablename IN ('followers_deduplicated', 'followers_backup');