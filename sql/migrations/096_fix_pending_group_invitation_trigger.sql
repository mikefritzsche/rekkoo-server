-- Migration: Fix the handle_connection_group_invitation trigger function
-- Description: Removes the ON CONFLICT clause that tries to update non-existent updated_at column
-- Date: 2025-09-25
commit;
BEGIN;

-- Drop the old trigger and function completely
DROP TRIGGER IF EXISTS trigger_handle_connection_group_invitation ON connection_invitations;
DROP FUNCTION IF EXISTS handle_connection_group_invitation() CASCADE;

-- Create the corrected trigger function without ON CONFLICT
CREATE OR REPLACE FUNCTION handle_connection_group_invitation()
RETURNS TRIGGER AS $$
DECLARE
    v_group_id UUID;
    v_group_name TEXT;
    v_pending_exists BOOLEAN;
BEGIN
    -- Check if this is a group invitation context
    IF NEW.invitation_context = 'group_invitation' AND
       (NEW.metadata->>'group_id') IS NOT NULL THEN
        v_group_id := NEW.metadata->>'group_id';
        v_group_name := COALESCE(NEW.metadata->>'group_name', 'Unknown Group');

        -- Check if a pending invitation already exists
        SELECT EXISTS(
            SELECT 1 FROM pending_group_invitations
            WHERE group_id = v_group_id
            AND invitee_id = NEW.recipient_id
            AND status = 'waiting'
        ) INTO v_pending_exists;

        -- Only create if doesn't exist
        IF NOT v_pending_exists THEN
            -- Create pending group invitation
            INSERT INTO pending_group_invitations (
                id,
                group_id,
                inviter_id,
                invitee_id,
                message,
                connection_invitation_id,
                status,
                created_at
            ) VALUES (
                gen_random_uuid(),
                v_group_id,
                NEW.sender_id,
                NEW.recipient_id,
                COALESCE(NEW.message, 'Group invitation via connection'),
                NEW.id,
                'waiting',
                CURRENT_TIMESTAMP
            );

            RAISE NOTICE 'Created pending group invitation for connection % to group %', NEW.id, v_group_id;
        ELSE
            RAISE NOTICE 'Pending group invitation already exists for group % and user %', v_group_id, NEW.recipient_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
CREATE TRIGGER trigger_handle_connection_group_invitation
    AFTER INSERT OR UPDATE ON connection_invitations
    FOR EACH ROW
    WHEN (NEW.status = 'pending' AND NEW.invitation_context = 'group_invitation')
    EXECUTE FUNCTION handle_connection_group_invitation();

COMMIT;