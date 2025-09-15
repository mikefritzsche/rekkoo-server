-- Find and fix the trigger that's causing the l.name error

-- Step 1: List all triggers on collaboration_group_members
DO $$
DECLARE
    trigger_rec RECORD;
BEGIN
    RAISE NOTICE '=== Triggers on collaboration_group_members ===';
    FOR trigger_rec IN
        SELECT tgname, proname
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE tgrelid = 'collaboration_group_members'::regclass
        AND tgname NOT LIKE 'RI_ConstraintTrigger%'  -- Exclude foreign key triggers
    LOOP
        RAISE NOTICE 'Trigger: %, Function: %', trigger_rec.tgname, trigger_rec.proname;
    END LOOP;
END $$;

-- Step 2: Temporarily disable ALL triggers on the table
ALTER TABLE collaboration_group_members DISABLE TRIGGER ALL;

-- Step 3: Now do the insert for mf65
DO $$
DECLARE
    v_user_id UUID;
    v_group_id UUID;
    v_count INTEGER;
BEGIN
    -- Get user ID
    SELECT id INTO v_user_id FROM users WHERE username = 'mf65' LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE NOTICE 'User mf65 not found';
    ELSE
        RAISE NOTICE 'Found user mf65 with ID: %', v_user_id;

        -- Get all accepted group invitations for this user
        FOR v_group_id IN
            SELECT group_id
            FROM group_invitations
            WHERE invitee_id = v_user_id
            AND status = 'accepted'
        LOOP
            -- Check if already a member
            SELECT COUNT(*) INTO v_count
            FROM collaboration_group_members
            WHERE group_id = v_group_id AND user_id = v_user_id;

            IF v_count = 0 THEN
                -- Add as member
                INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
                VALUES (v_group_id, v_user_id, 'member', NOW());
                RAISE NOTICE 'Added mf65 to group %', v_group_id;
            ELSE
                RAISE NOTICE 'mf65 already member of group %', v_group_id;
            END IF;
        END LOOP;
    END IF;
END $$;

-- Step 4: Re-enable triggers
ALTER TABLE collaboration_group_members ENABLE TRIGGER ALL;

-- Step 5: Find and fix the problematic trigger function
-- Look for any function that might reference l.name
DO $$
DECLARE
    func_rec RECORD;
BEGIN
    RAISE NOTICE '=== Searching for functions with l.name reference ===';

    FOR func_rec IN
        SELECT proname, prosrc
        FROM pg_proc
        WHERE prosrc LIKE '%l.name%'
        AND proname IN (
            SELECT proname
            FROM pg_trigger t
            JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE tgrelid = 'collaboration_group_members'::regclass
        )
    LOOP
        RAISE NOTICE 'Found problematic function: %', func_rec.proname;
        RAISE NOTICE 'Function contains: %', SUBSTRING(func_rec.prosrc, POSITION('l.name' IN func_rec.prosrc) - 50, 100);
    END LOOP;
END $$;

-- Step 6: Check if the sync_log_trigger is the problem
-- This is a common trigger that might have issues
DO $$
BEGIN
    -- Check if log_table_changes function exists and might be the issue
    IF EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'log_table_changes'
    ) THEN
        RAISE NOTICE 'log_table_changes function exists - this might be the problem';

        -- Try to get its definition
        RAISE NOTICE 'Checking if it references l.name...';
    END IF;
END $$;

-- Step 7: As a last resort, drop and recreate the sync trigger if it exists
-- This is often the culprit
DO $$
BEGIN
    -- Drop the sync_log_trigger if it exists
    IF EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'sync_log_trigger_collaboration_group_members'
        AND tgrelid = 'collaboration_group_members'::regclass
    ) THEN
        DROP TRIGGER sync_log_trigger_collaboration_group_members ON collaboration_group_members;
        RAISE NOTICE 'Dropped sync_log_trigger_collaboration_group_members';

        -- Recreate it without the problematic reference
        CREATE TRIGGER sync_log_trigger_collaboration_group_members
        AFTER INSERT OR UPDATE OR DELETE ON collaboration_group_members
        FOR EACH ROW EXECUTE FUNCTION log_table_changes();
        RAISE NOTICE 'Recreated sync_log_trigger_collaboration_group_members';
    END IF;
END $$;

-- Step 8: Verify the fix worked
DO $$
DECLARE
    member_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO member_count
    FROM collaboration_group_members cgm
    JOIN users u ON u.id = cgm.user_id
    WHERE u.username = 'mf65';

    RAISE NOTICE 'Final check: mf65 is member of % groups', member_count;
END $$;