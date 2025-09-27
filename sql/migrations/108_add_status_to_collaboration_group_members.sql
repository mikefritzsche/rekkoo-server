-- Migration: Add status and invited_by columns to collaboration_group_members
-- Description: Adds missing columns needed for auto-add functionality
-- Date: 2025-09-26
COMMIT;
BEGIN;

-- Add status column with default value
ALTER TABLE public.collaboration_group_members
ADD COLUMN status VARCHAR(20) DEFAULT 'active' NOT NULL;

-- Add invited_by column to track who invited the user
ALTER TABLE public.collaboration_group_members
ADD COLUMN invited_by uuid;

-- Add constraint for valid status values
ALTER TABLE public.collaboration_group_members
ADD CONSTRAINT collaboration_group_members_status_check
CHECK (status IN ('active', 'inactive', 'pending', 'removed'));

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_collaboration_group_members_status
ON public.collaboration_group_members(status);

-- Add index for invited_by
CREATE INDEX IF NOT EXISTS idx_collaboration_group_members_invited_by
ON public.collaboration_group_members(invited_by);

-- Update existing records to ensure they have the correct status
UPDATE public.collaboration_group_members
SET status = 'active'
WHERE status IS NULL;

-- Add comments
COMMENT ON COLUMN public.collaboration_group_members.status IS 'Membership status: active, inactive, pending, or removed';
COMMENT ON COLUMN public.collaboration_group_members.invited_by IS 'User ID who invited this member to the group (null for original creators)';

COMMIT;