-- Migration: Fix trigger processing logic for group invitations
-- Description: Updates the process_connection_acceptance function to look for correct status
-- Date: 2025-09-25
commit;
BEGIN;

-- Drop the existing trigger and function
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

-- Create the corrected function
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_rec RECORD;
    v_invitation_code VARCHAR(255);
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
            AND status = 'waiting'  -- Fixed: was looking for 'pending'
        LOOP
            -- Generate invitation code
            v_invitation_code := LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', '')));

            -- Create the group invitation
            INSERT INTO group_invitations (
                id, group_id, inviter_id, invitee_id, invitation_code,
                message, status, role, created_at, responded_at, expires_at
            ) VALUES (
                gen_random_uuid(),
                pending_rec.group_id,
                pending_rec.inviter_id,
                pending_rec.invitee_id,
                v_invitation_code,
                COALESCE(pending_rec.message, 'Automatically accepted via connection request'),
                'accepted',  -- Set to accepted since connection was accepted
                'member',
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP + INTERVAL '30 days'
            )
            ON CONFLICT (group_id, invitee_id)
            DO UPDATE SET
                status = 'accepted',
                responded_at = CURRENT_TIMESTAMP;

            -- Add user to the group
            INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
            VALUES (pending_rec.group_id, pending_rec.invitee_id, 'member', CURRENT_TIMESTAMP)
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                role = 'member',
                joined_at = CURRENT_TIMESTAMP;

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
                'auto_group_acceptance',
                'collaboration_group_members',
                pending_rec.group_id,
                pending_rec.invitee_id,
                jsonb_build_object(
                    'trigger', 'connection_accepted',
                    'connection_invitation_id', NEW.id,
                    'group_id', pending_rec.group_id,
                    'inviter_id', pending_rec.inviter_id,
                    'auto_accepted', true
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