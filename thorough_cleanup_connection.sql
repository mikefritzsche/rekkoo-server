-- Thorough cleanup script for User B's connection
-- This will remove ALL traces of the connection between User A and User B
-- User A: 1bcd0366-498a-4d6e-82a6-e880e47c808f (mike@mikefritzsche.com)
-- User B: 0320693e-043b-4750-92b4-742e298a5f7f (demo1@mikefritzsche.com)
COMMIT;
BEGIN;

-- First, let's see what we're about to delete
SELECT '=== CURRENT STATE BEFORE CLEANUP ===' as info;

-- Check connection invitation
SELECT
    'CONNECTION INVITATION' as type,
    id,
    status,
    created_at
FROM connection_invitations
WHERE id = 'fff86061-e30a-49f0-8a18-212473cb0b9b';

-- Check connections (both directions)
SELECT
    'CONNECTIONS' as type,
    id,
    user_id,
    connection_id,
    status,
    created_at
FROM connections
WHERE (user_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f')
   OR (user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND connection_id = '0320693e-043b-4750-92b4-742e298a5f7f');

-- Check group invitation
SELECT
    'GROUP INVITATION' as type,
    id,
    status,
    group_id,
    created_at
FROM group_invitations
WHERE invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Check group membership
SELECT
    'GROUP MEMBERSHIP' as type,
    id,
    group_id,
    user_id,
    status,
    joined_at
FROM collaboration_group_members
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Check pending group invitation
SELECT
    'PENDING GROUP INVITATION' as type,
    id,
    status,
    processed_at
FROM pending_group_invitations
WHERE connection_invitation_id = 'fff86061-e30a-49f0-8a18-212473cb0b9b';

-- Check notifications
SELECT
    'NOTIFICATIONS' as type,
    id,
    notification_type,
    is_read,
    created_at
FROM notifications
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND (
    (notification_type = 'connection_request' AND reference_id = 'fff86061-e30a-49f0-8a18-212473cb0b9b')
    OR (notification_type = 'group_invitation' AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
    OR (notification_type = 'group_auto_added' AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
);

SELECT '=== DELETING ALL DATA ===' as info;

-- Delete all notifications for User B related to this connection/group
DELETE FROM notifications
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND (
    (notification_type = 'connection_request' AND reference_id = 'fff86061-e30a-49f0-8a18-212473cb0b9b')
    OR (notification_type = 'group_invitation' AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
    OR (notification_type = 'group_auto_added' AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
);

-- Delete group invitation if exists
DELETE FROM group_invitations
WHERE invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Delete group membership if exists
DELETE FROM collaboration_group_members
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Delete pending group invitation
DELETE FROM pending_group_invitations
WHERE connection_invitation_id = 'fff86061-e30a-49f0-8a18-212473cb0b9b';

-- Delete connections (both directions)
DELETE FROM connections
WHERE (user_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f')
   OR (user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND connection_id = '0320693e-043b-4750-92b4-742e298a5f7f');

-- Delete the connection invitation
DELETE FROM connection_invitations
WHERE id = 'fff86061-e30a-49f0-8a18-212473cb0b9b';

-- Verify cleanup
SELECT '=== VERIFICATION AFTER CLEANUP ===' as info;

SELECT
    'CONNECTION INVITATION' as type,
    COUNT(*) as remaining
FROM connection_invitations
WHERE id = 'fff86061-e30a-49f0-8a18-212473cb0b9b';

SELECT
    'CONNECTIONS' as type,
    COUNT(*) as remaining
FROM connections
WHERE (user_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f')
   OR (user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND connection_id = '0320693e-043b-4750-92b4-742e298a5f7f');

SELECT
    'NOTIFICATIONS' as type,
    COUNT(*) as remaining
FROM notifications
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND (
    (notification_type = 'connection_request' AND reference_id = 'fff86061-e30a-49f0-8a18-212473cb0b9b')
    OR (notification_type = 'group_invitation' AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
    OR (notification_type = 'group_auto_added' AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
);

COMMIT;

SELECT '=== CLEANUP COMPLETE ===' as info;