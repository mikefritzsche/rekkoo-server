-- Quick cleanup script to remove all groups
-- Run this in your PostgreSQL client

-- Delete all collaboration groups (cascades to related tables)
DELETE FROM collaboration_groups;

-- Clear group context from connection invitations
UPDATE connection_invitations
SET invitation_context = NULL,
    context_id = NULL,
    metadata = '{}'::jsonb
WHERE invitation_context = 'group_invitation';

-- Verify cleanup
SELECT
  'Groups deleted. Remaining counts:' as status,
  (SELECT COUNT(*) FROM collaboration_groups) as groups,
  (SELECT COUNT(*) FROM group_members) as members,
  (SELECT COUNT(*) FROM group_invitations) as invitations;