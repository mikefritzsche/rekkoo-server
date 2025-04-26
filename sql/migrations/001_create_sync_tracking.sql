-- Migration: Create sync_tracking table
CREATE TABLE IF NOT EXISTS sync_tracking(
    id SERIAL NOT NULL,
    table_name varchar(50) NOT NULL,
    record_id uuid NOT NULL,
    operation varchar(10) NOT NULL,
    sync_status varchar(20) NOT NULL DEFAULT 'pending',
    sync_error text,
    last_sync_attempt timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    "data" jsonb,
    PRIMARY KEY(id)
);

-- Create unique index to prevent duplicate tracking entries
CREATE UNIQUE INDEX IF NOT EXISTS sync_tracking_unique 
ON sync_tracking(table_name, record_id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_sync_tracking_table_record 
ON sync_tracking(table_name, record_id);

-- Add comment for documentation
COMMENT ON TABLE sync_tracking IS 'Tracks synchronization status of records across devices';
COMMENT ON COLUMN sync_tracking.sync_status IS 'Status of sync operation (pending, completed, failed)';
COMMENT ON COLUMN sync_tracking.operation IS 'Type of operation (create, update, delete)'; 