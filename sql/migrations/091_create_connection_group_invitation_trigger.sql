-- Migration: Create trigger for automatic group invitation on connection request
-- This trigger creates a pending group invitation when a connection request is sent with group_invitation context

-- Create function to handle connection request with group invitation
CREATE OR REPLACE FUNCTION handle_connection_group_invitation()
RETURNS TRIGGER AS $$
DECLARE
    v_group_id UUID;
    v_group_name TEXT;
BEGIN
    -- Check if this is a group invitation context
    IF NEW.invitation_context = 'group_invitation' AND NEW.metadata ? 'group_id' THEN
        v_group_id := NEW.metadata->>'group_id';
        v_group_name := COALESCE(NEW.metadata->>'group_name', 'Unknown Group');

        -- Create pending group invitation
        INSERT INTO pending_group_invitations (
            group_id,
            inviter_id,
            invitee_id,
            message,
            connection_invitation_id,
            status,
            created_at
        ) VALUES (
            v_group_id,
            NEW.sender_id,
            NEW.recipient_id,
            COALESCE(NEW.message, 'Group invitation via connection'),
            NEW.id,
            'waiting',
            CURRENT_TIMESTAMP
        ) ON CONFLICT (connection_invitation_id)
        DO UPDATE SET
            group_id = EXCLUDED.group_id,
            inviter_id = EXCLUDED.inviter_id,
            invitee_id = EXCLUDED.invitee_id,
            message = EXCLUDED.message,
            status = EXCLUDED.status,
            updated_at = CURRENT_TIMESTAMP;

        RAISE NOTICE 'Created pending group invitation for connection % to group %', NEW.id, v_group_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trigger_handle_connection_group_invitation ON connection_invitations;

-- Create trigger
CREATE TRIGGER trigger_handle_connection_group_invitation
    AFTER INSERT OR UPDATE ON connection_invitations
    FOR EACH ROW
    WHEN (NEW.status = 'pending' AND NEW.invitation_context = 'group_invitation')
    EXECUTE FUNCTION handle_connection_group_invitation();

-- Add comment
COMMENT ON TRIGGER trigger_handle_connection_group_invitation ON connection_invitations
IS 'Automatically creates pending group invitations when connection requests are sent with group_invitation context';

-- Verify trigger creation
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trigger_handle_connection_group_invitation') THEN
        RAISE NOTICE 'Trigger trigger_handle_connection_group_invitation created successfully';
    ELSE
        RAISE EXCEPTION 'Failed to create trigger trigger_handle_connection_group_invitation';
    END IF;
END $$;