-- Comprehensive fix for all group invitation triggers and functions
-- This migration cleans up conflicting triggers and ensures proper invitation_code generation

-- First, drop all conflicting triggers
DROP TRIGGER IF EXISTS trigger_process_pending_group_invitations ON connections CASCADE;
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations CASCADE;
DROP TRIGGER IF EXISTS process_pending_group_invitations_on_connection ON connection_invitations CASCADE;

-- Drop old/conflicting functions
DROP FUNCTION IF EXISTS process_pending_group_invitations() CASCADE;
DROP FUNCTION IF EXISTS process_pending_group_invitations_on_connection() CASCADE;

-- Create the correct function that handles connection acceptance and group invitations
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_is_member BOOLEAN;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- First, create bidirectional connection records with accepted status
        INSERT INTO connections (id, user_id, connection_id, status, initiated_by, created_at, accepted_at)
        VALUES
            (gen_random_uuid(), NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (gen_random_uuid(), NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, connection_id)
        DO UPDATE SET
            status = 'accepted',
            accepted_at = CURRENT_TIMESTAMP;

        -- Process any pending group invitations associated with this connection
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE connection_invitation_id = NEW.id
              AND (status IS NULL OR status = 'pending' OR status = 'waiting')
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Check if invitation already exists
                IF NOT EXISTS (
                    SELECT 1 FROM group_invitations
                    WHERE group_id = pending_invite.group_id
                    AND invitee_id = pending_invite.invitee_id
                    AND status = 'pending'
                ) THEN
                    -- Create group invitation with proper invitation_code
                    INSERT INTO group_invitations (
                        id,
                        group_id,
                        inviter_id,
                        invitee_id,
                        invitation_code,
                        message,
                        status,
                        created_at,
                        expires_at
                    ) VALUES (
                        gen_random_uuid(),
                        pending_invite.group_id,
                        pending_invite.inviter_id,
                        pending_invite.invitee_id,
                        LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', ''))),
                        pending_invite.message,
                        'pending',
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP + INTERVAL '30 days'
                    );
                END IF;
            END IF;

            -- Update the pending invitation to processed
            UPDATE pending_group_invitations
            SET status = 'processed',
                processed_at = CURRENT_TIMESTAMP
            WHERE id = pending_invite.id;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update the check function to properly handle the connection acceptance flow
CREATE OR REPLACE FUNCTION public.check_connection_before_group_invite()
RETURNS TRIGGER AS $$
DECLARE
    are_connected BOOLEAN;
BEGIN
    -- Allow group invitations that are being created as part of connection acceptance
    -- Check if there's a recently processed pending invitation
    IF EXISTS (
        SELECT 1 FROM pending_group_invitations
        WHERE group_id = NEW.group_id
        AND invitee_id = NEW.invitee_id
        AND status = 'processed'
        AND processed_at >= CURRENT_TIMESTAMP - INTERVAL '5 seconds'
    ) THEN
        RETURN NEW;
    END IF;

    -- Normal check: verify users are connected
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE ((user_id = NEW.inviter_id AND connection_id = NEW.invitee_id)
            OR (user_id = NEW.invitee_id AND connection_id = NEW.inviter_id))
        AND status = 'accepted'
    ) INTO are_connected;

    IF NOT are_connected THEN
        RAISE EXCEPTION 'Cannot invite user to group: users must be connected first';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the single correct trigger on connection_invitations
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION process_connection_acceptance();

-- Ensure pending_group_invitations has proper status column if missing
DO $$
BEGIN
    -- Add status column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'pending_group_invitations'
        AND column_name = 'status'
    ) THEN
        ALTER TABLE pending_group_invitations
        ADD COLUMN status VARCHAR(20) DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'processed', 'cancelled', 'expired'));
    END IF;

    -- Add processed_at column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'pending_group_invitations'
        AND column_name = 'processed_at'
    ) THEN
        ALTER TABLE pending_group_invitations
        ADD COLUMN processed_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- Comment for documentation
COMMENT ON FUNCTION process_connection_acceptance IS 'Fixed in migration 067 to properly handle invitation_code and clean up conflicting triggers';
COMMENT ON FUNCTION check_connection_before_group_invite IS 'Fixed in migration 067 to allow invitations from connection acceptance flow';