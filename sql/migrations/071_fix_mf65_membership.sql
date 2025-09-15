-- Fix the specific membership issue for mf65 and any similar cases
-- The user has accepted invitations but isn't showing as a member

-- First, let's verify the issue
DO $$
DECLARE
    rec RECORD;
    fixed_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Checking for users with accepted invitations but no membership...';

    -- Find all accepted group invitations where user is not a member
    FOR rec IN
        SELECT
            gi.group_id,
            gi.invitee_id,
            gi.inviter_id,
            u.username,
            cg.name as group_name
        FROM group_invitations gi
        JOIN users u ON u.id = gi.invitee_id
        JOIN collaboration_groups cg ON cg.id = gi.group_id
        WHERE gi.status = 'accepted'
        AND NOT EXISTS (
            SELECT 1 FROM collaboration_group_members cgm
            WHERE cgm.group_id = gi.group_id
            AND cgm.user_id = gi.invitee_id
        )
    LOOP
        RAISE NOTICE 'Adding % (%) to group % (%)',
            rec.username, rec.invitee_id, rec.group_name, rec.group_id;

        -- Add the member
        INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
        VALUES (rec.group_id, rec.invitee_id, 'member', CURRENT_TIMESTAMP)
        ON CONFLICT (group_id, user_id) DO NOTHING;

        fixed_count := fixed_count + 1;
    END LOOP;

    IF fixed_count > 0 THEN
        RAISE NOTICE 'Added % users to their groups', fixed_count;
    ELSE
        RAISE NOTICE 'No missing memberships found';
    END IF;
END $$;

-- Specifically ensure mf65 is in the correct group
DO $$
DECLARE
    user_id UUID;
    group_rec RECORD;
BEGIN
    -- Get mf65's user ID
    SELECT id INTO user_id FROM users WHERE username = 'mf65';

    IF user_id IS NOT NULL THEN
        RAISE NOTICE 'Processing user mf65 (ID: %)', user_id;

        -- Find all groups where mf65 has an accepted invitation
        FOR group_rec IN
            SELECT gi.group_id, cg.name as group_name
            FROM group_invitations gi
            JOIN collaboration_groups cg ON cg.id = gi.group_id
            WHERE gi.invitee_id = user_id
            AND gi.status = 'accepted'
        LOOP
            RAISE NOTICE 'Ensuring mf65 is member of group % (%)',
                group_rec.group_name, group_rec.group_id;

            -- Add to group if not already a member
            INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
            VALUES (group_rec.group_id, user_id, 'member', CURRENT_TIMESTAMP)
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                -- If already exists, just ensure the joined_at is set
                joined_at = COALESCE(collaboration_group_members.joined_at, CURRENT_TIMESTAMP);
        END LOOP;
    ELSE
        RAISE NOTICE 'User mf65 not found';
    END IF;
END $$;

-- Verify the fix
DO $$
DECLARE
    member_count INTEGER;
    accepted_count INTEGER;
BEGIN
    -- Count how many accepted invitations have corresponding memberships
    SELECT COUNT(*) INTO accepted_count
    FROM group_invitations
    WHERE status = 'accepted';

    SELECT COUNT(DISTINCT (group_id, user_id)) INTO member_count
    FROM group_invitations gi
    JOIN collaboration_group_members cgm ON
        cgm.group_id = gi.group_id AND
        cgm.user_id = gi.invitee_id
    WHERE gi.status = 'accepted';

    RAISE NOTICE 'Verification: % accepted invitations, % have memberships',
        accepted_count, member_count;

    -- Check mf65 specifically
    IF EXISTS (
        SELECT 1 FROM users u
        JOIN collaboration_group_members cgm ON cgm.user_id = u.id
        WHERE u.username = 'mf65'
    ) THEN
        RAISE NOTICE 'SUCCESS: mf65 is now a member of at least one group';
    ELSE
        RAISE NOTICE 'WARNING: mf65 still not showing as a member';
    END IF;
END $$;