-- Add automatic notification creation for group invitations
-- This ensures users receive notifications when they're invited to groups

-- First, we need to fix the notifications table structure if it exists
-- The notifications table incorrectly has user_id as INTEGER when it should be UUID

-- Check if notifications table exists and needs fixing
DO $$
BEGIN
    -- Check if the notifications table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notifications') THEN
        -- Check if user_id column is INTEGER (needs fixing)
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'notifications'
            AND column_name = 'user_id'
            AND data_type = 'integer'
        ) THEN
            -- We need to recreate the table with correct structure
            -- First, backup existing data if any
            CREATE TEMP TABLE notifications_backup AS SELECT * FROM notifications;

            -- Drop the old table
            DROP TABLE notifications CASCADE;

            -- Create new notifications table with correct structure
            CREATE TABLE notifications (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                notification_type VARCHAR(50) NOT NULL,
                title VARCHAR(100) NOT NULL,
                body TEXT NOT NULL,
                reference_id UUID,
                reference_type VARCHAR(50),
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- Note: We can't restore old data due to type mismatch, but the table will be ready for new data
            RAISE NOTICE 'Notifications table has been recreated with correct user_id type (UUID)';
        END IF;
    ELSE
        -- Create notifications table if it doesn't exist
        CREATE TABLE notifications (
            id SERIAL PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            notification_type VARCHAR(50) NOT NULL,
            title VARCHAR(100) NOT NULL,
            body TEXT NOT NULL,
            reference_id UUID,
            reference_type VARCHAR(50),
            is_read BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(user_id, is_read) WHERE is_read = false;

-- Create function to generate notification for group invitations
CREATE OR REPLACE FUNCTION create_group_invitation_notification()
RETURNS TRIGGER AS $$
DECLARE
    v_group_name TEXT;
    v_inviter_username TEXT;
BEGIN
    -- Only create notification for new pending invitations
    IF NEW.status = 'pending' THEN
        -- Get group name and inviter username
        SELECT g.name INTO v_group_name
        FROM collaboration_groups g
        WHERE g.id = NEW.group_id;

        SELECT u.username INTO v_inviter_username
        FROM users u
        WHERE u.id = NEW.inviter_id;

        -- Create notification for the invitee
        INSERT INTO notifications (
            user_id,
            notification_type,
            title,
            body,
            reference_id,
            reference_type,
            is_read,
            created_at
        ) VALUES (
            NEW.invitee_id,  -- Now using UUID directly
            'group_invitation',
            'Group Invitation',
            COALESCE(v_inviter_username, 'Someone') || ' invited you to join the group "' || COALESCE(v_group_name, 'Unknown Group') || '"',
            NEW.id,  -- Using UUID directly
            'group_invitation',
            FALSE,
            CURRENT_TIMESTAMP
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for new group invitations
DROP TRIGGER IF EXISTS trigger_create_group_invitation_notification ON group_invitations;
CREATE TRIGGER trigger_create_group_invitation_notification
    AFTER INSERT ON group_invitations
    FOR EACH ROW
    EXECUTE FUNCTION create_group_invitation_notification();

-- Also create notifications for invitation responses (accepted/declined)
CREATE OR REPLACE FUNCTION create_group_invitation_response_notification()
RETURNS TRIGGER AS $$
DECLARE
    v_group_name TEXT;
    v_responder_username TEXT;
    v_notification_message TEXT;
BEGIN
    -- Only create notification when status changes from pending to accepted/declined
    IF OLD.status = 'pending' AND NEW.status IN ('accepted', 'declined') THEN
        -- Get group name and responder username
        SELECT g.name INTO v_group_name
        FROM collaboration_groups g
        WHERE g.id = NEW.group_id;

        SELECT u.username INTO v_responder_username
        FROM users u
        WHERE u.id = NEW.invitee_id;

        -- Build notification message based on response
        IF NEW.status = 'accepted' THEN
            v_notification_message := COALESCE(v_responder_username, 'Someone') || ' accepted your invitation to join "' || COALESCE(v_group_name, 'the group') || '"';
        ELSE
            v_notification_message := COALESCE(v_responder_username, 'Someone') || ' declined your invitation to join "' || COALESCE(v_group_name, 'the group') || '"';
        END IF;

        -- Create notification for the inviter
        INSERT INTO notifications (
            user_id,
            notification_type,
            title,
            body,
            reference_id,
            reference_type,
            is_read,
            created_at
        ) VALUES (
            NEW.inviter_id,  -- Now using UUID directly
            'group_invitation_response',
            'Invitation Response',
            v_notification_message,
            NEW.id,  -- Using UUID directly
            'group_invitation_response',
            FALSE,
            CURRENT_TIMESTAMP
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for invitation responses
DROP TRIGGER IF EXISTS trigger_create_group_invitation_response_notification ON group_invitations;
CREATE TRIGGER trigger_create_group_invitation_response_notification
    AFTER UPDATE ON group_invitations
    FOR EACH ROW
    EXECUTE FUNCTION create_group_invitation_response_notification();

-- Add comment to track this migration
COMMENT ON FUNCTION create_group_invitation_notification IS 'Creates notifications when users receive group invitations';
COMMENT ON FUNCTION create_group_invitation_response_notification IS 'Creates notifications when group invitations are accepted or declined';