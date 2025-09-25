-- Migration: Add responded_at column to list_invitations table
-- Description: Fixes missing responded_at column needed by cascade_connection_removal function
-- Date: 2025-09-24

BEGIN;

-- Check if the column exists before adding it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'list_invitations'
        AND column_name = 'responded_at'
    ) THEN
        -- Add the missing responded_at column
        ALTER TABLE list_invitations ADD COLUMN responded_at TIMESTAMPTZ;

        RAISE NOTICE 'Added responded_at column to list_invitations table';
    ELSE
        RAISE NOTICE 'responded_at column already exists in list_invitations table';
    END IF;
END $$;

-- Update existing records to set responded_at based on accepted_at or declined_at
-- This ensures data consistency for existing records
UPDATE list_invitations
SET responded_at = COALESCE(accepted_at, declined_at)
WHERE responded_at IS NULL
AND (accepted_at IS NOT NULL OR declined_at IS NOT NULL);

-- Add comment for the column
COMMENT ON COLUMN list_invitations.responded_at IS 'Timestamp when the invitation was responded to (accepted, declined, or cancelled)';

COMMIT;

-- Migration verification
DO $$
BEGIN
    RAISE NOTICE 'Migration 088_add_responded_at_to_list_invitations completed successfully';
    RAISE NOTICE 'Added responded_at column to list_invitations table if it was missing';
    RAISE NOTICE 'Updated existing records to maintain data consistency';
    RAISE NOTICE 'cascade_connection_removal function should now work correctly';
END $$;