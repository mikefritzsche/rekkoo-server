-- Deep clean all group-related data
-- This is more thorough and will find any remaining groups

-- Commit any pending transaction first
COMMIT;

-- Start fresh transaction
BEGIN;

-- 1. Show what groups still exist
DO $$
DECLARE
    rec RECORD;
BEGIN
    RAISE NOTICE '=== Remaining Groups ===';
    FOR rec IN
        SELECT id, name, owner_id, created_at
        FROM collaboration_groups
    LOOP
        RAISE NOTICE 'Group: % (%) owned by % created %',
            rec.name, rec.id, rec.owner_id, rec.created_at;
    END LOOP;

    -- Show group members
    RAISE NOTICE '=== Remaining Group Members ===';
    FOR rec IN
        SELECT cgm.group_id, cgm.user_id, u.username, cg.name as group_name
        FROM collaboration_group_members cgm
        LEFT JOIN users u ON u.id = cgm.user_id
        LEFT JOIN collaboration_groups cg ON cg.id = cgm.group_id
    LOOP
        RAISE NOTICE 'Member: % in group %', rec.username, rec.group_name;
    END LOOP;
END $$;

-- 2. Clean list_group_roles first (foreign key constraint)
TRUNCATE TABLE list_group_roles CASCADE;

-- 3. Clean list_sharing entries for groups
DELETE FROM list_sharing WHERE shared_with_group_id IS NOT NULL;

-- 4. Clean up group-related list attachments
DELETE FROM list_group_user_roles;
DELETE FROM group_list_attachment_consents;

-- 5. Clean all invitation tables
TRUNCATE TABLE group_invitations CASCADE;
TRUNCATE TABLE pending_group_invitations CASCADE;
TRUNCATE TABLE connection_invitations CASCADE;

-- 6. Clean group members
TRUNCATE TABLE collaboration_group_members CASCADE;

-- 7. Clean the groups themselves
TRUNCATE TABLE collaboration_groups CASCADE;

-- 8. Clean pending connections and invitations
DELETE FROM connections WHERE status IN ('pending', 'declined', 'cancelled', 'expired');

-- 9. Also check for any soft-deleted groups (if there's a deleted_at column)
DO $$
BEGIN
    -- Check if deleted_at column exists
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'collaboration_groups'
        AND column_name = 'deleted_at'
    ) THEN
        -- Hard delete soft-deleted groups
        EXECUTE 'DELETE FROM collaboration_groups WHERE deleted_at IS NOT NULL';
        RAISE NOTICE 'Cleaned soft-deleted groups';
    END IF;
END $$;

-- 10. Check change_log table for any group references
DO $$
DECLARE
    count_before INTEGER;
    count_after INTEGER;
BEGIN
    -- Check if change_log table exists
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'change_log'
    ) THEN
        SELECT COUNT(*) INTO count_before FROM change_log
        WHERE table_name IN ('collaboration_groups', 'collaboration_group_members', 'group_invitations');

        DELETE FROM change_log
        WHERE table_name IN ('collaboration_groups', 'collaboration_group_members', 'group_invitations');

        GET DIAGNOSTICS count_after = ROW_COUNT;
        RAISE NOTICE 'Deleted % change_log entries for groups', count_after;
    END IF;
END $$;

-- 11. Verify everything is clean
DO $$
DECLARE
    group_count INTEGER;
    member_count INTEGER;
    inv_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO group_count FROM collaboration_groups;
    SELECT COUNT(*) INTO member_count FROM collaboration_group_members;
    SELECT COUNT(*) INTO inv_count FROM group_invitations;

    RAISE NOTICE '=== Final Counts (should all be 0) ===';
    RAISE NOTICE 'Groups: %', group_count;
    RAISE NOTICE 'Members: %', member_count;
    RAISE NOTICE 'Invitations: %', inv_count;

    IF group_count > 0 OR member_count > 0 OR inv_count > 0 THEN
        RAISE WARNING 'Some data still remains! Check for foreign key constraints or triggers preventing deletion.';
    ELSE
        RAISE NOTICE 'SUCCESS: All group data has been cleaned!';
    END IF;
END $$;

-- Commit the cleanup
COMMIT;

-- Final verification query
SELECT 'collaboration_groups' as table_name, COUNT(*) as remaining_records
FROM collaboration_groups
UNION ALL
SELECT 'collaboration_group_members', COUNT(*)
FROM collaboration_group_members
UNION ALL
SELECT 'group_invitations', COUNT(*)
FROM group_invitations
UNION ALL
SELECT 'pending_group_invitations', COUNT(*)
FROM pending_group_invitations
UNION ALL
SELECT 'connection_invitations', COUNT(*)
FROM connection_invitations
ORDER BY table_name;