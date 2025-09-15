-- Migration 066: Add notifications for connection invitations
-- This ensures users are notified when they receive connection requests

-- Create function to create notification for connection invitations
CREATE OR REPLACE FUNCTION create_connection_invitation_notification()
RETURNS TRIGGER AS $$
DECLARE
    v_sender_username TEXT;
    v_group_name TEXT;
    v_notification_body TEXT;
    v_notification_title TEXT;
BEGIN
    -- Only create notification for new pending invitations
    IF NEW.status = 'pending' THEN
        -- Get sender username
        SELECT username INTO v_sender_username
        FROM users
        WHERE id = NEW.sender_id;

        -- Build notification based on context
        IF NEW.invitation_context = 'group_invitation' AND NEW.metadata ? 'group_name' THEN
            -- Group-related connection invitation
            v_group_name := NEW.metadata->>'group_name';
            v_notification_title := 'New Connection Request';
            v_notification_body := v_sender_username || ' wants to connect with you to invite you to ' || v_group_name;
        ELSE
            -- Regular connection invitation
            v_notification_title := 'New Connection Request';
            v_notification_body := v_sender_username || ' wants to connect with you';

            -- Add message if present
            IF NEW.message IS NOT NULL AND NEW.message != '' THEN
                v_notification_body := v_notification_body || ': ' || NEW.message;
            END IF;
        END IF;

        -- Create notification
        INSERT INTO notifications (
            id,
            user_id,
            notification_type,
            title,
            body,
            reference_type,
            reference_id,
            created_at,
            is_read
        ) VALUES (
            gen_random_uuid(),
            NEW.recipient_id,
            'connection_request',
            v_notification_title,
            v_notification_body,
            'connection_invitation',
            NEW.id,
            CURRENT_TIMESTAMP,
            FALSE
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for connection invitations
DROP TRIGGER IF EXISTS trigger_create_connection_invitation_notification ON connection_invitations;
CREATE TRIGGER trigger_create_connection_invitation_notification
    AFTER INSERT ON connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION create_connection_invitation_notification();

-- Backfill notifications for existing pending connection invitations (last 7 days)
INSERT INTO notifications (
    id,
    user_id,
    notification_type,
    title,
    body,
    reference_type,
    reference_id,
    created_at,
    is_read
)
SELECT
    gen_random_uuid(),
    ci.recipient_id,
    'connection_request',
    'New Connection Request',
    CASE
        WHEN ci.invitation_context = 'group_invitation' AND ci.metadata ? 'group_name' THEN
            u.username || ' wants to connect with you to invite you to ' || (ci.metadata->>'group_name')
        WHEN ci.message IS NOT NULL AND ci.message != '' THEN
            u.username || ' wants to connect with you: ' || ci.message
        ELSE
            u.username || ' wants to connect with you'
    END,
    'connection_invitation',
    ci.id,
    ci.created_at,
    FALSE
FROM connection_invitations ci
JOIN users u ON u.id = ci.sender_id
WHERE ci.status = 'pending'
AND ci.created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.reference_type = 'connection_invitation'
    AND n.reference_id = ci.id
);

-- Add comment for documentation
COMMENT ON FUNCTION create_connection_invitation_notification IS 'Creates notifications when connection invitations are sent, including group context';
COMMENT ON TRIGGER trigger_create_connection_invitation_notification ON connection_invitations IS 'Automatically creates notifications for new connection invitations';