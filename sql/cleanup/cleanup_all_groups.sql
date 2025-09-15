-- Cleanup script to remove all groups and related data
-- Use this to reset groups during development
-- WARNING: This will permanently delete all group data for all users

BEGIN;

-- Show counts before deletion for verification
SELECT 'collaboration_groups' as table_name, COUNT(*) as count FROM collaboration_groups
UNION ALL
SELECT 'group_members', COUNT(*) FROM group_members
UNION ALL
SELECT 'group_invitations', COUNT(*) FROM group_invitations
UNION ALL
SELECT 'pending_group_invitations', COUNT(*) FROM pending_group_invitations
UNION ALL
SELECT 'list_shares (group shares)', COUNT(*) FROM list_shares WHERE share_type = 'group';

-- Delete all pending group invitations (cascade from connection invitations)
DELETE FROM pending_group_invitations;

-- Delete all group invitations
DELETE FROM group_invitations;

-- Delete all group members
DELETE FROM group_members;

-- Delete all list shares that are group-based
DELETE FROM list_shares WHERE share_type = 'group';

-- Delete all collaboration groups
-- This will cascade delete related records due to foreign key constraints
DELETE FROM collaboration_groups;

-- Reset any connection invitations that have group context
UPDATE connection_invitations
SET invitation_context = NULL,
    context_id = NULL,
    metadata = '{}'::jsonb
WHERE invitation_context = 'group_invitation';

-- Show counts after deletion to confirm
SELECT 'AFTER CLEANUP:' as status;
SELECT 'collaboration_groups' as table_name, COUNT(*) as count FROM collaboration_groups
UNION ALL
SELECT 'group_members', COUNT(*) FROM group_members
UNION ALL
SELECT 'group_invitations', COUNT(*) FROM group_invitations
UNION ALL
SELECT 'pending_group_invitations', COUNT(*) FROM pending_group_invitations
UNION ALL
SELECT 'list_shares (group shares)', COUNT(*) FROM list_shares WHERE share_type = 'group';

COMMIT;

-- Note: After running this, you may want to also clear any cached data in your app
-- and restart your application to ensure a clean state