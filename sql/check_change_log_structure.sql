-- Check the actual structure of change_log table
-- Run this first to understand the column names

-- 1. Show all columns in change_log table
SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'change_log'
    AND table_schema = 'public'
ORDER BY ordinal_position;

-- 2. Show first 5 rows to see actual data
SELECT * FROM change_log LIMIT 5;

-- 3. Check all indexes on the table
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'change_log';

-- 4. Get column names that might be timestamp-related
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'change_log'
    AND table_schema = 'public'
    AND data_type IN ('timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz');