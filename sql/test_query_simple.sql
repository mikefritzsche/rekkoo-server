-- Simple test of query performance
-- Replace the user_id with your actual test user

-- 1. Test with the OLD method (using to_timestamp)
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*)
FROM public.change_log cl
WHERE cl.user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND cl.created_at > to_timestamp(0 / 1000.0)
LIMIT 1000;

-- 2. Test with the NEW method (using direct timestamp comparison)
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*)
FROM public.change_log cl
WHERE cl.user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid
    AND cl.created_at > '1970-01-01T00:00:00.000Z'::timestamptz
LIMIT 1000;

-- 3. Show all indexes on change_log table
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'change_log';

-- 4. Count rows for this user
SELECT
    COUNT(*) as total_rows,
    MIN(created_at) as oldest_entry,
    MAX(created_at) as newest_entry
FROM change_log
WHERE user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f'::uuid;