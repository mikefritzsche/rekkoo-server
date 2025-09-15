-- Fix table names in cascade invitation function and related objects
-- This migration updates all references to use the correct collaboration_* table names

-- Drop existing functions first (need to drop to change return types)
DROP FUNCTION IF EXISTS invite_user_to_group_cascade(UUID, UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS accept_group_invitation(UUID, UUID);
DROP FUNCTION IF EXISTS process_pending_group_invitations();

-- Recreate the function with correct table names
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
BEGIN
    -- Check if users are connected
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'accepted'
        AND (
            (user_id = p_inviter_id AND connected_user_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connected_user_id = p_inviter_id)
        )
    ) INTO v_is_connected;

    -- Check for pending connection
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'pending'
        AND (
            (user_id = p_inviter_id AND connected_user_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connected_user_id = p_inviter_id)
        )
    ) INTO v_pending_connection;

    -- If users are connected, send group invitation directly
    IF v_is_connected THEN
        -- Check if already invited
        SELECT id INTO v_existing_invitation
        FROM collaboration_group_invitations
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
        INSERT INTO collaboration_group_invitations (
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
            -- There's already a pending connection
            -- Store the pending group invitation
            INSERT INTO pending_group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                created_at
            ) VALUES (
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (group_id, invitee_id) DO UPDATE
            SET message = EXCLUDED.message,
                created_at = EXCLUDED.created_at;

            RETURN QUERY SELECT
                TRUE,
                'Connection request already pending. Group invitation will be sent once connected',
                'pending_connection'::TEXT,
                NULL::UUID;
        ELSE
            -- Send connection request and store pending invitation
            INSERT INTO connections (
                id,
                user_id,
                connected_user_id,
                status,
                created_at
            ) VALUES (
                gen_random_uuid(),
                p_inviter_id,
                p_invitee_id,
                'pending',
                CURRENT_TIMESTAMP
            ) RETURNING id INTO v_invitation_id;

            -- Store the pending group invitation
            INSERT INTO pending_group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                created_at
            ) VALUES (
                p_group_id,
                p_inviter_id,
                p_invitee_id,
                p_message,
                CURRENT_TIMESTAMP
            )
            ON CONFLICT (group_id, invitee_id) DO UPDATE
            SET message = EXCLUDED.message,
                created_at = EXCLUDED.created_at;

            RETURN QUERY SELECT
                TRUE,
                'Connection request sent. User will be invited to the group once they accept',
                'connection_request'::TEXT,
                v_invitation_id;
        END IF;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Update the trigger function to use correct table names
CREATE OR REPLACE FUNCTION process_pending_group_invitations()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_invitation_id UUID;
    v_is_member BOOLEAN;
BEGIN
    -- Only process when connection is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Process pending invitations where NEW.user_id invited NEW.connected_user_id
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE inviter_id = NEW.user_id
            AND invitee_id = NEW.connected_user_id
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Create the group invitation
                INSERT INTO collaboration_group_invitations (
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

            -- Remove the pending invitation
            DELETE FROM pending_group_invitations
            WHERE group_id = pending_invite.group_id
            AND invitee_id = pending_invite.invitee_id;
        END LOOP;

        -- Process pending invitations where NEW.connected_user_id invited NEW.user_id
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE inviter_id = NEW.connected_user_id
            AND invitee_id = NEW.user_id
        LOOP
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Create the group invitation
                INSERT INTO collaboration_group_invitations (
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

            -- Remove the pending invitation
            DELETE FROM pending_group_invitations
            WHERE group_id = pending_invite.group_id
            AND invitee_id = pending_invite.invitee_id;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update the function to accept group invitations
CREATE OR REPLACE FUNCTION accept_group_invitation(
    p_invitation_id UUID,
    p_user_id UUID
) RETURNS TABLE(
    success BOOLEAN,
    message TEXT
) AS $$
DECLARE
    v_invitation RECORD;
BEGIN
    -- Get and validate the invitation
    SELECT *
    FROM collaboration_group_invitations gi
    WHERE gi.id = p_invitation_id
    AND gi.invitee_id = p_user_id
    AND gi.status = 'pending'
    AND gi.expires_at > CURRENT_TIMESTAMP
    INTO v_invitation;

    IF v_invitation IS NULL THEN
        RETURN QUERY SELECT
            FALSE,
            'Invalid or expired invitation';
        RETURN;
    END IF;

    -- Add user to group members
    INSERT INTO collaboration_group_members (
        group_id,
        user_id,
        role,
        joined_at
    ) VALUES (
        v_invitation.group_id,
        p_user_id,
        'member',
        CURRENT_TIMESTAMP
    )
    ON CONFLICT (group_id, user_id) DO NOTHING;

    -- Update invitation status
    UPDATE collaboration_group_invitations
    SET status = 'accepted',
        responded_at = CURRENT_TIMESTAMP
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT
        TRUE,
        'Successfully joined the group';
END;
$$ LANGUAGE plpgsql;

-- Add comment to track migration
COMMENT ON FUNCTION invite_user_to_group_cascade IS 'Updated in migration 058 to use correct collaboration_* table names';

-- Drop old trigger if it exists on wrong table
DROP TRIGGER IF EXISTS trigger_process_pending_group_invitations ON connection_invitations;
DROP TRIGGER IF EXISTS trigger_process_pending_group_invitations ON connections;

-- Create trigger on the correct connections table
CREATE TRIGGER trigger_process_pending_group_invitations
    AFTER UPDATE ON connections
    FOR EACH ROW
    EXECUTE FUNCTION process_pending_group_invitations();