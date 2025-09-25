-- Migration: Clean up inconsistent connection records
-- This migration identifies and fixes connection records that might cause duplicate constraint errors

-- First, let's check for any connection records that might be inconsistent
DO $$
DECLARE
    v_inconsistent_records INTEGER;
    v_duplicate_records INTEGER;
BEGIN
    -- Count records where both directions exist but have different statuses
    SELECT COUNT(*) INTO v_inconsistent_records
    FROM connections c1
    JOIN connections c2 ON c1.user_id = c2.connection_id AND c1.connection_id = c2.user_id
    WHERE c1.status != c2.status;

    RAISE NOTICE 'Found % inconsistent bidirectional connection records', v_inconsistent_records;

    -- Count exact duplicates (same user_id and connection_id)
    SELECT COUNT(*) - COUNT(DISTINCT (user_id, connection_id)) INTO v_duplicate_records
    FROM connections;

    RAISE NOTICE 'Found % duplicate connection records', v_duplicate_records;
END $$;

-- Create a function to clean up duplicate connection records
CREATE OR REPLACE FUNCTION cleanup_duplicate_connections()
RETURNS TABLE(
    cleaned_count INTEGER,
    error_message TEXT
) AS $$
DECLARE
    v_cleaned_count INTEGER := 0;
BEGIN
    -- Delete duplicate records keeping the most recent one
    WITH duplicates AS (
        SELECT
            ctid,
            user_id,
            connection_id,
            ROW_NUMBER() OVER (PARTITION BY user_id, connection_id ORDER BY updated_at DESC, created_at DESC) as rn
        FROM connections
        WHERE (user_id, connection_id) IN (
            SELECT user_id, connection_id
            FROM connections
            GROUP BY user_id, connection_id
            HAVING COUNT(*) > 1
        )
    )
    DELETE FROM connections
    WHERE ctid IN (SELECT ctid FROM duplicates WHERE rn > 1);

    GET DIAGNOSTICS v_cleaned_count = ROW_COUNT;

    RETURN QUERY SELECT v_cleaned_count, NULL::TEXT;
EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 0, SQLERRM;
END;
$$ LANGUAGE plpgsql;

-- Execute the cleanup function
SELECT * FROM cleanup_duplicate_connections();

-- Add comment
COMMENT ON FUNCTION cleanup_duplicate_connections() IS
' cleans up duplicate connection records that might cause constraint violations';

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Connection cleanup migration completed';
    RAISE NOTICE 'Use SELECT cleanup_duplicate_connections() to manually clean up duplicates in the future';
END $$;