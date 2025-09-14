-- Diagnostic: Check for duplicate follower relationships
-- The error "ON CONFLICT DO UPDATE command cannot affect row a second time"
-- indicates there are duplicate rows in the followers table
COMMIT;  -- End any open transaction
-- 1. Check if there are duplicate (follower_id, followed_id) pairs
SELECT 'Duplicate Follower Relationships' as check_type;
SELECT
    follower_id,
    followed_id,
    COUNT(*) as duplicate_count,
    STRING_AGG(DISTINCT COALESCE(deleted_at::text, 'active'), ', ') as status_types,
    MIN(created_at) as earliest_created,
    MAX(created_at) as latest_created
FROM followers
GROUP BY follower_id, followed_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, follower_id, followed_id
LIMIT 20;

-- 2. Count total duplicates
SELECT 'Duplicate Summary' as check_type;
SELECT
    COUNT(*) as total_duplicate_pairs,
    SUM(duplicate_count - 1) as extra_rows_to_remove
FROM (
    SELECT follower_id, followed_id, COUNT(*) as duplicate_count
    FROM followers
    GROUP BY follower_id, followed_id
    HAVING COUNT(*) > 1
) dups;

-- 3. Check duplicates excluding deleted rows
SELECT 'Active Duplicates Only' as check_type;
SELECT
    follower_id,
    followed_id,
    COUNT(*) as duplicate_count,
    MIN(created_at) as earliest_created,
    MAX(created_at) as latest_created
FROM followers
WHERE deleted_at IS NULL
GROUP BY follower_id, followed_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC
LIMIT 20;

-- 4. Show detailed view of duplicates with user info
SELECT 'Duplicate Details with Users' as check_type;
SELECT
    f.id,
    f.follower_id,
    u1.username as follower_username,
    f.followed_id,
    u2.username as followed_username,
    f.created_at,
    f.deleted_at,
    CASE WHEN f.deleted_at IS NULL THEN 'active' ELSE 'deleted' END as status
FROM followers f
LEFT JOIN users u1 ON u1.id = f.follower_id
LEFT JOIN users u2 ON u2.id = f.followed_id
WHERE (f.follower_id, f.followed_id) IN (
    SELECT follower_id, followed_id
    FROM followers
    WHERE deleted_at IS NULL
    GROUP BY follower_id, followed_id
    HAVING COUNT(*) > 1
)
ORDER BY f.follower_id, f.followed_id, f.created_at
LIMIT 30;

-- 5. Check if followers table has a unique constraint or primary key
SELECT 'Followers Table Constraints' as check_type;
SELECT
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
    AND tc.table_name = 'followers'
ORDER BY tc.constraint_type, tc.constraint_name;

-- 6. Identify which duplicate to keep (keep the oldest active one)
SELECT 'Rows to Keep vs Delete' as check_type;
WITH ranked_followers AS (
    SELECT
        id,
        follower_id,
        followed_id,
        created_at,
        deleted_at,
        ROW_NUMBER() OVER (
            PARTITION BY follower_id, followed_id
            ORDER BY
                CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,  -- Prefer active rows
                created_at ASC  -- Then prefer older rows
        ) as rn
    FROM followers
)
SELECT
    CASE WHEN rn = 1 THEN 'KEEP' ELSE 'DELETE' END as action,
    COUNT(*) as row_count
FROM ranked_followers
GROUP BY CASE WHEN rn = 1 THEN 'KEEP' ELSE 'DELETE' END;

-- 7. Sample of exact duplicate IDs that would be removed
SELECT 'Sample IDs to Remove' as check_type;
WITH ranked_followers AS (
    SELECT
        id,
        follower_id,
        followed_id,
        created_at,
        deleted_at,
        ROW_NUMBER() OVER (
            PARTITION BY follower_id, followed_id
            ORDER BY
                CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END,
                created_at ASC
        ) as rn
    FROM followers
)
SELECT
    id as duplicate_id_to_remove,
    follower_id,
    followed_id,
    created_at,
    deleted_at
FROM ranked_followers
WHERE rn > 1
LIMIT 20;