-- Ultra-isolated diagnostic query to check group membership
-- This avoids all complex operations that might trigger the l.name error

-- Simple check: Are there any records in collaboration_group_members?
DO $$
DECLARE
    member_count INTEGER;
    processed_count INTEGER;
    group_count INTEGER;
BEGIN
    -- Count total members
    SELECT COUNT(*) INTO member_count FROM collaboration_group_members;
    RAISE NOTICE 'Total records in collaboration_group_members: %', member_count;

    -- Count processed pending invitations
    SELECT COUNT(*) INTO processed_count
    FROM pending_group_invitations
    WHERE status = 'processed';
    RAISE NOTICE 'Total processed pending invitations: %', processed_count;

    -- Count distinct groups with processed invitations
    SELECT COUNT(DISTINCT group_id) INTO group_count
    FROM pending_group_invitations
    WHERE status = 'processed';
    RAISE NOTICE 'Groups with processed invitations: %', group_count;
END $$;

-- Direct insert to fix membership (no joins, no complex queries)
DO $$
DECLARE
    fixed_count INTEGER := 0;
    pgi_rec RECORD;
BEGIN
    -- Loop through each processed invitation
    FOR pgi_rec IN
        SELECT group_id, invitee_id
        FROM pending_group_invitations
        WHERE status = 'processed'
    LOOP
        -- Check if member exists using a simple count
        IF NOT EXISTS (
            SELECT 1
            FROM collaboration_group_members
            WHERE group_id = pgi_rec.group_id
            AND user_id = pgi_rec.invitee_id
        ) THEN
            -- Add the member
            INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
            VALUES (pgi_rec.group_id, pgi_rec.invitee_id, 'member', CURRENT_TIMESTAMP)
            ON CONFLICT DO NOTHING;

            fixed_count := fixed_count + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'Added % missing members', fixed_count;
END $$;

-- Check specific user membership (replace these values with actual IDs)
-- You can uncomment and modify this section with actual user/group IDs
/*
DO $$
DECLARE
    user_b_id UUID := 'REPLACE_WITH_USER_B_ID';
    group_id UUID := 'REPLACE_WITH_GROUP_ID';
    is_member BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1
        FROM collaboration_group_members
        WHERE group_id = group_id
        AND user_id = user_b_id
    ) INTO is_member;

    RAISE NOTICE 'User % is member of group %: %', user_b_id, group_id, is_member;
END $$;
*/

-- Final count to verify
DO $$
DECLARE
    final_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO final_count FROM collaboration_group_members;
    RAISE NOTICE 'Final total members in collaboration_group_members: %', final_count;
END $$;