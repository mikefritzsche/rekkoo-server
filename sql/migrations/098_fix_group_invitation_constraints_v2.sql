-- Migration: Fix group invitation constraints and update trigger (Version 2)
-- Description: Handles duplicates before adding unique constraint and fixes trigger
-- Date: 2025-09-25
commit;
BEGIN;

-- 1. First, check for and handle duplicate invitations
DO $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    -- Count duplicates
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT group_id, invitee_id, COUNT(*) as count
        FROM group_invitations
        GROUP BY group_id, invitee_id
        HAVING COUNT(*) > 1
    ) AS duplicates;

    RAISE NOTICE 'Found % duplicate group invitations', duplicate_count;

    IF duplicate_count > 0 THEN
        -- Remove duplicates, keeping the most recent one
        DELETE FROM group_invitations
        WHERE id NOT IN (
            SELECT DISTINCT ON (group_id, invitee_id) id
            FROM group_invitations
            ORDER BY group_id, invitee_id, created_at DESC
        );

        RAISE NOTICE 'Removed duplicate group invitations';
    END IF;
END $$;

-- 2. Add unique constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'group_invitations'
        AND constraint_name = 'unique_group_invitation'
        AND constraint_type = 'UNIQUE'
    ) THEN
        ALTER TABLE group_invitations
        ADD CONSTRAINT unique_group_invitation
        UNIQUE (group_id, invitee_id);

        RAISE NOTICE 'Added unique constraint to group_invitations';
    END IF;
END $$;

-- 3. Drop and recreate the trigger function with proper constraint handling
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
            AND status = 'waiting'
        LOOP
            -- Generate invitation code
            v_invitation_code := LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', '')));

            -- Check if invitation already exists
            IF EXISTS (
                SELECT 1 FROM group_invitations
                WHERE group_id = pending_rec.group_id
                AND invitee_id = pending_rec.invitee_id
            ) THEN
                -- Update existing invitation
                UPDATE group_invitations
                SET
                    status = 'accepted',
                    responded_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE group_id = pending_rec.group_id
                AND invitee_id = pending_rec.invitee_id;
            ELSE
                -- Create new invitation
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
                    'accepted',
                    'member',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                );
            END IF;

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

            -- Create notification for the group invitation
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
                'group_invite_accepted',
                'Group Invitation Accepted',
                'You have been added to the group',
                pending_rec.group_id,
                'collaboration_groups',
                CURRENT_TIMESTAMP
            );

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