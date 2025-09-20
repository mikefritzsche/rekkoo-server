-- Diagnose the user_id column situation

-- 1. Check if user_id column exists and what percentage has values
SELECT
    EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'change_log'
        AND column_name = 'user_id'
    ) as user_id_exists,
    COUNT(*) as total_rows,
    COUNT(user_id) as rows_with_user_id,
    COUNT(*) - COUNT(user_id) as rows_without_user_id,
    ROUND((COUNT(user_id)::numeric / NULLIF(COUNT(*), 0)) * 100, 2) as percent_with_user_id
FROM change_log;

-- 2. Check indexes specifically on user_id
SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'change_log'
  AND indexdef LIKE '%user_id%';

-- 3. Sample some rows to see if user_id has values
SELECT
    id,
    table_name,
    record_id,
    user_id,
    CASE
        WHEN user_id IS NULL THEN 'NULL'
        ELSE 'HAS VALUE'
    END as user_id_status,
    changed_at
FROM change_log
LIMIT 10;

-- 4. Check distribution of user_id values
SELECT
    user_id,
    COUNT(*) as record_count
FROM change_log
WHERE user_id IS NOT NULL
GROUP BY user_id
ORDER BY record_count DESC
LIMIT 10;

-- 5. Check if there are any indexes at all
SELECT COUNT(*) as index_count
FROM pg_indexes
WHERE tablename = 'change_log';