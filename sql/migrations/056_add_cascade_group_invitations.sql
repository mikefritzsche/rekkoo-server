-- Migration: Add cascade invitation system for connection -> group flow
-- Purpose: Allow inviting non-connected users to groups with automatic group invitation upon connection acceptance

-- Add metadata to connection_invitations to track pending group invitations
ALTER TABLE connection_invitations
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS invitation_context VARCHAR(50),
ADD COLUMN IF NOT EXISTS context_id UUID;

-- Create index for finding connection invitations with pending group context
CREATE INDEX IF NOT EXISTS idx_connection_invitations_context
ON connection_invitations(invitation_context, context_id)
WHERE status = 'pending';

-- Create a table to track pending group invitations waiting for connection
CREATE TABLE IF NOT EXISTS pending_group_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_invitation_id UUID REFERENCES connection_invitations(id) ON DELETE CASCADE,
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'cancelled', 'expired')),
    CONSTRAINT unique_pending_group_invitation UNIQUE (group_id, invitee_id, status)
        DEFERRABLE INITIALLY DEFERRED
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_pending_group_invitations_connection
ON pending_group_invitations(connection_invitation_id)
WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_pending_group_invitations_invitee
ON pending_group_invitations(invitee_id, status);

-- Function to handle connection acceptance and trigger group invitations
CREATE OR REPLACE FUNCTION process_pending_group_invitations_on_connection()
RETURNS TRIGGER AS $$
DECLARE
    v_pending_invitation RECORD;
    v_group_invitation_id UUID;
BEGIN
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        FOR v_pending_invitation IN
            SELECT pgi.*, g.name as group_name
            FROM pending_group_invitations pgi
            JOIN collaboration_groups g ON g.id = pgi.group_id
            WHERE pgi.connection_invitation_id = NEW.id
            AND pgi.status = 'waiting'
        LOOP
            INSERT INTO group_invitations (
                group_id,
                inviter_id,
                invitee_id,
                message,
                status,
                created_at
            ) VALUES (
                v_pending_invitation.group_id,
                v_pending_invitation.inviter_id,
                v_pending_invitation.invitee_id,
                COALESCE(
                    v_pending_invitation.message,
                    'You''ve been invited to join ' || v_pending_invitation.group_name || ' now that we''re connected!'
                ),
                'pending',
                CURRENT_TIMESTAMP
            )
            RETURNING id INTO v_group_invitation_id;

            UPDATE pending_group_invitations
            SET status = 'sent',
                processed_at = CURRENT_TIMESTAMP
            WHERE id = v_pending_invitation.id;

            INSERT INTO audit_logs (
                action_type,
                table_name,
                record_id,
                user_id,
                details,
                created_at
            ) VALUES (
                'cascade_group_invitation',
                'group_invitations',
                v_group_invitation_id,
                v_pending_invitation.inviter_id,
                jsonb_build_object(
                    'trigger', 'connection_accepted',
                    'connection_invitation_id', NEW.id,
                    'group_id', v_pending_invitation.group_id,
                    'invitee_id', v_pending_invitation.invitee_id
                ),
                CURRENT_TIMESTAMP
            );
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for processing pending group invitations
DROP TRIGGER IF EXISTS trigger_process_pending_group_invitations ON connection_invitations;
CREATE TRIGGER trigger_process_pending_group_invitations
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    WHEN (NEW.status = 'accepted' AND OLD.status = 'pending')
    EXECUTE FUNCTION process_pending_group_invitations_on_connection();

-- Function to invite user to group (handles both connected and non-connected users)
CREATE OR REPLACE FUNCTION invite_user_to_group_cascade(
    p_group_id UUID,
    p_inviter_id UUID,
    p_invitee_id UUID,
    p_message TEXT DEFAULT NULL
)
RETURNS TABLE (
    success BOOLEAN,
    invitation_type TEXT,
    invitation_id UUID,
    message TEXT
) AS $$
DECLARE
    v_connection_exists BOOLEAN;
    v_already_member BOOLEAN;
    v_connection_invitation_id UUID;
    v_group_invitation_id UUID;
    v_pending_invitation_id UUID;
    v_group_name TEXT;
BEGIN
    SELECT name INTO v_group_name FROM collaboration_groups WHERE id = p_group_id;

    SELECT EXISTS (
        SELECT 1 FROM group_members
        WHERE group_id = p_group_id AND user_id = p_invitee_id
    ) INTO v_already_member;

    IF v_already_member THEN
        RETURN QUERY SELECT
            FALSE,
            'error'::TEXT,
            NULL::UUID,
            'User is already a member of this group'::TEXT;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM connections
        WHERE ((user_id = p_inviter_id AND connection_id = p_invitee_id)
            OR (user_id = p_invitee_id AND connection_id = p_inviter_id))
        AND status = 'accepted'
        AND removed_at IS NULL
    ) INTO v_connection_exists;

    IF v_connection_exists THEN
        INSERT INTO group_invitations (
            group_id,
            inviter_id,
            invitee_id,
            message,
            status
        ) VALUES (
            p_group_id,
            p_inviter_id,
            p_invitee_id,
            p_message,
            'pending'
        )
        RETURNING id INTO v_group_invitation_id;

        RETURN QUERY SELECT
            TRUE,
            'group_invitation'::TEXT,
            v_group_invitation_id,
            'Group invitation sent successfully'::TEXT;

    ELSE
        SELECT id INTO v_connection_invitation_id
        FROM connection_invitations
        WHERE sender_id = p_inviter_id
        AND recipient_id = p_invitee_id
        AND status = 'pending';

        IF v_connection_invitation_id IS NULL THEN
            INSERT INTO connection_invitations (
                sender_id,
                recipient_id,
                status,
                invitation_context,
                context_id,
                metadata,
                message
            ) VALUES (
                p_inviter_id,
                p_invitee_id,
                'pending',
                'group_invitation',
                p_group_id,
                jsonb_build_object(
                    'group_name', v_group_name,
                    'group_invitation_pending', true
                ),
                COALESCE(
                    p_message,
                    'I''d like to connect with you and invite you to join ' || v_group_name
                )
            )
            RETURNING id INTO v_connection_invitation_id;
        END IF;

        INSERT INTO pending_group_invitations (
            group_id,
            inviter_id,
            invitee_id,
            connection_invitation_id,
            message,
            status
        ) VALUES (
            p_group_id,
            p_inviter_id,
            p_invitee_id,
            v_connection_invitation_id,
            p_message,
            'waiting'
        )
        ON CONFLICT (group_id, invitee_id, status)
        DO UPDATE SET
            connection_invitation_id = EXCLUDED.connection_invitation_id,
            message = EXCLUDED.message,
            created_at = CURRENT_TIMESTAMP
        RETURNING id INTO v_pending_invitation_id;

        RETURN QUERY SELECT
            TRUE,
            'connection_request'::TEXT,
            v_connection_invitation_id,
            'Connection request sent. Group invitation will be sent once connection is accepted.'::TEXT;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to get pending invitations for a user (both connection and group)
CREATE OR REPLACE FUNCTION get_user_pending_invitations(
    p_user_id UUID
)
RETURNS TABLE (
    invitation_type TEXT,
    invitation_id UUID,
    sender_name TEXT,
    group_name TEXT,
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    has_pending_group BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        'connection'::TEXT as invitation_type,
        ci.id as invitation_id,
        u.display_name as sender_name,
        CASE
            WHEN ci.invitation_context = 'group_invitation'
            THEN (ci.metadata->>'group_name')::TEXT
            ELSE NULL::TEXT
        END as group_name,
        ci.message,
        ci.created_at,
        EXISTS(
            SELECT 1 FROM pending_group_invitations pgi
            WHERE pgi.connection_invitation_id = ci.id
            AND pgi.status = 'waiting'
        ) as has_pending_group
    FROM connection_invitations ci
    JOIN users u ON u.id = ci.sender_id
    WHERE ci.recipient_id = p_user_id
    AND ci.status = 'pending'

    UNION ALL

    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        u.display_name as sender_name,
        g.name as group_name,
        gi.message,
        gi.created_at,
        FALSE as has_pending_group
    FROM group_invitations gi
    JOIN users u ON u.id = gi.inviter_id
    JOIN collaboration_groups g ON g.id = gi.group_id
    WHERE gi.invitee_id = p_user_id
    AND gi.status = 'pending'

    ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Add comments for documentation
COMMENT ON TABLE pending_group_invitations IS 'Tracks group invitations waiting for connection acceptance';
COMMENT ON FUNCTION invite_user_to_group_cascade IS 'Invites user to group, automatically handling connection request if needed';
COMMENT ON FUNCTION process_pending_group_invitations_on_connection IS 'Automatically sends group invitations when connections are accepted';