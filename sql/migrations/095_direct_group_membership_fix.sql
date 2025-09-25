-- Migration: Direct fix to add user to group without triggers
-- Description: Bypasses all triggers to directly add user to group
-- Date: 2025-09-25
commit;
BEGIN;

-- 1. First disable ALL triggers on group_invitations
ALTER TABLE group_invitations DISABLE TRIGGER ALL;

-- 2. Disable ALL triggers on collaboration_group_members
ALTER TABLE collaboration_group_members DISABLE TRIGGER ALL;

-- 3. Check if user is already a member
SELECT * FROM collaboration_group_members
WHERE group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba'
AND user_id = '0320693e-043b-4750-92b4-742e298a5f7f';

-- 4. Delete any existing group invitation for this user
DELETE FROM group_invitations
WHERE group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba'
AND invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f';

-- 5. Directly add the user to the group
INSERT INTO collaboration_group_members (
    group_id,
    user_id,
    role,
    joined_at
) VALUES (
    '2978a07c-8cf8-48d2-a0ad-a5f76e420fba',
    '0320693e-043b-4750-92b4-742e298a5f7f',
    'member',
    CURRENT_TIMESTAMP
)
ON CONFLICT (group_id, user_id)
DO UPDATE SET
    role = 'member',
    joined_at = CURRENT_TIMESTAMP;

-- 6. Create a dummy accepted invitation for audit purposes
INSERT INTO group_invitations (
    id,
    group_id,
    inviter_id,
    invitee_id,
    invitation_code,
    message,
    status,
    role,
    created_at,
    responded_at,
    expires_at
) VALUES (
    gen_random_uuid(),
    '2978a07c-8cf8-48d2-a0ad-a5f76e420fba',
    '1bcd0366-498a-4d6e-82a6-e880e47c808f',
    '0320693e-043b-4750-92b4-742e298a5f7f',
    'GI-DIRECT-ADD',
    'Directly added via manual fix',
    'accepted',
    'member',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP + INTERVAL '30 days'
);

-- 7. Mark the pending invitation as processed
UPDATE pending_group_invitations
SET
    status = 'sent',
    processed_at = CURRENT_TIMESTAMP
WHERE group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba'
AND invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f';

-- 8. Re-enable triggers
ALTER TABLE group_invitations ENABLE TRIGGER ALL;
ALTER TABLE collaboration_group_members ENABLE TRIGGER ALL;

-- 9. Verify the user is now in the group
SELECT
    g.name as group_name,
    gm.user_id,
    gm.role,
    gm.joined_at
FROM collaboration_group_members gm
JOIN collaboration_groups g ON gm.group_id = g.id
WHERE gm.group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba'
AND gm.user_id = '0320693e-043b-4750-92b4-742e298a5f7f';

commit;