-- Direct INSERT to fix membership - avoiding all triggers and complex queries
-- This is the most minimal approach possible

-- Step 1: Get the user ID for mf65
-- We'll do this in the simplest way possible
DO $$
DECLARE
    v_user_id UUID;
    v_group_id UUID;
BEGIN
    -- Get user ID
    SELECT id INTO v_user_id FROM users WHERE username = 'mf65' LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE NOTICE 'User mf65 not found';
        RETURN;
    END IF;

    RAISE NOTICE 'Found user mf65 with ID: %', v_user_id;

    -- Get the group ID from accepted invitations
    SELECT group_id INTO v_group_id
    FROM group_invitations
    WHERE invitee_id = v_user_id
    AND status = 'accepted'
    LIMIT 1;

    IF v_group_id IS NULL THEN
        RAISE NOTICE 'No accepted group invitation found for mf65';
        RETURN;
    END IF;

    RAISE NOTICE 'Found group ID: %', v_group_id;

    -- Direct insert - no joins, no subqueries
    BEGIN
        INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
        VALUES (v_group_id, v_user_id, 'member', NOW());
        RAISE NOTICE 'Successfully added mf65 to group';
    EXCEPTION WHEN unique_violation THEN
        -- Already exists, update it
        UPDATE collaboration_group_members
        SET joined_at = COALESCE(joined_at, NOW())
        WHERE group_id = v_group_id AND user_id = v_user_id;
        RAISE NOTICE 'Updated existing membership for mf65';
    END;
END $$;

-- If the above doesn't work, try raw SQL inserts
-- Replace the UUIDs with actual values from your database

-- First, run this query to get the IDs:
-- SELECT u.id as user_id, gi.group_id
-- FROM users u
-- JOIN group_invitations gi ON gi.invitee_id = u.id
-- WHERE u.username = 'mf65' AND gi.status = 'accepted';

-- Then uncomment and run this with the actual UUIDs:
-- INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
-- VALUES ('YOUR_GROUP_ID_HERE', 'YOUR_USER_ID_HERE', 'member', NOW())
-- ON CONFLICT (group_id, user_id) DO NOTHING;