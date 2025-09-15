-- Auto-accept group invitations when they are created from connection acceptance flow
-- This completes the waterfall process: connection request + group invite -> connection accepted -> group joined

-- Drop the existing function if it exists
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

-- Create the updated process_connection_acceptance function
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_is_member BOOLEAN;
    v_group_invitation_id UUID;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- First, create bidirectional connection records with accepted status
        INSERT INTO connections (user_id, connection_id, status, initiated_by, created_at, accepted_at)
        VALUES
            (NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, connection_id)
        DO UPDATE SET
            status = 'accepted',
            accepted_at = CURRENT_TIMESTAMP;

        -- Process any pending group invitations associated with this connection
        FOR pending_invite IN
            SELECT pgi.id, pgi.group_id, pgi.inviter_id, pgi.invitee_id, pgi.message
            FROM pending_group_invitations pgi
            WHERE pgi.connection_invitation_id = NEW.id
              AND (pgi.status IS NULL OR pgi.status = 'pending' OR pgi.status = 'waiting')
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Create group invitation in ACCEPTED status (auto-accept)
                -- Using explicit column selection to avoid issues
                v_group_invitation_id := gen_random_uuid();

                INSERT INTO group_invitations (
                    id,
                    group_id,
                    inviter_id,
                    invitee_id,
                    invitation_code,
                    message,
                    status,
                    created_at,
                    responded_at,
                    expires_at
                ) VALUES (
                    v_group_invitation_id,
                    pending_invite.group_id,
                    pending_invite.inviter_id,
                    pending_invite.invitee_id,
                    LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', ''))),
                    COALESCE(pending_invite.message, 'Automatically accepted via connection request'),
                    'accepted',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                ) ON CONFLICT (group_id, invitee_id)
                DO UPDATE SET
                    status = 'accepted',
                    responded_at = CURRENT_TIMESTAMP
                WHERE group_invitations.status = 'pending';

                -- Immediately add the user to the group
                INSERT INTO collaboration_group_members (
                    group_id,
                    user_id,
                    role,
                    joined_at
                ) VALUES (
                    pending_invite.group_id,
                    pending_invite.invitee_id,
                    'member',
                    CURRENT_TIMESTAMP
                ) ON CONFLICT (group_id, user_id) DO NOTHING;
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

-- Drop existing accept_group_invitation functions (there might be multiple signatures)
DROP FUNCTION IF EXISTS public.accept_group_invitation() CASCADE;
DROP FUNCTION IF EXISTS public.accept_group_invitation(UUID, UUID) CASCADE;

-- Ensure the accept_group_invitation trigger function exists and works properly
CREATE OR REPLACE FUNCTION public.accept_group_invitation()
RETURNS TRIGGER AS $$
BEGIN
    -- Only process when status changes to 'accepted'
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Add user to group members if not already a member
        INSERT INTO collaboration_group_members (
            group_id,
            user_id,
            role,
            joined_at
        ) VALUES (
            NEW.group_id,
            NEW.invitee_id,
            'member',
            CURRENT_TIMESTAMP
        ) ON CONFLICT (group_id, user_id) DO NOTHING;

        -- Set responded_at if not already set
        IF NEW.responded_at IS NULL THEN
            NEW.responded_at = CURRENT_TIMESTAMP;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger on connection_invitations
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION process_connection_acceptance();

-- Ensure the trigger exists for manual acceptance
DROP TRIGGER IF EXISTS process_group_invitation_acceptance ON public.group_invitations;
CREATE TRIGGER process_group_invitation_acceptance
    BEFORE UPDATE ON public.group_invitations
    FOR EACH ROW
    EXECUTE FUNCTION public.accept_group_invitation();

-- Comment for documentation
COMMENT ON FUNCTION process_connection_acceptance IS 'Fixed in migration 068 to auto-accept group invitations when created from connection acceptance flow';
COMMENT ON FUNCTION accept_group_invitation IS 'Fixed in migration 068 to properly handle group member addition';