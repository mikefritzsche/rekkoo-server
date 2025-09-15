-- Reset all groups, invitations, and related data
-- WARNING: This will delete all collaboration groups and invitation data!
-- Run this script to start fresh with the invitation system
COMMIT;
-- Start transaction
BEGIN;

-- Show counts before deletion
DO $$
DECLARE
    group_count INTEGER;
    member_count INTEGER;
    group_inv_count INTEGER;
    pending_inv_count INTEGER;
    conn_inv_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO group_count FROM collaboration_groups;
    SELECT COUNT(*) INTO member_count FROM collaboration_group_members;
    SELECT COUNT(*) INTO group_inv_count FROM group_invitations;
    SELECT COUNT(*) INTO pending_inv_count FROM pending_group_invitations;
    SELECT COUNT(*) INTO conn_inv_count FROM connection_invitations;

    RAISE NOTICE '=== Before Reset ===';
    RAISE NOTICE 'Groups: %', group_count;
    RAISE NOTICE 'Group Members: %', member_count;
    RAISE NOTICE 'Group Invitations: %', group_inv_count;
    RAISE NOTICE 'Pending Group Invitations: %', pending_inv_count;
    RAISE NOTICE 'Connection Invitations: %', conn_inv_count;
END $$;

-- 1. Delete all group-related list attachments
DELETE FROM list_group_roles;
DELETE FROM list_sharing WHERE shared_with_group_id IS NOT NULL;

-- 2. Delete all group invitations
DELETE FROM group_invitations;
DELETE FROM pending_group_invitations;

-- 3. Delete all group members
DELETE FROM collaboration_group_members;

-- 4. Delete all groups
DELETE FROM collaboration_groups;

-- 5. Delete all connection invitations (to reset the invitation flow)
DELETE FROM connection_invitations;

-- 6. Reset connections to remove pending/incomplete connections
-- Keep only accepted mutual connections
DELETE FROM connections
WHERE status != 'accepted'
   OR connection_type != 'mutual';

-- 7. Clean up any orphaned notifications related to groups/invitations
-- Skipping notifications table as it may not exist or have different structure

-- 8. Reset privacy settings to standard mode for easier testing
UPDATE user_settings
SET privacy_settings = jsonb_set(
    COALESCE(privacy_settings, '{}'::jsonb),
    '{privacy_mode}',
    '"standard"'
)
WHERE privacy_settings->>'privacy_mode' IN ('ghost', 'private');

-- Show counts after deletion
DO $$
DECLARE
    group_count INTEGER;
    member_count INTEGER;
    group_inv_count INTEGER;
    pending_inv_count INTEGER;
    conn_inv_count INTEGER;
    conn_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO group_count FROM collaboration_groups;
    SELECT COUNT(*) INTO member_count FROM collaboration_group_members;
    SELECT COUNT(*) INTO group_inv_count FROM group_invitations;
    SELECT COUNT(*) INTO pending_inv_count FROM pending_group_invitations;
    SELECT COUNT(*) INTO conn_inv_count FROM connection_invitations;
    SELECT COUNT(*) INTO conn_count FROM connections WHERE status = 'accepted';

    RAISE NOTICE '=== After Reset ===';
    RAISE NOTICE 'Groups: % (should be 0)', group_count;
    RAISE NOTICE 'Group Members: % (should be 0)', member_count;
    RAISE NOTICE 'Group Invitations: % (should be 0)', group_inv_count;
    RAISE NOTICE 'Pending Group Invitations: % (should be 0)', pending_inv_count;
    RAISE NOTICE 'Connection Invitations: % (should be 0)', conn_inv_count;
    RAISE NOTICE 'Accepted Connections: % (preserved)', conn_count;
END $$;

-- Commit the transaction
COMMIT;

-- Verification queries to check the reset
SELECT 'Groups' as table_name, COUNT(*) as count FROM collaboration_groups
UNION ALL
SELECT 'Group Members', COUNT(*) FROM collaboration_group_members
UNION ALL
SELECT 'Group Invitations', COUNT(*) FROM group_invitations
UNION ALL
SELECT 'Pending Group Invitations', COUNT(*) FROM pending_group_invitations
UNION ALL
SELECT 'Connection Invitations', COUNT(*) FROM connection_invitations
UNION ALL
SELECT 'Connections (accepted)', COUNT(*) FROM connections WHERE status = 'accepted'
UNION ALL
SELECT 'Connections (pending)', COUNT(*) FROM connections WHERE status = 'pending'
ORDER BY table_name;