-- Debug and fix group membership issue
-- This migration checks the current state and ensures users are properly added to groups

-- First, fix any processed pending invitations where user is not yet a member
INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
SELECT DISTINCT
    pgi.group_id,
    pgi.invitee_id,
    'member',
    COALESCE(pgi.processed_at, CURRENT_TIMESTAMP)
FROM pending_group_invitations pgi
WHERE pgi.status = 'processed'
AND NOT EXISTS (
    SELECT 1 FROM collaboration_group_members cgm
    WHERE cgm.group_id = pgi.group_id
    AND cgm.user_id = pgi.invitee_id
)
ON CONFLICT (group_id, user_id) DO NOTHING;

-- Update any pending group invitations to accepted for processed pending invitations
UPDATE group_invitations gi
SET status = 'accepted',
    responded_at = CURRENT_TIMESTAMP
FROM pending_group_invitations pgi
WHERE gi.group_id = pgi.group_id
AND gi.invitee_id = pgi.invitee_id
AND gi.status = 'pending'
AND pgi.status = 'processed';

-- Now fix the trigger function to ensure it properly adds members
CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_is_member BOOLEAN;
    v_group_invitation_id UUID;
    v_invitation_exists BOOLEAN;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        RAISE NOTICE 'Processing connection acceptance for invitation %', NEW.id;

        -- First, create bidirectional connection records with accepted status
        INSERT INTO connections (user_id, connection_id, status, initiated_by, created_at, accepted_at)
        VALUES
            (NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, connection_id)
        DO UPDATE SET
            status = 'accepted',
            accepted_at = CURRENT_TIMESTAMP;

        -- Process any pending group invitations associated with this connection
        FOR pending_invite IN
            SELECT pgi.id, pgi.group_id, pgi.inviter_id, pgi.invitee_id, pgi.message
            FROM pending_group_invitations pgi
            WHERE pgi.connection_invitation_id = NEW.id
              AND (pgi.status IS NULL OR pgi.status = 'pending' OR pgi.status = 'waiting')
        LOOP
            RAISE NOTICE 'Processing pending group invitation for group % user %',
                pending_invite.group_id, pending_invite.invitee_id;

            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                RAISE NOTICE 'User not yet a member, adding to group';

                -- Check if group invitation already exists
                SELECT EXISTS(
                    SELECT 1 FROM group_invitations
                    WHERE group_id = pending_invite.group_id
                    AND invitee_id = pending_invite.invitee_id
                ) INTO v_invitation_exists;

                IF v_invitation_exists THEN
                    -- Update existing invitation to accepted
                    UPDATE group_invitations
                    SET status = 'accepted',
                        responded_at = CURRENT_TIMESTAMP
                    WHERE group_id = pending_invite.group_id
                    AND invitee_id = pending_invite.invitee_id
                    AND status = 'pending';
                ELSE
                    -- Create new group invitation in ACCEPTED status
                    v_group_invitation_id := gen_random_uuid();

                    INSERT INTO group_invitations (
                        id,
                        group_id,
                        inviter_id,
                        invitee_id,
                        invitation_code,
                        message,
                        status,
                        created_at,
                        responded_at,
                        expires_at
                    ) VALUES (
                        v_group_invitation_id,
                        pending_invite.group_id,
                        pending_invite.inviter_id,
                        pending_invite.invitee_id,
                        LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', ''))),
                        COALESCE(pending_invite.message, 'Automatically accepted via connection request'),
                        'accepted',
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP + INTERVAL '30 days'
                    );
                END IF;

                -- IMPORTANT: Add the user to the group members table
                INSERT INTO collaboration_group_members (
                    group_id,
                    user_id,
                    role,
                    joined_at
                ) VALUES (
                    pending_invite.group_id,
                    pending_invite.invitee_id,
                    'member',
                    CURRENT_TIMESTAMP
                ) ON CONFLICT (group_id, user_id) DO NOTHING;

                RAISE NOTICE 'Added user % to group % as member',
                    pending_invite.invitee_id, pending_invite.group_id;
            ELSE
                RAISE NOTICE 'User already a member of the group';
            END IF;

            -- Update the pending invitation to processed
            UPDATE pending_group_invitations
            SET status = 'processed',
                processed_at = CURRENT_TIMESTAMP
            WHERE id = pending_invite.id;
        END LOOP;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION process_connection_acceptance();

-- Also ensure the accept_group_invitation function properly adds members
DROP FUNCTION IF EXISTS public.accept_group_invitation() CASCADE;
CREATE OR REPLACE FUNCTION public.accept_group_invitation()
RETURNS TRIGGER AS $$
BEGIN
    -- Only process when status changes to 'accepted'
    IF NEW.status = 'accepted' AND (OLD.status = 'pending' OR OLD.status IS NULL) THEN
        RAISE NOTICE 'Group invitation accepted, adding user % to group %',
            NEW.invitee_id, NEW.group_id;

        -- Add user to group members if not already a member
        INSERT INTO collaboration_group_members (
            group_id,
            user_id,
            role,
            joined_at
        ) VALUES (
            NEW.group_id,
            NEW.invitee_id,
            'member',
            CURRENT_TIMESTAMP
        ) ON CONFLICT (group_id, user_id)
        DO UPDATE SET
            joined_at = CASE
                WHEN collaboration_group_members.joined_at IS NULL
                THEN CURRENT_TIMESTAMP
                ELSE collaboration_group_members.joined_at
            END;

        -- Set responded_at if not already set
        IF NEW.responded_at IS NULL THEN
            NEW.responded_at = CURRENT_TIMESTAMP;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger for group invitation acceptance
DROP TRIGGER IF EXISTS process_group_invitation_acceptance ON public.group_invitations;
CREATE TRIGGER process_group_invitation_acceptance
    BEFORE UPDATE ON public.group_invitations
    FOR EACH ROW
    EXECUTE FUNCTION public.accept_group_invitation();

-- Comment for documentation
COMMENT ON FUNCTION process_connection_acceptance IS 'Fixed in migration 069 with debugging to ensure group membership is created';
COMMENT ON FUNCTION accept_group_invitation IS 'Fixed in migration 069 to ensure group membership is always created';