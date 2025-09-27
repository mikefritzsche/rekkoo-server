-- Migration: Fix type casting issue in auto-add notification logic
-- Description: Fixes the COALESCE type mismatch between text and boolean
-- Date: 2025-09-26
COMMIT;
BEGIN;

-- Drop and recreate the trigger function with proper type casting
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

-- Create the enhanced function with fixed type casting
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_rec RECORD;
    v_invitation_code VARCHAR(255);
    v_notification_exists BOOLEAN;
    v_group_name TEXT;
    v_auto_add_to_group BOOLEAN;
    v_auto_add_preferences jsonb;
    v_member_exists BOOLEAN;
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
            -- Get group name for better messaging
            SELECT name INTO v_group_name
            FROM collaboration_groups
            WHERE id = pending_rec.group_id;

            -- Check if user allows automatic group additions
            v_auto_add_to_group := user_allows_automatic_group_additions(pending_rec.invitee_id);

            IF v_auto_add_to_group THEN
                -- Auto-add user to group
                -- First check if already a member
                SELECT EXISTS(
                    SELECT 1 FROM collaboration_group_members
                    WHERE group_id = pending_rec.group_id
                    AND user_id = pending_rec.invitee_id
                    AND deleted_at IS NULL
                ) INTO v_member_exists;

                IF NOT v_member_exists THEN
                    -- Add user directly to group
                    INSERT INTO collaboration_group_members (
                        group_id, user_id, role, status, joined_at, invited_by
                    ) VALUES (
                        pending_rec.group_id,
                        pending_rec.invitee_id,
                        'member',
                        'active',
                        CURRENT_TIMESTAMP,
                        pending_rec.inviter_id
                    )
                    ON CONFLICT (group_id, user_id)
                    DO UPDATE SET
                        status = 'active',
                        joined_at = CURRENT_TIMESTAMP,
                        invited_by = pending_rec.inviter_id;

                    -- Get user's auto-add preferences for notification
                    SELECT get_user_auto_add_preferences(pending_rec.invitee_id) INTO v_auto_add_preferences;

                    -- Send notification if user wants to be notified
                    -- Fixed type casting: explicitly cast the JSONB boolean value
                    IF COALESCE((v_auto_add_preferences->>'notifyOnAutomaticAddition')::boolean, true) THEN
                        -- Check if notification already exists to prevent duplicates
                        SELECT EXISTS(
                            SELECT 1 FROM notifications
                            WHERE user_id = pending_rec.invitee_id
                            AND notification_type = 'group_auto_added'
                            AND reference_id = pending_rec.group_id
                            AND reference_type = 'collaboration_groups'
                            AND created_at > CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                        ) INTO v_notification_exists;

                        IF NOT v_notification_exists THEN
                            INSERT INTO notifications (
                                user_id,
                                notification_type,
                                title,
                                body,
                                reference_id,
                                reference_type,
                                created_at,
                                is_read
                            ) VALUES (
                                pending_rec.invitee_id,
                                'group_auto_added',
                                'Added to Group',
                                'You have been added to the group "' || v_group_name || '" because you have automatic group additions enabled',
                                pending_rec.group_id,
                                'collaboration_groups',
                                CURRENT_TIMESTAMP,
                                false
                            );
                        END IF;
                    END IF;
                END IF;

                -- Log the automatic addition
                INSERT INTO audit_logs (
                    action_type,
                    table_name,
                    record_id,
                    user_id,
                    details,
                    created_at
                ) VALUES (
                    'group_auto_added',
                    'collaboration_group_members',
                    pending_rec.group_id,
                    pending_rec.invitee_id,
                    jsonb_build_object(
                        'trigger', 'connection_accepted_with_auto_add',
                        'connection_invitation_id', NEW.id,
                        'group_id', pending_rec.group_id,
                        'inviter_id', pending_rec.inviter_id,
                        'group_name', v_group_name,
                        'auto_add_enabled', true
                    ),
                    CURRENT_TIMESTAMP
                );
            ELSE
                -- Create PENDING group invitation (original behavior)
                -- Generate invitation code
                v_invitation_code := LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', '')));

                -- Create pending group invitation
                INSERT INTO group_invitations (
                    id, group_id, inviter_id, invitee_id, invitation_code,
                    message, status, role, created_at, expires_at
                ) VALUES (
                    gen_random_uuid(),
                    pending_rec.group_id,
                    pending_rec.inviter_id,
                    pending_rec.invitee_id,
                    v_invitation_code,
                    'You have been invited to join the group "' || v_group_name || '"',
                    'pending',
                    'member',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                )
                ON CONFLICT (group_id, invitee_id)
                DO UPDATE SET
                    status = 'pending',
                    invitation_code = v_invitation_code,
                    message = 'You have been invited to join the group "' || v_group_name || '"',
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
                        'You have been invited to join the group "' || v_group_name || '"',
                        pending_rec.group_id,
                        'collaboration_groups',
                        CURRENT_TIMESTAMP
                    );
                END IF;

                -- Log the regular invitation
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
                        'invitation_status', 'pending',
                        'group_name', v_group_name,
                        'auto_add_enabled', false
                    ),
                    CURRENT_TIMESTAMP
                );
            END IF;

            -- Mark pending invitation as processed
            UPDATE pending_group_invitations
            SET status = 'processed', processed_at = CURRENT_TIMESTAMP
            WHERE id = pending_rec.id;
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

-- Add the new notification type to the documentation
COMMENT ON FUNCTION process_connection_acceptance() IS 'Processes connection acceptance and handles group invitations. If user has allowAutomaticGroupAdditions enabled, they are automatically added to the group. Otherwise, a pending group invitation is created.';

COMMIT;