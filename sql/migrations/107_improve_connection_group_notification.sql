-- Migration: Improve connection invitation notification for group context
-- Description: Makes it clear that accepting a connection with group context will add user to group
-- Date: 2025-09-26
commit;
BEGIN;

-- Update the notification creation function to be clearer about auto-add
DROP FUNCTION IF EXISTS create_connection_invitation_notification() CASCADE;

CREATE OR REPLACE FUNCTION create_connection_invitation_notification()
RETURNS TRIGGER AS $$
DECLARE
    v_sender_username TEXT;
    v_sender_fullname TEXT;
    v_group_name TEXT;
    v_notification_body TEXT;
    v_notification_title TEXT;
    v_will_auto_add BOOLEAN;
BEGIN
    -- Only create notification for new pending invitations
    IF NEW.status = 'pending' THEN
        -- Get sender info
        SELECT username, COALESCE(full_name, '') INTO v_sender_username, v_sender_fullname
        FROM users
        WHERE id = NEW.sender_id;

        -- Build notification based on context
        IF NEW.invitation_context = 'group_invitation' AND NEW.metadata ? 'group_name' THEN
            -- Group-related connection invitation
            v_group_name := NEW.metadata->>'group_name';

            -- Check if user will be auto-added to group
            v_will_auto_add := user_allows_automatic_group_additions(NEW.recipient_id);

            IF v_will_auto_add THEN
                -- User has auto-add enabled - they'll be added automatically
                v_notification_title := 'Connection & Group Invitation';
                v_notification_body := (CASE
                    WHEN v_sender_fullname != '' THEN v_sender_fullname || ' (@' || v_sender_username || ')'
                    ELSE v_sender_username
                END) || ' wants to connect and add you to "' || v_group_name || '". Accept to automatically join the group.';
            ELSE
                -- User doesn't have auto-add - they'll get a separate invitation
                v_notification_title := 'Connection & Group Invitation';
                v_notification_body := (CASE
                    WHEN v_sender_fullname != '' THEN v_sender_fullname || ' (@' || v_sender_username || ')'
                    ELSE v_sender_username
                END) || ' wants to connect and invite you to "' || v_group_name || '". Accept the connection to receive the group invitation.';
            END IF;
        ELSE
            -- Regular connection invitation
            v_notification_title := 'New Connection Request';
            v_notification_body := (CASE
                WHEN v_sender_fullname != '' THEN v_sender_fullname || ' (@' || v_sender_username || ')'
                ELSE v_sender_username
            END) || ' wants to connect with you';

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

-- Add comment explaining the improvement
COMMENT ON FUNCTION create_connection_invitation_notification() IS
'Creates notifications for connection invitations. For group invitations, clearly indicates whether user will be auto-added or receive separate invitation.';

COMMIT;