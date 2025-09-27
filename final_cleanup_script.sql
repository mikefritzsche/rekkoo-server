-- Final comprehensive cleanup script
-- Removes ALL connection data between User A and User B
-- User A: 1bcd0366-498a-4d6e-82a6-e880e47c808f
-- User B: 0320693e-043b-4750-92b4-742e298a5f7f

COMMIT;
BEGIN;

-- Show what we're about to delete
SELECT '=== DELETING THE FOLLOWING RECORDS ===' as info;

-- Delete all notifications for User B related to this connection/group
DELETE FROM notifications
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND (
    notification_type = 'connection_request'
    OR notification_type IN ('group_invitation', 'group_auto_added')
);

-- Delete group invitation if exists
DELETE FROM group_invitations
WHERE invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Delete pending group invitation
DELETE FROM pending_group_invitations
WHERE id = '4cb46549-62ac-4360-baf8-359cb19f35e6';

-- Delete group membership if exists
DELETE FROM collaboration_group_members
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba';

-- Delete connections (both directions)
DELETE FROM connections
WHERE (user_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND connection_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f')
   OR (user_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND connection_id = '0320693e-043b-4750-92b4-742e298a5f7f');

-- Delete the connection invitation
DELETE FROM connection_invitations
WHERE id = '1efcc6f2-9b28-4026-8f34-e79286f307be';

-- Verify everything is deleted
SELECT '=== VERIFICATION ===' as info;

SELECT 'CONNECTION INVITATIONS' as table_name, COUNT(*) as remaining
FROM connection_invitations
WHERE (sender_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f' AND recipient_id = '0320693e-043b-4750-92b4-742e298a5f7f')
   OR (sender_id = '0320693e-043b-4750-92b4-742e298a5f7f' AND recipient_id = '1bcd0366-498a-4d6e-82a6-e880e47c808f');

SELECT 'NOTIFICATIONS' as table_name, COUNT(*) as remaining
FROM notifications
WHERE user_id = '0320693e-043b-4750-92b4-742e298a5f7f'
AND notification_type IN ('connection_request', 'group_invitation', 'group_auto_added');

SELECT 'PENDING GROUP INVITATIONS' as table_name, COUNT(*) as remaining
FROM pending_group_invitations
WHERE id = '4cb46549-62ac-4360-baf8-359cb19f35e6';

COMMIT;

SELECT '=== CLEANUP COMPLETE ===' as info;