-- Debug script for slow sync query performance
-- Run this in your database to diagnose the issue

-- 1. Check if our indexes were created successfully
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename = 'change_log'
ORDER BY indexname;

-- 2. Check table statistics
SELECT
    schemaname,
    tablename,
    n_live_tup as live_rows,
    n_dead_tup as dead_rows,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE tablename = 'change_log';

-- 3. Check the actual query plan (replace the UUID with a real user_id)
-- IMPORTANT: Replace '1bcd0366-498a-4d6e-82a6-e880e47c808f' with your test user ID
EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT
    cl.table_name,
    cl.record_id,
    cl.operation,
    cl.created_at,
    cl.change_data
FROM public.change_log cl
WHERE cl.user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND cl.created_at > to_timestamp(0 / 1000.0)  -- Using 0 for initial sync
ORDER BY cl.created_at ASC
LIMIT 1000;

-- 4. Check how many rows this user has in change_log
SELECT
    COUNT(*) as total_rows,
    MIN(created_at) as oldest_change,
    MAX(created_at) as newest_change
FROM change_log
WHERE user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid;

-- 5. Check if the timestamp conversion is the issue
-- Compare these two query plans:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM change_log
WHERE user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND created_at > to_timestamp(0 / 1000.0)
ORDER BY created_at ASC
LIMIT 1000;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM change_log
WHERE user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND created_at > '1970-01-01'::timestamp
ORDER BY created_at ASC
LIMIT 1000;

-- 6. Force index usage and see if it helps
SET enable_seqscan = OFF;
EXPLAIN (ANALYZE, BUFFERS)
SELECT
    cl.table_name,
    cl.record_id,
    cl.operation,
    cl.created_at,
    cl.change_data
FROM public.change_log cl
WHERE cl.user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND cl.created_at > to_timestamp(0 / 1000.0)
ORDER BY cl.created_at ASC
LIMIT 1000;
SET enable_seqscan = ON;

-- 7. Vacuum and analyze the table to ensure statistics are fresh
VACUUM ANALYZE change_log;

-- 8. Check if we need a different index strategy
-- Count rows per user to see data distribution
SELECT
    user_id,
    COUNT(*) as row_count
FROM change_log
GROUP BY user_id
ORDER BY row_count DESC
LIMIT 10;