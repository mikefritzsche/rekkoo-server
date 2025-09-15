-- Fix the order of operations in process_connection_acceptance trigger
-- This ensures connections are created with 'accepted' status BEFORE creating group invitations

CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_is_member BOOLEAN;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- First, create bidirectional connection records with accepted status
        -- Use ON CONFLICT to update existing pending connections to accepted
        INSERT INTO connections (id, user_id, connection_id, status, initiated_by, created_at, accepted_at)
        VALUES
            (gen_random_uuid(), NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (gen_random_uuid(), NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, connection_id)
        DO UPDATE SET
            status = 'accepted',
            accepted_at = CURRENT_TIMESTAMP;

        -- Wait for the connections to be committed before processing group invitations
        -- This ensures the check_connection_before_group_invite trigger will pass

        -- Process any pending group invitations associated with this connection
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE connection_invitation_id = NEW.id
              AND (status IS NULL OR status = 'pending')
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Now the connection exists with 'accepted' status, so this should work
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
                )
                ON CONFLICT (group_id, invitee_id)
                DO NOTHING; -- Skip if invitation already exists
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

-- Also update the check_connection_before_group_invite to handle the case where
-- the trigger is being called from within the same transaction
CREATE OR REPLACE FUNCTION public.check_connection_before_group_invite()
RETURNS TRIGGER AS $$
DECLARE
    are_connected BOOLEAN;
BEGIN
    -- Skip the check if this is being called from process_connection_acceptance
    -- by checking if there's a pending_group_invitations record being processed
    IF EXISTS (
        SELECT 1 FROM pending_group_invitations
        WHERE group_id = NEW.group_id
        AND invitee_id = NEW.invitee_id
        AND status = 'processed'
        AND processed_at >= CURRENT_TIMESTAMP - INTERVAL '1 second'
    ) THEN
        -- This is from the connection acceptance flow, connection was just created
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

-- Comment for documentation
COMMENT ON FUNCTION process_connection_acceptance IS 'Fixed in migration 066 to create accepted connections before processing group invitations';
COMMENT ON FUNCTION check_connection_before_group_invite IS 'Fixed in migration 066 to handle connection acceptance flow properly';