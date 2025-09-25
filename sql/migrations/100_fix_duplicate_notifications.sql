-- Migration: Fix duplicate notifications and improve notification creation
-- Description: Prevents duplicate notifications and ensures proper notification types
-- Date: 2025-09-25
commit;
BEGIN;

-- Drop and recreate the trigger function with notification deduplication
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

-- Create the corrected function
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_rec RECORD;
    v_invitation_code VARCHAR(255);
    v_notification_exists BOOLEAN;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Create bidirectional connection records
        INSERT INTO connections (user_id, connection_id, status, initiated_by, created_at, accepted_at)
        VALUES
            (NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, connection_id)
        DO UPDATE SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP;

        -- Process pending group invitations
        FOR pending_rec IN
            SELECT id, group_id, inviter_id, invitee_id, message
            FROM pending_group_invitations
            WHERE connection_invitation_id = NEW.id
            AND status = 'waiting'
        LOOP
            -- Generate invitation code
            v_invitation_code := LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', '')));

            -- Create PENDING group invitation (not auto-accepted)
            INSERT INTO group_invitations (
                id, group_id, inviter_id, invitee_id, invitation_code,
                message, status, role, created_at, expires_at
            ) VALUES (
                gen_random_uuid(),
                pending_rec.group_id,
                pending_rec.inviter_id,
                pending_rec.invitee_id,
                v_invitation_code,
                COALESCE(pending_rec.message, 'You have been invited to join a group!'),
                'pending',
                'member',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP + INTERVAL '30 days'
            )
            ON CONFLICT (group_id, invitee_id)
            DO UPDATE SET
                status = 'pending',
                invitation_code = v_invitation_code,
                message = COALESCE(pending_rec.message, 'You have been invited to join a group!'),
                created_at = CURRENT_TIMESTAMP,
                expires_at = CURRENT_TIMESTAMP + INTERVAL '30 days';

            -- Check if notification already exists to prevent duplicates
            SELECT EXISTS(
                SELECT 1 FROM notifications
                WHERE user_id = pending_rec.invitee_id
                AND notification_type = 'group_invitation'
                AND reference_id = pending_rec.group_id
                AND reference_type = 'collaboration_groups'
                AND created_at > CURRENT_TIMESTAMP - INTERVAL '5 minutes'
            ) INTO v_notification_exists;

            -- Only create notification if doesn't exist
            IF NOT v_notification_exists THEN
                INSERT INTO notifications (
                    user_id,
                    notification_type,
                    title,
                    body,
                    reference_id,
                    reference_type,
                    created_at
                ) VALUES (
                    pending_rec.invitee_id,
                    'group_invitation',
                    'Group Invitation',
                    'You have been invited to join a group',
                    pending_rec.group_id,
                    'collaboration_groups',
                    CURRENT_TIMESTAMP
                );
            END IF;

            -- Mark pending invitation as processed
            UPDATE pending_group_invitations
            SET status = 'processed', processed_at = CURRENT_TIMESTAMP
            WHERE id = pending_rec.id;

            -- Log the successful processing
            INSERT INTO audit_logs (
                action_type,
                table_name,
                record_id,
                user_id,
                details,
                created_at
            ) VALUES (
                'group_invitation_created',
                'group_invitations',
                pending_rec.group_id,
                pending_rec.invitee_id,
                jsonb_build_object(
                    'trigger', 'connection_accepted',
                    'connection_invitation_id', NEW.id,
                    'group_id', pending_rec.group_id,
                    'inviter_id', pending_rec.inviter_id,
                    'invitation_status', 'pending'
                ),
                CURRENT_TIMESTAMP
            );
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    WHEN (NEW.status = 'accepted' AND OLD.status = 'pending')
    EXECUTE FUNCTION process_connection_acceptance();

COMMIT;