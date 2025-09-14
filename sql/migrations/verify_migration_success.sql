-- Verification Script: Confirm Migration Success
-- Run this after completing all migration steps to verify everything is working

-- 1. Overall Migration Summary
SELECT '=== MIGRATION SUCCESS VERIFICATION ===' as report;

-- 2. Check migration results
SELECT * FROM migration_verification;

-- 3. Detailed connection statistics
SELECT
    'Connection Statistics' as report_type,
    connection_type,
    status,
    COUNT(*) as count,
    COUNT(DISTINCT user_id) as unique_users,
    COUNT(DISTINCT connection_id) as unique_connections
FROM connections
GROUP BY connection_type, status
ORDER BY connection_type, status;

-- 4. Sample of migrated following connections
SELECT 'Sample Following Connections (First 5)' as report_type;
SELECT
    c.user_id,
    u1.username as follower,
    c.connection_id,
    u2.username as following,
    c.created_at,
    c.auto_accepted,
    c.visibility_level
FROM connections c
JOIN users u1 ON u1.id = c.user_id
JOIN users u2 ON u2.id = c.connection_id
WHERE c.connection_type = 'following'
ORDER BY c.created_at DESC
LIMIT 5;

-- 5. Sample of mutual connections
SELECT 'Sample Mutual Connections (First 5)' as report_type;
SELECT
    c.user_id,
    u1.username as user1,
    c.connection_id,
    u2.username as user2,
    c.status,
    c.accepted_at
FROM connections c
JOIN users u1 ON u1.id = c.user_id
JOIN users u2 ON u2.id = c.connection_id
WHERE c.connection_type = 'mutual'
  AND c.status = 'accepted'
ORDER BY c.accepted_at DESC
LIMIT 5;

-- 6. Check for any reciprocal connections (users following each other)
SELECT 'Reciprocal Following Relationships' as report_type;
SELECT
    COUNT(*) / 2 as reciprocal_pairs,
    'These users follow each other and could be mutual connections' as note
FROM connections c1
JOIN connections c2 ON c1.user_id = c2.connection_id
                   AND c1.connection_id = c2.user_id
WHERE c1.connection_type = 'following'
  AND c2.connection_type = 'following'
  AND c1.user_id < c1.connection_id;

-- 7. Check pending connection invitations
SELECT 'Pending Connection Invitations' as report_type;
SELECT
    COUNT(*) as total_pending,
    COUNT(CASE WHEN expires_at <= NOW() + INTERVAL '5 days' THEN 1 END) as expiring_soon,
    COUNT(CASE WHEN expires_at <= NOW() + INTERVAL '1 day' THEN 1 END) as expiring_today
FROM connection_invitations
WHERE status = 'pending';

-- 8. Verify indexes are in place
SELECT 'Performance Indexes' as report_type;
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'connections'
  AND indexname LIKE '%following%'
ORDER BY indexname;

-- 9. Verify triggers are active
SELECT 'Active Triggers' as report_type;
SELECT
    trigger_name,
    event_manipulation,
    event_object_table
FROM information_schema.triggers
WHERE event_object_table = 'connections'
  AND trigger_schema = 'public'
ORDER BY trigger_name;

-- 10. Final status check
SELECT 'Final Status' as report_type;
WITH stats AS (
    SELECT
        (SELECT COUNT(*) FROM followers WHERE deleted_at IS NULL) as original_followers,
        (SELECT COUNT(*) FROM connections WHERE connection_type = 'following') as migrated_following,
        (SELECT COUNT(*) FROM connections WHERE connection_type = 'mutual') as mutual_connections,
        (SELECT COUNT(*) FROM connection_invitations WHERE status = 'pending') as pending_invitations
)
SELECT
    original_followers,
    migrated_following,
    mutual_connections,
    pending_invitations,
    CASE
        WHEN migrated_following >= original_followers THEN '✅ Migration Complete'
        WHEN migrated_following > 0 THEN '⚠️ Partial Migration'
        ELSE '❌ Migration Issue'
    END as migration_status
FROM stats;

-- 11. Check if followers table is marked as deprecated
SELECT 'Table Deprecation Status' as report_type;
SELECT
    obj_description('followers'::regclass) as followers_table_comment;