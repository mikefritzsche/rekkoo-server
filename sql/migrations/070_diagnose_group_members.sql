-- Diagnostic queries to check group membership data
-- Run this to see what's in the database

-- Check if users are in collaboration_group_members
DO $$
DECLARE
    rec RECORD;
BEGIN
    RAISE NOTICE '=== Checking Group Members for Processed Invitations ===';

    FOR rec IN
        SELECT
            pgi.group_id,
            pgi.invitee_id,
            pgi.inviter_id,
            pgi.status as pending_status,
            gi.status as invitation_status,
            cgm.user_id as member_user_id,
            cgm.role as member_role,
            cgm.joined_at,
            cg.name as group_name,
            u.username as invitee_username
        FROM pending_group_invitations pgi
        LEFT JOIN group_invitations gi ON
            gi.group_id = pgi.group_id AND
            gi.invitee_id = pgi.invitee_id
        LEFT JOIN collaboration_group_members cgm ON
            cgm.group_id = pgi.group_id AND
            cgm.user_id = pgi.invitee_id
        LEFT JOIN collaboration_groups cg ON
            cg.id = pgi.group_id
        LEFT JOIN users u ON
            u.id = pgi.invitee_id
        WHERE pgi.status = 'processed'
        ORDER BY pgi.processed_at DESC
        LIMIT 10
    LOOP
        RAISE NOTICE 'Group: % (%), User: % (%), Invitation: %, Member exists: %, Role: %',
            rec.group_name, rec.group_id,
            rec.invitee_username, rec.invitee_id,
            rec.invitation_status,
            CASE WHEN rec.member_user_id IS NOT NULL THEN 'YES' ELSE 'NO' END,
            rec.member_role;
    END LOOP;

    RAISE NOTICE '=== Checking All Group Members ===';

    -- Also check what members exist for groups with processed invitations
    FOR rec IN
        SELECT DISTINCT
            cg.id as group_id,
            cg.name as group_name,
            COUNT(DISTINCT cgm.user_id) as member_count,
            COUNT(DISTINCT pgi.invitee_id) as processed_invitation_count
        FROM collaboration_groups cg
        LEFT JOIN collaboration_group_members cgm ON cgm.group_id = cg.id
        LEFT JOIN pending_group_invitations pgi ON
            pgi.group_id = cg.id AND
            pgi.status = 'processed'
        WHERE EXISTS (
            SELECT 1 FROM pending_group_invitations pgi2
            WHERE pgi2.group_id = cg.id AND pgi2.status = 'processed'
        )
        GROUP BY cg.id, cg.name
    LOOP
        RAISE NOTICE 'Group % (%): % members, % processed invitations',
            rec.group_name, rec.group_id, rec.member_count, rec.processed_invitation_count;
    END LOOP;
END $$;

-- Fix: Ensure all processed invitations have corresponding group members
INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
SELECT DISTINCT
    pgi.group_id,
    pgi.invitee_id,
    'member',
    COALESCE(pgi.processed_at, gi.responded_at, CURRENT_TIMESTAMP)
FROM pending_group_invitations pgi
LEFT JOIN group_invitations gi ON
    gi.group_id = pgi.group_id AND
    gi.invitee_id = pgi.invitee_id
WHERE pgi.status = 'processed'
AND NOT EXISTS (
    SELECT 1 FROM collaboration_group_members cgm
    WHERE cgm.group_id = pgi.group_id
    AND cgm.user_id = pgi.invitee_id
)
ON CONFLICT (group_id, user_id) DO NOTHING;

-- Also add members for any accepted group invitations
INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
SELECT DISTINCT
    gi.group_id,
    gi.invitee_id,
    'member',
    COALESCE(gi.responded_at, CURRENT_TIMESTAMP)
FROM group_invitations gi
WHERE gi.status = 'accepted'
AND NOT EXISTS (
    SELECT 1 FROM collaboration_group_members cgm
    WHERE cgm.group_id = gi.group_id
    AND cgm.user_id = gi.invitee_id
)
ON CONFLICT (group_id, user_id) DO NOTHING;

-- Count how many members were added
DO $$
DECLARE
    added_count INTEGER;
BEGIN
    GET DIAGNOSTICS added_count = ROW_COUNT;
    IF added_count > 0 THEN
        RAISE NOTICE 'Added % missing group members', added_count;
    ELSE
        RAISE NOTICE 'No missing group members found';
    END IF;
END $$;

-- Create a view to help debug group membership issues
CREATE OR REPLACE VIEW debug_group_membership AS
SELECT
    cg.id as group_id,
    cg.name as group_name,
    u.id as user_id,
    u.username,
    cgm.role as member_role,
    cgm.joined_at as member_joined_at,
    gi.status as invitation_status,
    gi.responded_at as invitation_responded_at,
    pgi.status as pending_invitation_status,
    pgi.processed_at as pending_processed_at,
    CASE
        WHEN cgm.user_id IS NOT NULL THEN 'IS_MEMBER'
        WHEN gi.status = 'accepted' THEN 'ACCEPTED_NOT_MEMBER'
        WHEN pgi.status = 'processed' THEN 'PROCESSED_NOT_MEMBER'
        ELSE 'OTHER'
    END as membership_status
FROM collaboration_groups cg
CROSS JOIN users u
LEFT JOIN collaboration_group_members cgm ON
    cgm.group_id = cg.id AND cgm.user_id = u.id
LEFT JOIN group_invitations gi ON
    gi.group_id = cg.id AND gi.invitee_id = u.id
LEFT JOIN pending_group_invitations pgi ON
    pgi.group_id = cg.id AND pgi.invitee_id = u.id
WHERE
    cgm.user_id IS NOT NULL  -- Is a member
    OR gi.id IS NOT NULL      -- Has an invitation
    OR pgi.id IS NOT NULL;    -- Has a pending invitation

COMMENT ON VIEW debug_group_membership IS 'Diagnostic view to troubleshoot group membership issues - created by migration 070';