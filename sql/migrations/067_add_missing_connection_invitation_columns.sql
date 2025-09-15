-- Add missing columns to connection_invitations table
-- These columns are needed for the group invitation flow

-- Add invitation_context column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'connection_invitations'
        AND column_name = 'invitation_context'
    ) THEN
        ALTER TABLE connection_invitations
        ADD COLUMN invitation_context VARCHAR(50);

        COMMENT ON COLUMN connection_invitations.invitation_context IS 'Context for the invitation (e.g., group_invitation)';
        RAISE NOTICE 'Added invitation_context column to connection_invitations table';
    ELSE
        RAISE NOTICE 'invitation_context column already exists';
    END IF;
END $$;

-- Add metadata column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'connection_invitations'
        AND column_name = 'metadata'
    ) THEN
        ALTER TABLE connection_invitations
        ADD COLUMN metadata JSONB;

        COMMENT ON COLUMN connection_invitations.metadata IS 'Additional metadata for the invitation (e.g., group details)';
        RAISE NOTICE 'Added metadata column to connection_invitations table';
    ELSE
        RAISE NOTICE 'metadata column already exists';
    END IF;
END $$;

-- Re-create the invite_user_to_group_cascade function to ensure it's up to date
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

-- Verify the columns were added
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count
    FROM information_schema.columns
    WHERE table_name = 'connection_invitations'
    AND column_name IN ('invitation_context', 'metadata');

    IF v_count = 2 THEN
        RAISE NOTICE 'SUCCESS: Both invitation_context and metadata columns are present';
    ELSE
        RAISE EXCEPTION 'ERROR: Missing columns in connection_invitations table';
    END IF;
END $$;

COMMENT ON FUNCTION invite_user_to_group_cascade IS 'Updated in migration 067 to ensure connection_invitations table has required columns';

-- Also update the default status for pending_group_invitations to 'pending' for consistency
ALTER TABLE pending_group_invitations
ALTER COLUMN status SET DEFAULT 'pending';

-- Update the check constraint to include 'pending' as a valid status
ALTER TABLE pending_group_invitations
DROP CONSTRAINT IF EXISTS pending_group_invitations_status_check;

ALTER TABLE pending_group_invitations
ADD CONSTRAINT pending_group_invitations_status_check
CHECK (status IN ('pending', 'waiting', 'sent', 'cancelled', 'expired', 'processed'));