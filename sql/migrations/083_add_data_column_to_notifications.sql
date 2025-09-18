-- Migration 083: Add missing data column to notifications table
-- The create_group_list_attachment_consents trigger expects a data column to store jsonb metadata
-- This was missing from the original notifications table schema

-- Add data column to notifications table if it doesn't exist
ALTER TABLE notifications
ADD COLUMN IF NOT EXISTS data JSONB;

-- Create index on data column for better query performance when filtering by data fields
CREATE INDEX IF NOT EXISTS idx_notifications_data ON notifications USING gin(data);

-- Update existing notifications to have an empty JSON object if NULL
UPDATE notifications
SET data = '{}'::jsonb
WHERE data IS NULL;

-- Add comment to explain the purpose of the data column
COMMENT ON COLUMN notifications.data IS 'Additional metadata for the notification in JSON format';