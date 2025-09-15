-- Fix column names in cascade invitation function
-- The connections table uses 'connection_id' not 'connected_user_id'

-- Drop and recreate the function with correct column names
DROP FUNCTION IF EXISTS invite_user_to_group_cascade(UUID, UUID, UUID, TEXT);

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
    -- Note: connections table uses 'connection_id' not 'connected_user_id'
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'accepted'
        AND (
            (user_id = p_inviter_id AND connection_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connection_id = p_inviter_id)
        )
    ) INTO v_is_connected;

    -- Check for pending connection
    SELECT EXISTS(
        SELECT 1 FROM connections
        WHERE status = 'pending'
        AND (
            (user_id = p_inviter_id AND connection_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connection_id = p_inviter_id)
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
                connection_id,
                status,
                initiated_by,
                created_at
            ) VALUES (
                gen_random_uuid(),
                p_inviter_id,
                p_invitee_id,
                'pending',
                p_inviter_id,
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

-- Update the trigger function to use correct column names
-- First drop the trigger that depends on the function
DROP TRIGGER IF EXISTS trigger_process_pending_group_invitations ON connections;
-- Now we can safely drop the function
DROP FUNCTION IF EXISTS process_pending_group_invitations() CASCADE;

CREATE OR REPLACE FUNCTION process_pending_group_invitations()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_invitation_id UUID;
    v_is_member BOOLEAN;
BEGIN
    -- Only process when connection is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Process pending invitations where NEW.user_id invited NEW.connection_id
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE inviter_id = NEW.user_id
            AND invitee_id = NEW.connection_id
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

        -- Process pending invitations where NEW.connection_id invited NEW.user_id
        FOR pending_invite IN
            SELECT * FROM pending_group_invitations
            WHERE inviter_id = NEW.connection_id
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

-- Recreate the trigger with the correct function
CREATE TRIGGER trigger_process_pending_group_invitations
    AFTER UPDATE ON connections
    FOR EACH ROW
    EXECUTE FUNCTION process_pending_group_invitations();

-- Add comment to track migration
COMMENT ON FUNCTION invite_user_to_group_cascade IS 'Updated in migration 059 to use correct connections column names (connection_id not connected_user_id)';