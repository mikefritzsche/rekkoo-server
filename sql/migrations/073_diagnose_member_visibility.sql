-- Diagnose why group members aren't showing in the UI
-- The server query uses privacy settings and can_view_user function

-- First, let's see what's in the collaboration_group_members table
DO $$
DECLARE
    rec RECORD;
BEGIN
    RAISE NOTICE '=== All Group Members ===';
    FOR rec IN
        SELECT
            cgm.group_id,
            cgm.user_id,
            cgm.role,
            cgm.joined_at,
            u.username,
            cg.name as group_name
        FROM collaboration_group_members cgm
        JOIN users u ON u.id = cgm.user_id
        JOIN collaboration_groups cg ON cg.id = cgm.group_id
        ORDER BY cg.name, u.username
    LOOP
        RAISE NOTICE 'Group: % | User: % | Role: % | Joined: %',
            rec.group_name, rec.username, rec.role, rec.joined_at;
    END LOOP;
END $$;

-- Check privacy settings for users in groups
DO $$
DECLARE
    rec RECORD;
BEGIN
    RAISE NOTICE '=== Privacy Settings for Group Members ===';
    FOR rec IN
        SELECT
            u.username,
            us.privacy_settings->>'privacy_mode' as privacy_mode,
            us.privacy_settings->>'anonymous_in_groups' as anonymous_in_groups,
            cg.name as group_name
        FROM collaboration_group_members cgm
        JOIN users u ON u.id = cgm.user_id
        JOIN collaboration_groups cg ON cg.id = cgm.group_id
        LEFT JOIN user_settings us ON us.user_id = u.id
        ORDER BY cg.name, u.username
    LOOP
        RAISE NOTICE 'User: % | Group: % | Privacy: % | Anonymous: %',
            rec.username, rec.group_name,
            COALESCE(rec.privacy_mode, 'not set'),
            COALESCE(rec.anonymous_in_groups, 'false');
    END LOOP;
END $$;

-- Check if can_view_user function exists and what it returns
DO $$
DECLARE
    viewer_id UUID;
    target_id UUID;
    can_view BOOLEAN;
BEGIN
    RAISE NOTICE '=== Testing can_view_user function ===';

    -- Get a sample viewer (group owner) and target (group member)
    SELECT cg.owner_id, cgm.user_id
    INTO viewer_id, target_id
    FROM collaboration_groups cg
    JOIN collaboration_group_members cgm ON cgm.group_id = cg.id
    WHERE cgm.user_id != cg.owner_id
    LIMIT 1;

    IF viewer_id IS NOT NULL AND target_id IS NOT NULL THEN
        -- Check if the function exists
        IF EXISTS (
            SELECT 1 FROM pg_proc WHERE proname = 'can_view_user'
        ) THEN
            -- Test the function
            SELECT public.can_view_user(viewer_id, target_id) INTO can_view;
            RAISE NOTICE 'can_view_user result: viewer % -> target % = %',
                viewer_id, target_id, can_view;
        ELSE
            RAISE NOTICE 'can_view_user function does not exist!';
        END IF;
    END IF;
END $$;

-- Create or fix the can_view_user function if it's missing or broken
CREATE OR REPLACE FUNCTION public.can_view_user(viewer_id UUID, target_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Same user can always view themselves
    IF viewer_id = target_id THEN
        RETURN TRUE;
    END IF;

    -- Check if they're connected
    IF EXISTS (
        SELECT 1 FROM connections
        WHERE user_id = viewer_id
        AND connection_id = target_id
        AND status = 'accepted'
    ) THEN
        RETURN TRUE;
    END IF;

    -- Check if they're in the same group
    IF EXISTS (
        SELECT 1
        FROM collaboration_group_members cgm1
        JOIN collaboration_group_members cgm2 ON cgm1.group_id = cgm2.group_id
        WHERE cgm1.user_id = viewer_id
        AND cgm2.user_id = target_id
    ) THEN
        RETURN TRUE;
    END IF;

    -- Check privacy settings
    IF EXISTS (
        SELECT 1 FROM user_settings
        WHERE user_id = target_id
        AND privacy_settings->>'privacy_mode' = 'public'
    ) THEN
        RETURN TRUE;
    END IF;

    -- Default: cannot view
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.can_view_user IS 'Determines if one user can view another users profile based on connections, groups, and privacy settings';

-- Test the getGroupMembers query exactly as the server runs it
DO $$
DECLARE
    test_group_id UUID;
    test_requester_id UUID;
    member_count INTEGER;
BEGIN
    -- Get a group and its owner for testing
    SELECT id, owner_id INTO test_group_id, test_requester_id
    FROM collaboration_groups
    LIMIT 1;

    IF test_group_id IS NOT NULL THEN
        RAISE NOTICE '=== Testing getGroupMembers query for group % ===', test_group_id;

        -- Count how many members the query would return
        SELECT COUNT(*) INTO member_count
        FROM collaboration_group_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE m.group_id = test_group_id;

        RAISE NOTICE 'Query would return % members', member_count;

        -- Now test with privacy filtering
        SELECT COUNT(*) INTO member_count
        FROM collaboration_group_members m
        JOIN users u ON u.id = m.user_id
        LEFT JOIN user_settings us ON u.id = us.user_id
        WHERE m.group_id = test_group_id
        AND (
            -- Would the viewer see this member?
            us.privacy_settings->>'privacy_mode' != 'ghost'
            OR public.can_view_user(test_requester_id, m.user_id)
        );

        RAISE NOTICE 'With privacy filtering: % members visible', member_count;
    END IF;
END $$;

-- Fix privacy settings if they're blocking visibility
UPDATE user_settings
SET privacy_settings = jsonb_set(
    COALESCE(privacy_settings, '{}'::jsonb),
    '{privacy_mode}',
    '"standard"'
)
WHERE user_id IN (
    SELECT user_id FROM collaboration_group_members
)
AND (
    privacy_settings->>'privacy_mode' = 'ghost'
    OR privacy_settings IS NULL
);

-- Final verification
DO $$
DECLARE
    rec RECORD;
BEGIN
    RAISE NOTICE '=== Final Member Visibility Check ===';
    FOR rec IN
        SELECT
            cg.name as group_name,
            COUNT(cgm.user_id) as total_members,
            COUNT(CASE WHEN us.privacy_settings->>'privacy_mode' != 'ghost' THEN 1 END) as visible_members
        FROM collaboration_groups cg
        LEFT JOIN collaboration_group_members cgm ON cgm.group_id = cg.id
        LEFT JOIN user_settings us ON us.user_id = cgm.user_id
        GROUP BY cg.id, cg.name
    LOOP
        RAISE NOTICE 'Group: % | Total: % | Visible: %',
            rec.group_name, rec.total_members, rec.visible_members;
    END LOOP;
END $$;