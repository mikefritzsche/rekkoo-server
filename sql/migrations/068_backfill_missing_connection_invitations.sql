-- Backfill connection_invitations for existing pending_group_invitations
-- This handles cases where pending_group_invitations were created but connection_invitations failed

-- First, ensure the columns exist (in case 067 hasn't been run yet)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'connection_invitations'
        AND column_name = 'invitation_context'
    ) THEN
        ALTER TABLE connection_invitations
        ADD COLUMN invitation_context VARCHAR(50);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'connection_invitations'
        AND column_name = 'metadata'
    ) THEN
        ALTER TABLE connection_invitations
        ADD COLUMN metadata JSONB;
    END IF;
END $$;

-- Find all pending_group_invitations that don't have a connection_invitation
-- and create the missing connection_invitations
DO $$
DECLARE
    pending_invite RECORD;
    v_connection_invitation_id UUID;
    v_is_connected BOOLEAN;
    v_group_name TEXT;
    v_created_count INTEGER := 0;
BEGIN
    -- Loop through all pending group invitations without connection invitations
    FOR pending_invite IN
        SELECT pgi.*, g.name as group_name
        FROM pending_group_invitations pgi
        JOIN collaboration_groups g ON g.id = pgi.group_id
        WHERE pgi.status IN ('pending', 'waiting')
        AND (pgi.connection_invitation_id IS NULL
             OR NOT EXISTS (
                 SELECT 1 FROM connection_invitations ci
                 WHERE ci.id = pgi.connection_invitation_id
             ))
    LOOP
        -- Check if users are already connected
        SELECT EXISTS(
            SELECT 1 FROM connections
            WHERE status = 'accepted'
            AND (
                (user_id = pending_invite.inviter_id AND connection_id = pending_invite.invitee_id)
                OR (user_id = pending_invite.invitee_id AND connection_id = pending_invite.inviter_id)
            )
        ) INTO v_is_connected;

        -- Only create connection invitation if users are not connected
        IF NOT v_is_connected THEN
            -- Check if a connection invitation already exists
            SELECT id INTO v_connection_invitation_id
            FROM connection_invitations
            WHERE sender_id = pending_invite.inviter_id
            AND recipient_id = pending_invite.invitee_id
            AND status = 'pending';

            -- If no existing connection invitation, create one
            IF v_connection_invitation_id IS NULL THEN
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
                    pending_invite.inviter_id,
                    pending_invite.invitee_id,
                    COALESCE(pending_invite.message, 'I would like to invite you to join a group'),
                    'pending',
                    'group_invitation',
                    jsonb_build_object(
                        'group_id', pending_invite.group_id,
                        'group_name', pending_invite.group_name
                    ),
                    pending_invite.created_at,  -- Use original creation time
                    pending_invite.created_at + INTERVAL '30 days'
                ) RETURNING id INTO v_connection_invitation_id;

                v_created_count := v_created_count + 1;
                RAISE NOTICE 'Created connection invitation % for pending group invitation to user %',
                    v_connection_invitation_id, pending_invite.invitee_id;
            END IF;

            -- Update the pending_group_invitation with the connection_invitation_id
            UPDATE pending_group_invitations
            SET connection_invitation_id = v_connection_invitation_id
            WHERE id = pending_invite.id;
        ELSE
            -- Users are already connected, this shouldn't be a pending_group_invitation
            -- Convert it to a regular group invitation
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
                pending_invite.created_at,
                pending_invite.created_at + INTERVAL '30 days'
            )
            ON CONFLICT (group_id, invitee_id)
            WHERE status = 'pending'
            DO NOTHING;

            -- Mark the pending invitation as processed
            UPDATE pending_group_invitations
            SET status = 'processed',
                processed_at = CURRENT_TIMESTAMP
            WHERE id = pending_invite.id;

            RAISE NOTICE 'Converted pending_group_invitation to regular group_invitation for already connected users';
        END IF;
    END LOOP;

    RAISE NOTICE 'Backfill complete. Created % connection invitations', v_created_count;
END $$;

-- Also create notifications for any connection invitations that don't have them
INSERT INTO notifications (
    id,
    user_id,
    notification_type,
    title,
    body,
    reference_type,
    reference_id,
    created_at,
    is_read
)
SELECT
    gen_random_uuid(),
    ci.recipient_id,
    'connection_request',
    'New Connection Request',
    CASE
        WHEN ci.invitation_context = 'group_invitation' AND ci.metadata ? 'group_name' THEN
            u.username || ' wants to connect with you to invite you to ' || (ci.metadata->>'group_name')
        WHEN ci.message IS NOT NULL AND ci.message != '' THEN
            u.username || ' wants to connect with you: ' || ci.message
        ELSE
            u.username || ' wants to connect with you'
    END,
    'connection_invitation',
    ci.id,
    ci.created_at,
    FALSE
FROM connection_invitations ci
JOIN users u ON u.id = ci.sender_id
WHERE ci.status = 'pending'
AND ci.invitation_context = 'group_invitation'
AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.reference_type = 'connection_invitation'
    AND n.reference_id = ci.id
);

-- Log summary
DO $$
DECLARE
    v_pending_count INTEGER;
    v_connection_count INTEGER;
    v_notification_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_pending_count
    FROM pending_group_invitations
    WHERE status IN ('pending', 'waiting');

    SELECT COUNT(*) INTO v_connection_count
    FROM connection_invitations
    WHERE status = 'pending'
    AND invitation_context = 'group_invitation';

    SELECT COUNT(*) INTO v_notification_count
    FROM notifications
    WHERE reference_type = 'connection_invitation'
    AND is_read = FALSE;

    RAISE NOTICE 'Summary: % pending group invitations, % connection invitations, % unread notifications',
        v_pending_count, v_connection_count, v_notification_count;
END $$;