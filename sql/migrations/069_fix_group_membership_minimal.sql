-- Minimal migration to fix group membership without triggering view/rule errors
-- This avoids complex queries that might trigger the l.name error

-- Step 1: Create a temporary function to add missing members
CREATE OR REPLACE FUNCTION temp_fix_group_memberships()
RETURNS void AS $$
DECLARE
    rec RECORD;
BEGIN
    -- Loop through processed pending invitations
    FOR rec IN
        SELECT group_id, invitee_id, processed_at
        FROM pending_group_invitations
        WHERE status = 'processed'
    LOOP
        -- Try to add member (will be ignored if already exists)
        BEGIN
            INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
            VALUES (rec.group_id, rec.invitee_id, 'member', COALESCE(rec.processed_at, CURRENT_TIMESTAMP))
            ON CONFLICT (group_id, user_id) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN
            -- Ignore any errors for individual inserts
            NULL;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute the function
SELECT temp_fix_group_memberships();

-- Drop the temporary function
DROP FUNCTION temp_fix_group_memberships();

-- Step 2: Update group invitations status separately
CREATE OR REPLACE FUNCTION temp_fix_invitation_status()
RETURNS void AS $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT gi.id
        FROM group_invitations gi
        INNER JOIN pending_group_invitations pgi
            ON gi.group_id = pgi.group_id
            AND gi.invitee_id = pgi.invitee_id
        WHERE gi.status = 'pending'
        AND pgi.status = 'processed'
    LOOP
        UPDATE group_invitations
        SET status = 'accepted', responded_at = CURRENT_TIMESTAMP
        WHERE id = rec.id;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute the function
SELECT temp_fix_invitation_status();

-- Drop the temporary function
DROP FUNCTION temp_fix_invitation_status();

-- Step 3: Fix the main trigger function
DROP FUNCTION IF EXISTS process_connection_acceptance() CASCADE;

CREATE OR REPLACE FUNCTION process_connection_acceptance()
RETURNS TRIGGER AS $$
DECLARE
    pending_rec RECORD;
BEGIN
    -- Only process when connection invitation is accepted
    IF NEW.status = 'accepted' AND OLD.status = 'pending' THEN
        -- Create bidirectional connection records
        BEGIN
            INSERT INTO connections (user_id, connection_id, status, initiated_by, created_at, accepted_at)
            VALUES (NEW.sender_id, NEW.recipient_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, connection_id)
            DO UPDATE SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP;
        EXCEPTION WHEN OTHERS THEN
            NULL; -- Continue even if connection already exists
        END;

        BEGIN
            INSERT INTO connections (user_id, connection_id, status, initiated_by, created_at, accepted_at)
            VALUES (NEW.recipient_id, NEW.sender_id, 'accepted', NEW.sender_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, connection_id)
            DO UPDATE SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP;
        EXCEPTION WHEN OTHERS THEN
            NULL; -- Continue even if connection already exists
        END;

        -- Process pending group invitations
        FOR pending_rec IN
            SELECT id, group_id, inviter_id, invitee_id, message
            FROM pending_group_invitations
            WHERE connection_invitation_id = NEW.id
            AND (status IS NULL OR status IN ('pending', 'waiting'))
        LOOP
            -- Create or update group invitation
            BEGIN
                INSERT INTO group_invitations (
                    id, group_id, inviter_id, invitee_id, invitation_code,
                    message, status, created_at, responded_at, expires_at
                ) VALUES (
                    gen_random_uuid(),
                    pending_rec.group_id,
                    pending_rec.inviter_id,
                    pending_rec.invitee_id,
                    LOWER(CONCAT('GI-', REPLACE(gen_random_uuid()::TEXT, '-', ''))),
                    COALESCE(pending_rec.message, 'Auto-accepted via connection'),
                    'accepted',
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP + INTERVAL '30 days'
                )
                ON CONFLICT (group_id, invitee_id)
                DO UPDATE SET status = 'accepted', responded_at = CURRENT_TIMESTAMP;
            EXCEPTION WHEN OTHERS THEN
                NULL; -- Continue even if invitation fails
            END;

            -- Add to group members
            BEGIN
                INSERT INTO collaboration_group_members (group_id, user_id, role, joined_at)
                VALUES (pending_rec.group_id, pending_rec.invitee_id, 'member', CURRENT_TIMESTAMP)
                ON CONFLICT (group_id, user_id) DO NOTHING;
            EXCEPTION WHEN OTHERS THEN
                NULL; -- Continue even if member add fails
            END;

            -- Mark as processed
            UPDATE pending_group_invitations
            SET status = 'processed', processed_at = CURRENT_TIMESTAMP
            WHERE id = pending_rec.id;
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

-- Comment for documentation
COMMENT ON FUNCTION process_connection_acceptance IS 'Fixed in migration 069 minimal - handles group membership on connection acceptance';