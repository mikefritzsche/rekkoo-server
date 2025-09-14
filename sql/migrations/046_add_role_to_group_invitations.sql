-- Migration: 046_add_role_to_group_invitations.sql
-- Purpose: Add role column to group_invitations table to specify intended role upon acceptance
-- Date: 2025-09-14

BEGIN;

-- Step 1: Add role column to group_invitations table
ALTER TABLE public.group_invitations
ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member';

-- Step 2: Add constraint for valid roles
ALTER TABLE public.group_invitations
ADD CONSTRAINT valid_invitation_role CHECK (role IN ('owner', 'admin', 'member', 'viewer'));

-- Step 3: Add comment to document the column
COMMENT ON COLUMN public.group_invitations.role IS 'The role the invitee will have when they accept the invitation';

-- Step 4: Create index for performance
CREATE INDEX IF NOT EXISTS idx_group_invitations_role
ON public.group_invitations (role);

-- Step 5: Update existing invitations to have default role
UPDATE public.group_invitations
SET role = 'member'
WHERE role IS NULL;

-- Step 6: Verify the migration
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'group_invitations'
        AND column_name = 'role'
    ) THEN
        RAISE NOTICE '✅ Successfully added role column to group_invitations table';
    ELSE
        RAISE EXCEPTION '❌ Failed to add role column to group_invitations table';
    END IF;
END $$;

COMMIT;

-- Rollback script (save as rollback_046_group_invitation_role.sql)
-- BEGIN;
-- ALTER TABLE public.group_invitations DROP COLUMN IF EXISTS role;
-- DROP INDEX IF EXISTS idx_group_invitations_role;
-- COMMIT;