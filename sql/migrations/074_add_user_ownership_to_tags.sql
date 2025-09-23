-- Migration: Add user ownership to tags table
-- This migration adds user_id column to tags table for privacy features
COMMIT;
-- Start transaction
BEGIN;

-- Add user_id column to tags table
ALTER TABLE tags ADD COLUMN IF NOT EXISTS user_id UUID;

-- Create index for user_id column
CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);

-- For existing tags, we'll let the application handle user_id population
-- The app will set user_id when users interact with tags going forward

-- Add list_type column to tags if it doesn't exist (needed for proper tag isolation)
ALTER TABLE tags ADD COLUMN IF NOT EXISTS list_type TEXT;

-- Create index for list_type column if it was added
CREATE INDEX IF NOT EXISTS idx_tags_list_type ON tags(list_type);

-- Update existing tags to set list_type based on current usage patterns
-- Set default list_type for tags that don't have one
UPDATE tags
SET list_type = 'default'
WHERE list_type IS NULL;

-- Commit the transaction
COMMIT;