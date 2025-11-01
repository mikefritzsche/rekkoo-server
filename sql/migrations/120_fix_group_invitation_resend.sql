-- Fix re-sending group invitations when a previous invite exists
-- Ensures invite_user_to_group_cascade reuses existing invitation records

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
    v_invitation_id UUID;
    v_is_member BOOLEAN;
    v_connection_invitation_id UUID;
    v_invitation_code TEXT;
    v_existing_invitation_id UUID;
    v_existing_invitation_status group_invitations.status%TYPE;
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

        -- Fetch any existing invitation regardless of status
        SELECT id, status INTO v_existing_invitation_id, v_existing_invitation_status
        FROM group_invitations
        WHERE group_id = p_group_id
        AND invitee_id = p_invitee_id;

        IF v_existing_invitation_id IS NOT NULL AND v_existing_invitation_status = 'pending' THEN
            RETURN QUERY SELECT
                FALSE,
                'User has already been invited to this group',
                'group_invitation'::TEXT,
                v_existing_invitation_id;
            RETURN;
        END IF;

        -- Generate a unique invitation code to satisfy NOT NULL constraint
        LOOP
            v_invitation_code := LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', '')));
            EXIT WHEN NOT EXISTS (
                SELECT 1
                FROM group_invitations
                WHERE invitation_code = v_invitation_code
            );
        END LOOP;

        IF v_existing_invitation_id IS NOT NULL THEN
            -- Reuse the existing invitation record to satisfy unique constraint
            UPDATE group_invitations
            SET
                inviter_id = p_inviter_id,
                invitee_id = p_invitee_id,
                message = p_message,
                status = 'pending',
                invitation_code = v_invitation_code,
                created_at = CURRENT_TIMESTAMP,
                responded_at = NULL,
                expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days',
                last_synced_at = CURRENT_TIMESTAMP,
                client_modified_at = CURRENT_TIMESTAMP,
                sync_version = sync_version + 1
            WHERE id = v_existing_invitation_id
            RETURNING id INTO v_invitation_id;

            RETURN QUERY SELECT
                TRUE,
                'Group invitation re-sent successfully',
                'group_invitation'::TEXT,
                v_invitation_id;
        ELSE
            -- Create group invitation with explicit invitation_code
            INSERT INTO group_invitations (
                id,
                group_id,
                inviter_id,
                invitee_id,
                message,
                status,
                invitation_code,
                created_at,
                expires_at
            ) VALUES (
                gen_random_uuid(),
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                'pending',
                v_invitation_code,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP + INTERVAL '30 days'
            ) RETURNING id INTO v_invitation_id;

            RETURN QUERY SELECT
                TRUE,
                'Group invitation sent successfully',
                'group_invitation'::TEXT,
                v_invitation_id;
        END IF;
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
            );

            RETURN QUERY SELECT
                TRUE,
                'Connection request already pending. The group invitation will be sent after the connection is accepted.',
                'pending_connection'::TEXT,
                v_connection_invitation_id;
        ELSE
            -- No connection, send a connection request first
            INSERT INTO connection_invitations (
                sender_id,
                recipient_id,
                status,
                message,
                created_at
            ) VALUES (
                p_inviter_id,
                p_invitee_id,
                'pending',
                CONCAT(
                    'Connection request sent to invite you to a group. Message: ',
                    COALESCE(p_message, 'No message provided')
                ),
                CURRENT_TIMESTAMP
            ) RETURNING id INTO v_connection_invitation_id;

            -- Store in pending group invitations to process after connection accepted
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
            );

            RETURN QUERY SELECT
                TRUE,
                'Connection request sent. The user will be invited to the group once they accept the connection.',
                'connection_request'::TEXT,
                v_connection_invitation_id;
        END IF;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION invite_user_to_group_cascade IS 'Updated in migration 120 to allow re-sending group invitations by reusing existing records';
