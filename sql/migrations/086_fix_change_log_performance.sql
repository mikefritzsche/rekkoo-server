-- Migration: Fix change_log performance issues
-- This addresses the slow query even after adding indexes

-- Drop the previous composite index if it exists
DROP INDEX IF EXISTS idx_change_log_user_created_composite;

-- Create a more efficient index with user_id and created_at as leading columns
-- This should work better for our WHERE user_id = X AND created_at > Y pattern
CREATE INDEX IF NOT EXISTS idx_change_log_user_created_optimized
ON change_log (user_id, created_at DESC)
INCLUDE (table_name, operation, record_id);

-- Alternative: Create a partial index for recent changes (last 30 days)
-- This is useful if most queries are for recent data
CREATE INDEX IF NOT EXISTS idx_change_log_user_recent
ON change_log (user_id, created_at DESC)
WHERE created_at > CURRENT_DATE - INTERVAL '30 days';

-- Create an index specifically for initial sync (all records for a user)
CREATE INDEX IF NOT EXISTS idx_change_log_user_all
ON change_log (user_id, created_at ASC);

-- Update table statistics for better query planning
VACUUM ANALYZE change_log;

-- Add table comment documenting the optimization
COMMENT ON TABLE change_log IS 'Unified change tracking for sync operations. Optimized indexes for user-based time-range queries.';

-- Check current table size and provide feedback
DO $$
DECLARE
    row_count BIGINT;
    table_size TEXT;
BEGIN
    SELECT COUNT(*) INTO row_count FROM change_log;
    SELECT pg_size_pretty(pg_total_relation_size('change_log')) INTO table_size;

    RAISE NOTICE 'change_log table has % rows, total size: %', row_count, table_size;

    IF row_count > 1000000 THEN
        RAISE NOTICE 'Table has over 1M rows. Consider partitioning by created_at or archiving old data.';
    END IF;
END $$;