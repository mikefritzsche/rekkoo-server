-- Test the optimized query performance
-- Replace the user_id with your actual test user

-- 1. Test with the OLD method (using to_timestamp)
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

-- 2. Test with the NEW method (using direct timestamp comparison)
EXPLAIN (ANALYZE, BUFFERS)
SELECT
    cl.table_name,
    cl.record_id,
    cl.operation,
    cl.created_at,
    cl.change_data
FROM public.change_log cl
WHERE cl.user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND cl.created_at > '1970-01-01T00:00:00.000Z'::timestamptz
ORDER BY cl.created_at ASC
LIMIT 1000;

-- 3. Verify the index is being used
SELECT
    schemaname,
    relname as tablename,
    indexname,
    idx_scan as times_used,
    idx_tup_read as rows_read,
    idx_tup_fetch as rows_fetched
FROM pg_stat_user_indexes
WHERE relname = 'change_log'
ORDER BY idx_scan DESC;

-- 4. Check table statistics
ANALYZE change_log;

SELECT
    relname as tablename,
    n_live_tup as live_rows,
    n_dead_tup as dead_rows,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE relname = 'change_log';