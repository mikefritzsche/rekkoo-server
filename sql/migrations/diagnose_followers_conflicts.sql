-- Diagnostic Script: Check for conflicts before migrating followers to connections
-- Run this before migration 045 to identify potential issues

-- 1. Check if followers table exists and has data
SELECT 'Followers Table Summary' as check_type,
       COUNT(*) as total_rows,
       COUNT(DISTINCT follower_id) as unique_followers,
       COUNT(DISTINCT followed_id) as unique_followed,
       COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) as deleted_rows,
       COUNT(CASE WHEN follower_id IS NULL OR followed_id IS NULL THEN 1 END) as null_user_rows
FROM followers;

-- 2. Check for existing connections that would conflict
SELECT 'Potential Conflicts' as check_type,
       COUNT(*) as conflict_count
FROM followers f
WHERE f.deleted_at IS NULL
  AND f.follower_id IS NOT NULL
  AND f.followed_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM connections c
    WHERE c.user_id = f.follower_id
      AND c.connection_id = f.followed_id
  );

-- 3. Show sample of conflicting records (first 10)
SELECT 'Conflicting Records Sample' as check_type;
SELECT
    f.follower_id,
    u1.username as follower_username,
    f.followed_id,
    u2.username as followed_username,
    f.created_at as follower_created,
    c.created_at as connection_created,
    c.status as connection_status,
    c.connection_type as connection_type
FROM followers f
JOIN connections c ON c.user_id = f.follower_id AND c.connection_id = f.followed_id
LEFT JOIN users u1 ON u1.id = f.follower_id
LEFT JOIN users u2 ON u2.id = f.followed_id
WHERE f.deleted_at IS NULL
  AND f.follower_id IS NOT NULL
  AND f.followed_id IS NOT NULL
ORDER BY f.created_at DESC
LIMIT 10;

-- 4. Check for followers that can be safely migrated
SELECT 'Safe to Migrate' as check_type,
       COUNT(*) as safe_count
FROM followers f
WHERE f.deleted_at IS NULL
  AND f.follower_id IS NOT NULL
  AND f.followed_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM connections c
    WHERE c.user_id = f.follower_id
      AND c.connection_id = f.followed_id
  );

-- 5. Check for reciprocal following relationships (A follows B and B follows A)
SELECT 'Reciprocal Follows' as check_type,
       COUNT(*) / 2 as reciprocal_pairs  -- Divide by 2 because each pair is counted twice
FROM followers f1
JOIN followers f2 ON f1.follower_id = f2.followed_id
                 AND f1.followed_id = f2.follower_id
WHERE f1.deleted_at IS NULL
  AND f2.deleted_at IS NULL
  AND f1.follower_id < f1.followed_id;  -- Avoid counting each pair twice

-- 6. Check for self-following records (should not exist but let's verify)
SELECT 'Self-Following Records' as check_type,
       COUNT(*) as self_follow_count
FROM followers
WHERE follower_id = followed_id
  AND deleted_at IS NULL;

-- 7. Summary of connections table current state
SELECT 'Connections Table Summary' as check_type,
       COUNT(*) as total_connections,
       COUNT(CASE WHEN connection_type = 'mutual' THEN 1 END) as mutual_count,
       COUNT(CASE WHEN connection_type = 'following' THEN 1 END) as following_count,
       COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
       COUNT(CASE WHEN status = 'accepted' THEN 1 END) as accepted_count,
       COUNT(CASE WHEN status = 'following' THEN 1 END) as following_status_count
FROM connections;

-- 8. Check for orphaned follower records (users that don't exist)
SELECT 'Orphaned Follower Records' as check_type,
       COUNT(*) as orphaned_count
FROM followers f
WHERE f.deleted_at IS NULL
  AND (
    NOT EXISTS (SELECT 1 FROM users WHERE id = f.follower_id)
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = f.followed_id)
  );