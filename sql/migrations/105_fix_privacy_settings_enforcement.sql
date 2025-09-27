-- Migration: Fix Privacy Settings Enforcement
-- Description: Updates functions to properly enforce all privacy settings that were defined but not enforced
-- Date: 2025-09-26
commit;
BEGIN;

-- 1. Fix can_send_connection_request to check allow_connection_requests setting
CREATE OR REPLACE FUNCTION can_send_connection_request(p_sender_id uuid, p_recipient_id uuid)
RETURNS TABLE(can_send boolean, reason character varying, retry_after timestamp with time zone, attempt_count integer, declined_count integer)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_history RECORD;
    v_last_invitation RECORD;
    v_is_blocked BOOLEAN;
    v_max_attempts INTEGER := 3; -- Maximum attempts allowed
    v_cooldown_days INTEGER := 30; -- Days to wait after rejection
    v_soft_block_days INTEGER := 90; -- Soft block duration
    v_allow_connection_requests BOOLEAN;
BEGIN
    -- Check if users are already connected
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE user_id = p_sender_id
        AND connection_id = p_recipient_id
        AND status IN ('accepted', 'following')
    ) INTO v_is_blocked;

    IF v_is_blocked THEN
        RETURN QUERY SELECT FALSE, 'Already connected'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- Check if the sender is blocked
    SELECT EXISTS(
        SELECT 1 FROM public.connections
        WHERE user_id = p_recipient_id
        AND connection_id = p_sender_id
        AND status = 'blocked'
    ) INTO v_is_blocked;

    IF v_is_blocked THEN
        RETURN QUERY SELECT FALSE, 'User has blocked you'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- NEW: Check if recipient allows connection requests
    SELECT COALESCE((privacy_settings->>'allow_connection_requests')::boolean, true)
    INTO v_allow_connection_requests
    FROM public.user_settings
    WHERE user_id = p_recipient_id;

    IF NOT v_allow_connection_requests THEN
        RETURN QUERY SELECT FALSE, 'User is not accepting connection requests at this time'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- Check request history
    SELECT * INTO v_history
    FROM public.connection_request_history
    WHERE sender_id = p_sender_id AND recipient_id = p_recipient_id;

    -- If no history, allow the request
    IF v_history IS NULL THEN
        RETURN QUERY SELECT TRUE, 'Can send request'::VARCHAR(100), NULL::TIMESTAMPTZ, 0, 0;
        RETURN;
    END IF;

    -- Check if soft blocked
    IF v_history.is_soft_blocked THEN
        IF v_history.soft_block_expires_at IS NULL OR v_history.soft_block_expires_at > CURRENT_TIMESTAMP THEN
            RETURN QUERY SELECT FALSE, 'User has temporarily blocked connection requests'::VARCHAR(100),
                         v_history.soft_block_expires_at, v_history.total_attempts, v_history.declined_count;
            RETURN;
        END IF;
    END IF;

    -- Check if under cooldown
    IF v_history.last_declined_at IS NOT NULL THEN
        IF v_history.last_declined_at > CURRENT_TIMESTAMP - (v_cooldown_days || ' days')::INTERVAL THEN
            RETURN QUERY SELECT FALSE, 'Please wait before sending another request'::VARCHAR(100),
                         v_history.last_declined_at + (v_cooldown_days || ' days')::INTERVAL,
                         v_history.total_attempts, v_history.declined_count;
            RETURN;
        END IF;
    END IF;

    -- Check max attempts
    IF v_history.total_attempts >= v_max_attempts THEN
        RETURN QUERY SELECT FALSE, 'Maximum connection requests reached'::VARCHAR(100), NULL::TIMESTAMPTZ,
                     v_history.total_attempts, v_history.declined_count;
        RETURN;
    END IF;

    -- All checks passed
    RETURN QUERY SELECT TRUE, 'Can send request'::VARCHAR(100), NULL::TIMESTAMPTZ, v_history.total_attempts, v_history.declined_count;
END;
$$;

-- 2. Create function to check if user can be invited to groups
CREATE OR REPLACE FUNCTION can_invite_user_to_group(p_inviter_id uuid, p_invitee_id uuid)
RETURNS TABLE(can_invite boolean, reason character varying)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_allow_group_invites BOOLEAN;
    v_privacy_mode TEXT;
    v_are_connected BOOLEAN;
BEGIN
    -- Check if users are the same
    IF p_inviter_id = p_invitee_id THEN
        RETURN QUERY SELECT FALSE, 'Cannot invite yourself to a group'::VARCHAR(100);
        RETURN;
    END IF;

    -- Get invitee's privacy settings
    SELECT
        COALESCE((privacy_settings->>'allow_group_invites_from_connections')::boolean, true),
        privacy_settings->>'privacy_mode'
    INTO v_allow_group_invites, v_privacy_mode
    FROM public.user_settings
    WHERE user_id = p_invitee_id;

    -- Check if invitee allows group invites
    IF NOT v_allow_group_invites THEN
        RETURN QUERY SELECT FALSE, 'User does not accept group invitations'::VARCHAR(100);
        RETURN;
    END IF;

    -- For private mode, check if users are connected
    IF v_privacy_mode = 'private' THEN
        SELECT EXISTS(
            SELECT 1 FROM public.connections
            WHERE user_id = p_inviter_id AND connection_id = p_invitee_id
            AND status = 'accepted'
        ) INTO v_are_connected;

        IF NOT v_are_connected THEN
            RETURN QUERY SELECT FALSE, 'User only accepts group invitations from connections'::VARCHAR(100);
            RETURN;
        END IF;
    END IF;

    -- Ghost mode users cannot be invited to groups
    IF v_privacy_mode = 'ghost' THEN
        RETURN QUERY SELECT FALSE, 'User cannot be invited to groups'::VARCHAR(100);
        RETURN;
    END IF;

    -- All checks passed
    RETURN QUERY SELECT TRUE, 'Can invite to group'::VARCHAR(100);
END;
$$;

-- 3. Create function to check if user can be invited to lists
CREATE OR REPLACE FUNCTION can_invite_user_to_list(p_inviter_id uuid, p_invitee_id uuid, p_list_type character varying DEFAULT NULL)
RETURNS TABLE(can_invite boolean, reason character varying)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_allow_list_invitations TEXT;
    v_privacy_mode TEXT;
    v_are_connected BOOLEAN;
    v_list_settings_valid BOOLEAN;
BEGIN
    -- Check if users are the same
    IF p_inviter_id = p_invitee_id THEN
        RETURN QUERY SELECT FALSE, 'Cannot invite yourself to a list'::VARCHAR(100);
        RETURN;
    END IF;

    -- Get invitee's privacy settings
    SELECT
        COALESCE(privacy_settings->>'allowListInvitations', 'connections')::TEXT,
        privacy_settings->>'privacy_mode'
    INTO v_allow_list_invitations, v_privacy_mode
    FROM public.user_settings
    WHERE user_id = p_invitee_id;

    -- Check list invitation preferences
    IF v_allow_list_invitations = 'none' THEN
        RETURN QUERY SELECT FALSE, 'User does not accept list invitations'::VARCHAR(100);
        RETURN;
    ELSIF v_allow_list_invitations = 'connections' THEN
        -- Check if users are connected
        SELECT EXISTS(
            SELECT 1 FROM public.connections
            WHERE user_id = p_inviter_id AND connection_id = p_invitee_id
            AND status = 'accepted'
        ) INTO v_are_connected;

        IF NOT v_are_connected THEN
            RETURN QUERY SELECT FALSE, 'User only accepts list invitations from connections'::VARCHAR(100);
            RETURN;
        END IF;
    END IF;

    -- Ghost mode users cannot be invited to lists
    IF v_privacy_mode = 'ghost' THEN
        RETURN QUERY SELECT FALSE, 'User cannot be invited to lists'::VARCHAR(100);
        RETURN;
    END IF;

    -- All checks passed
    RETURN QUERY SELECT TRUE, 'Can invite to list'::VARCHAR(100);
END;
$$;

-- 4. Create function to check if user requires approval for additions
CREATE OR REPLACE FUNCTION user_requires_approval_for_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_require_approval BOOLEAN;
    v_privacy_mode TEXT;
BEGIN
    -- Get user's privacy settings
    SELECT
        COALESCE((privacy_settings->>'require_approval_for_all')::boolean, true),
        privacy_settings->>'privacy_mode'
    INTO v_require_approval, v_privacy_mode
    FROM public.user_settings
    WHERE user_id = p_user_id;

    -- Ghost mode always requires approval
    IF v_privacy_mode = 'ghost' THEN
        RETURN TRUE;
    END IF;

    -- Public mode never requires approval
    IF v_privacy_mode = 'public' THEN
        RETURN FALSE;
    END IF;

    -- Return user's preference
    RETURN v_require_approval;
END;
$$ LANGUAGE plpgsql STABLE;

-- 5. Update the auto-add functions to respect require_approval_for_all
CREATE OR REPLACE FUNCTION user_allows_automatic_group_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_auto_add_preferences jsonb;
    v_requires_approval BOOLEAN;
BEGIN
    -- Check if user requires approval for all additions
    v_requires_approval := user_requires_approval_for_additions(p_user_id);

    -- If user requires approval, never auto-add
    IF v_requires_approval THEN
        RETURN FALSE;
    END IF;

    -- Get user's auto-add preferences
    SELECT get_user_auto_add_preferences(p_user_id) INTO v_auto_add_preferences;

    RETURN COALESCE(
        v_auto_add_preferences->>'allowAutomaticGroupAdditions',
        false
    )::boolean;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION user_allows_automatic_list_additions(p_user_id uuid)
RETURNS boolean AS $$
DECLARE
    v_auto_add_preferences jsonb;
    v_requires_approval BOOLEAN;
BEGIN
    -- Check if user requires approval for all additions
    v_requires_approval := user_requires_approval_for_additions(p_user_id);

    -- If user requires approval, never auto-add
    IF v_requires_approval THEN
        RETURN FALSE;
    END IF;

    -- Get user's auto-add preferences
    SELECT get_user_auto_add_preferences(p_user_id) INTO v_auto_add_preferences;

    RETURN COALESCE(
        v_auto_add_preferences->>'allowAutomaticListAdditions',
        false
    )::boolean;
END;
$$ LANGUAGE plpgsql STABLE;

-- 6. Update the connection acceptance trigger to use the new invitation checks
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

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
    v_can_invite BOOLEAN;
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
            -- Check if inviter can still invite this user to groups
            SELECT can_invite INTO v_can_invite
            FROM can_invite_user_to_group(pending_rec.inviter_id, pending_rec.invitee_id);

            IF NOT v_can_invite THEN
                -- Skip this invitation
                UPDATE pending_group_invitations
                SET status = 'skipped', processed_at = CURRENT_TIMESTAMP
                WHERE id = pending_rec.id;
                CONTINUE;
            END IF;

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
                    IF COALESCE(v_auto_add_preferences->>'notifyOnAutomaticAddition', true)::boolean THEN
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

CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    WHEN (NEW.status = 'accepted' AND OLD.status = 'pending')
    EXECUTE FUNCTION process_connection_acceptance();

-- Add comments for documentation
COMMENT ON FUNCTION can_send_connection_request(uuid, uuid) IS 'Checks if a user can send a connection request to another user, respecting privacy settings';
COMMENT ON FUNCTION can_invite_user_to_group(uuid, uuid) IS 'Checks if a user can be invited to a group based on their privacy settings';
COMMENT ON FUNCTION can_invite_user_to_list(uuid, uuid, varchar) IS 'Checks if a user can be invited to a list based on their privacy settings';
COMMENT ON FUNCTION user_requires_approval_for_additions(uuid) IS 'Checks if a user requires approval for all group/list additions';

COMMIT;