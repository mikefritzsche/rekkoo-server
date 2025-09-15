-- Fix the invite_user_to_group_cascade function to properly use connection_invitations table
-- This ensures recipients can see connection requests in their notifications

CREATE OR REPLACE FUNCTION invite_user_to_group_cascade(
    p_group_id UUID,
    p_inviter_id UUID,
    p_invitee_id UUID,
    p_message TEXT DEFAULT NULL
) RETURNS TABLE(
    success BOOLEAN,
    message TEXT,
    invitation_type TEXT,
    invitation_id UUID
) AS $$
DECLARE
    v_is_connected BOOLEAN;
    v_pending_connection BOOLEAN;
    v_existing_invitation UUID;
    v_invitation_id UUID;
    v_is_member BOOLEAN;
    v_connection_invitation_id UUID;
BEGIN
    -- Check if users are connected (accepted connection)
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'accepted'
        AND (
            (user_id = p_inviter_id AND connection_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connection_id = p_inviter_id)
        )
    ) INTO v_is_connected;

    -- Check for pending connection invitation
    SELECT EXISTS(
        SELECT 1 FROM connection_invitations
        WHERE status = 'pending'
        AND (
            (sender_id = p_inviter_id AND recipient_id = p_invitee_id)
            OR (sender_id = p_invitee_id AND recipient_id = p_inviter_id)
        )
    ) INTO v_pending_connection;

    -- If users are connected, send group invitation directly
    IF v_is_connected THEN
        -- Check if already invited
        SELECT id INTO v_existing_invitation
        FROM group_invitations
        WHERE group_id = p_group_id
        AND invitee_id = p_invitee_id
        AND status = 'pending';

        IF v_existing_invitation IS NOT NULL THEN
            RETURN QUERY SELECT
                FALSE,
                'User has already been invited to this group',
                'group_invitation'::TEXT,
                v_existing_invitation;
            RETURN;
        END IF;

        -- Check if already a member
        SELECT EXISTS(
            SELECT 1 FROM collaboration_group_members
            WHERE group_id = p_group_id
            AND user_id = p_invitee_id
        ) INTO v_is_member;

        IF v_is_member THEN
            RETURN QUERY SELECT
                FALSE,
                'User is already a member of this group',
                NULL::TEXT,
                NULL::UUID;
            RETURN;
        END IF;

        -- Create group invitation
        INSERT INTO group_invitations (
            id,
            group_id,
            inviter_id,
            invitee_id,
            message,
            status,
            created_at,
            expires_at
        ) VALUES (
            gen_random_uuid(),
            p_group_id,
            p_inviter_id,
            p_invitee_id,
            p_message,
            'pending',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP + INTERVAL '30 days'
        ) RETURNING id INTO v_invitation_id;

        RETURN QUERY SELECT
            TRUE,
            'Group invitation sent successfully',
            'group_invitation'::TEXT,
            v_invitation_id;
    ELSE
        -- Users are not connected
        IF v_pending_connection THEN
            -- There's already a pending connection invitation
            -- Get the existing connection invitation ID
            SELECT id INTO v_connection_invitation_id
            FROM connection_invitations
            WHERE status = 'pending'
            AND sender_id = p_inviter_id
            AND recipient_id = p_invitee_id;

            -- Store the pending group invitation with reference to connection invitation
            INSERT INTO pending_group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                created_at,
                connection_invitation_id
            ) VALUES (
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                CURRENT_TIMESTAMP,
                v_connection_invitation_id
            )
            ON CONFLICT (group_id, invitee_id) DO UPDATE
            SET message = EXCLUDED.message,
                created_at = EXCLUDED.created_at,
                connection_invitation_id = EXCLUDED.connection_invitation_id;

            RETURN QUERY SELECT
                TRUE,
                'Connection request already pending. Group invitation will be sent once connected',
                'pending_connection'::TEXT,
                v_connection_invitation_id;
        ELSE
            -- Send connection invitation first (not connection record)
            INSERT INTO connection_invitations (
                id,
                sender_id,
                recipient_id,
                message,
                status,
                invitation_context,
                metadata,
                created_at,
                expires_at
            ) VALUES (
                gen_random_uuid(),
                p_inviter_id,
                p_invitee_id,
                COALESCE(p_message, 'I would like to invite you to join a group'),
                'pending',
                'group_invitation',
                jsonb_build_object(
                    'group_id', p_group_id,
                    'group_name', (SELECT name FROM collaboration_groups WHERE id = p_group_id)
                ),
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP + INTERVAL '30 days'
            ) RETURNING id INTO v_connection_invitation_id;

            -- Store the pending group invitation with reference to connection invitation
            INSERT INTO pending_group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                created_at,
                connection_invitation_id
            ) VALUES (
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                CURRENT_TIMESTAMP,
                v_connection_invitation_id
            )
            ON CONFLICT (group_id, invitee_id) DO UPDATE
            SET message = EXCLUDED.message,
                created_at = EXCLUDED.created_at,
                connection_invitation_id = v_connection_invitation_id;

            RETURN QUERY SELECT
                TRUE,
                'Connection request sent. User will be invited to the group once they accept',
                'connection_request'::TEXT,
                v_connection_invitation_id;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Also need to update the trigger that processes pending group invitations when connection is accepted
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_is_member BOOLEAN;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Create bidirectional connection records
        INSERT INTO connections (id, user_id, connection_id, status, initiated_by, created_at)
        VALUES
            (gen_random_uuid(), NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP),
            (gen_random_uuid(), NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP)
        ON CONFLICT DO NOTHING;

        -- Process any pending group invitations associated with this connection
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE connection_invitation_id = NEW.id
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Create the group invitation
                INSERT INTO group_invitations (
                    id,
                    group_id,
                    inviter_id,
                    invitee_id,
                    message,
                    status,
                    created_at,
                    expires_at
                ) VALUES (
                    gen_random_uuid(),
                    pending_invite.group_id,
                    pending_invite.inviter_id,
                    pending_invite.invitee_id,
                    pending_invite.message,
                    'pending',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                );
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

-- Create trigger on connection_invitations table
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION process_connection_acceptance();

-- Comment for documentation
COMMENT ON FUNCTION invite_user_to_group_cascade IS 'Fixed in migration 065 to properly use connection_invitations table instead of connections table';
COMMENT ON FUNCTION process_connection_acceptance IS 'Processes pending group invitations when a connection invitation is accepted';