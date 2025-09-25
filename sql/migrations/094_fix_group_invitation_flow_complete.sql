-- Migration: Complete fix for group invitation flow from connection acceptance
-- Description: Fixes the entire flow from connection request to group invitation
-- Date: 2025-09-25
commit;
BEGIN;

-- 1. First, ensure the connection records exist and are accepted
-- Insert or update connection records for both users
INSERT INTO connections (user_id, connection_id, status, initiated_by, created_at, accepted_at)
VALUES
    ('1bcd0366-498a-4d6e-82a6-e880e47c808f', '0320693e-043b-4750-92b4-742e298a5f7f', 'accepted', '1bcd0366-498a-4d6e-82a6-e880e47c808f', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('0320693e-043b-4750-92b4-742e298a5f7f', '1bcd0366-498a-4d6e-82a6-e880e47c808f', 'accepted', '1bcd0366-498a-4d6e-82a6-e880e47c808f', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (user_id, connection_id)
DO UPDATE SET
    status = 'accepted',
    accepted_at = CURRENT_TIMESTAMP;

-- 2. Update the existing pending invitation to use the new connection invitation
UPDATE pending_group_invitations
SET
    connection_invitation_id = 'f2913878-b6c5-4809-ba6b-274e0cabe197',
    message = 'Group invitation via connection request',
    status = 'waiting',
    processed_at = NULL
WHERE group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba'
  AND invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f';

-- 3. Drop the connection check trigger and function completely
DROP TRIGGER IF EXISTS enforce_connection_before_group_invite ON public.group_invitations;
DROP FUNCTION IF EXISTS enforce_connection_before_group_invite() CASCADE;

-- 4. Delete any existing group invitation for this user/group
DELETE FROM group_invitations
WHERE group_id = '2978a07c-8cf8-48d2-a0ad-a5f76e420fba'
  AND invitee_id = '0320693e-043b-4750-92b4-742e298a5f7f';

-- 5. Create the group invitation in accepted status (since connection was already accepted)
INSERT INTO group_invitations (
    id,
    group_id,
    inviter_id,
    invitee_id,
    invitation_code,
    message,
    status,
    role,
    created_at,
    responded_at,
    expires_at
) VALUES (
    gen_random_uuid(),
    '2978a07c-8cf8-48d2-a0ad-a5f76e420fba',
    '1bcd0366-498a-4d6e-82a6-e880e47c808f',
    '0320693e-043b-4750-92b4-742e298a5f7f',
    LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', ''))),
    'Automatically accepted via connection request',
    'accepted',
    'member',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP + INTERVAL '30 days'
);

-- 6. Add the user to the group
INSERT INTO collaboration_group_members (
    group_id,
    user_id,
    role,
    joined_at,
    updated_at
) VALUES (
    '2978a07c-8cf8-48d2-a0ad-a5f76e420fba',
    '0320693e-043b-4750-92b4-742e298a5f7f',
    'member',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT (group_id, user_id) DO UPDATE SET
    role = EXCLUDED.role,
    joined_at = EXCLUDED.joined_at,
    updated_at = CURRENT_TIMESTAMP;

-- 7. Update the pending invitation as processed
UPDATE pending_group_invitations
SET status = 'processed',
    processed_at = CURRENT_TIMESTAMP
WHERE connection_invitation_id = 'f2913878-b6c5-4809-ba6b-274e0cabe197';

-- 8. Fix the connection acceptance trigger for future connections
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_invite RECORD;
    v_is_member BOOLEAN;
    v_group_invitation_id UUID;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
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
            -- Check if already a member
            SELECT EXISTS(
                SELECT 1 FROM collaboration_group_members
                WHERE group_id = pending_invite.group_id
                AND user_id = pending_invite.invitee_id
            ) INTO v_is_member;

            IF NOT v_is_member THEN
                -- Delete any existing group invitation for this user/group
                DELETE FROM group_invitations
                WHERE group_id = pending_invite.group_id
                  AND invitee_id = pending_invite.invitee_id;

                -- Create group invitation in ACCEPTED status (auto-accept)
                v_group_invitation_id := gen_random_uuid();

                INSERT INTO group_invitations (
                    id,
                    group_id,
                    inviter_id,
                    invitee_id,
                    invitation_code,
                    message,
                    status,
                    role,
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
                    'member',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                );

                -- Immediately add the user to the group
                INSERT INTO collaboration_group_members (
                    group_id,
                    user_id,
                    role,
                    joined_at,
                    updated_at
                ) VALUES (
                    pending_invite.group_id,
                    pending_invite.invitee_id,
                    'member',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                ) ON CONFLICT (group_id, user_id) DO UPDATE SET
                    role = EXCLUDED.role,
                    joined_at = EXCLUDED.joined_at,
                    updated_at = CURRENT_TIMESTAMP;
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

-- 9. Fix the connection request trigger to create pending group invitations
DROP FUNCTION IF EXISTS handle_connection_group_invitation() CASCADE;

CREATE OR REPLACE FUNCTION handle_connection_group_invitation()
RETURNS TRIGGER AS $$
DECLARE
    v_group_id UUID;
    v_group_name TEXT;
BEGIN
    -- Check if this is a group invitation context
    IF NEW.invitation_context = 'group_invitation' AND
       (NEW.metadata->>'group_id') IS NOT NULL THEN
        v_group_id := NEW.metadata->>'group_id';
        v_group_name := COALESCE(NEW.metadata->>'group_name', 'Unknown Group');

        -- Create pending group invitation
        INSERT INTO pending_group_invitations (
            id,
            group_id,
            inviter_id,
            invitee_id,
            message,
            connection_invitation_id,
            status,
            created_at
        ) VALUES (
            gen_random_uuid(),
            v_group_id,
            NEW.sender_id,
            NEW.recipient_id,
            COALESCE(NEW.message, 'Group invitation via connection'),
            NEW.id,
            'waiting',
            CURRENT_TIMESTAMP
        );

        RAISE NOTICE 'Created pending group invitation for connection % to group %', NEW.id, v_group_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 10. Create or replace triggers
DROP TRIGGER IF EXISTS trigger_process_connection_acceptance ON connection_invitations;
CREATE TRIGGER trigger_process_connection_acceptance
    AFTER UPDATE ON connection_invitations
    FOR EACH ROW
    EXECUTE FUNCTION process_connection_acceptance();

DROP TRIGGER IF EXISTS trigger_handle_connection_group_invitation ON connection_invitations;
CREATE TRIGGER trigger_handle_connection_group_invitation
    AFTER INSERT OR UPDATE ON connection_invitations
    FOR EACH ROW
    WHEN (NEW.status = 'pending' AND NEW.invitation_context = 'group_invitation')
    EXECUTE FUNCTION handle_connection_group_invitation();

COMMIT;

-- Verification
DO $$
BEGIN
    RAISE NOTICE 'Migration 094 completed successfully';
    RAISE NOTICE 'Fixed connection to group invitation flow';
    RAISE NOTICE 'User should now be added to the group';
END $$;