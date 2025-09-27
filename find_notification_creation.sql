-- Find where connection request notifications are created
SELECT
    'TRIGGER/FUNCTION' as source,
    routine_name,
    routine_definition
FROM information_schema.routines
WHERE routine_definition LIKE '%connection_request%';

-- Also check for any triggers on connection_invitations
SELECT
    'TRIGGER' as source,
    trigger_name,
    event_manipulation,
    event_object_table
FROM information_schema.triggers
WHERE event_object_table = 'connection_invitations';

-- Check the notification logs to see how they're currently created
SELECT
    n.notification_type,
    n.title,
    n.body,
    n.reference_type,
    n.reference_id,
    n.created_at
FROM notifications n
WHERE n.notification_type = 'connection_request'
ORDER BY n.created_at DESC LIMIT 5;