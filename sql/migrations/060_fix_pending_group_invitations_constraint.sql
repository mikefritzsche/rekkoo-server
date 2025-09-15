-- Fix unique constraint on pending_group_invitations table
-- The ON CONFLICT clause in invite_user_to_group_cascade function expects (group_id, invitee_id)
-- but the table was created with (group_id, invitee_id, status)

-- First, drop the existing constraint
ALTER TABLE pending_group_invitations
DROP CONSTRAINT IF EXISTS unique_pending_group_invitation;

-- Add the new unique constraint without status
-- This ensures only one pending invitation per group/invitee combination
ALTER TABLE pending_group_invitations
ADD CONSTRAINT unique_pending_group_invitation
UNIQUE (group_id, invitee_id);

-- Add a comment to document this change
COMMENT ON CONSTRAINT unique_pending_group_invitation ON pending_group_invitations
IS 'Ensures only one pending invitation per group and invitee combination, regardless of status';