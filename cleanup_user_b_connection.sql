-- Cleanup script to remove User B's connection and related data
-- This will allow testing the auto-add flow again
-- User A: 1bcd0366-498a-4d6e-82a6-e880e47c808f (mike@mikefritzsche.com)
-- User B: 0320693e-043b-4750-92b4-742e298a5f7f (demo1@mikefritzsche.com)

-- Commit any open transaction from previous run
COMMIT;

-- First, let's see what we're about to delete
SELECT '=== CURRENT STATE ===' as info;

-- Check connection invitation
SELECT
    'CONNECTION INVITATION' as type,
    ci.id,
    ci.status,
    ci.created_at
FROM connection_invitations ci
WHERE ci.id IN ('fff86061-e30a-49f0-8a18-212473cb0b9b', 'a4aed27d-48cb-467a-8bd0-53d332d855a6');

-- Check connections
SELECT
    'CONNECTIONS' as type,
    c.user_id,
    c.connection_id,
    c.status,
    c.created_at
FROM connections c
WHERE (c.user_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND c.connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f')
   OR (c.user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND c.connection_id = '0320693e-043b-4750-92b4-742e298a5f7f');

-- Check group invitation
SELECT
    'GROUP INVITATION' as type,
    gi.id,
    gi.status,
    gi.created_at
FROM group_invitations gi
WHERE gi.invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND gi.group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Check notifications
SELECT
    'NOTIFICATIONS' as type,
    n.id,
    n.notification_type,
    n.is_read,
    n.created_at
FROM notifications n
WHERE n.user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND (
    (n.notification_type = 'connection_request' AND n.reference_id = 'fff86061-e30a-49f0-8a18-212473cb0b9b')
    OR (n.notification_type IN ('group_invitation', 'group_auto_added') AND n.reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
);

SELECT '=== DELETING DATA ===' as info;

-- BEGIN TRANSACTION (already executed from previous run)
BEGIN;

-- Delete notifications first (due to foreign key constraints)
DELETE FROM notifications
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND (
    (notification_type = 'connection_request' AND reference_id IN ('fff86061-e30a-49f0-8a18-212473cb0b9b', 'a4aed27d-48cb-467a-8bd0-53d332d855a6'))
    OR (notification_type IN ('group_invitation', 'group_auto_added') AND reference_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba')
);

-- Delete group invitation
DELETE FROM group_invitations
WHERE invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Delete pending group invitation (already processed, but just in case)
DELETE FROM pending_group_invitations
WHERE connection_invitation_id IN ('fff86061-e30a-49f0-8a18-212473cb0b9b', 'a4aed27d-48cb-467a-8bd0-53d332d855a6');

-- Delete group membership if User B was added
DELETE FROM collaboration_group_members
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Delete connections (both directions)
DELETE FROM connections
WHERE (user_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f')
   OR (user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND connection_id = '0320693e-043b-4750-92b4-742e298a5f7f');

-- Delete the connection invitation
DELETE FROM connection_invitations
WHERE id IN ('fff86061-e30a-49f0-8a18-212473cb0b9b', 'a4aed27d-48cb-467a-8bd0-53d332d855a6');

-- ROLLBACK TRANSACTION (uncomment to undo)
-- ROLLBACK;

-- COMMIT TRANSACTION (uncomment to save changes)
COMMIT;

SELECT '=== CLEANUP COMPLETE ===' as info;