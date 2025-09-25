-- Migration: Cancel connection invitations when connection is removed
-- Description: Updates cascade_connection_removal function to also cancel pending connection invitations
-- Date: 2025-09-25

BEGIN;

-- Drop the existing trigger and function
DROP TRIGGER IF EXISTS trigger_cascade_connection_removal ON connections;
DROP FUNCTION IF EXISTS cascade_connection_removal();

-- Create the updated function that also handles connection invitations
CREATE OR REPLACE FUNCTION cascade_connection_removal()
RETURNS TRIGGER AS $$
DECLARE
    v_removed_user_id UUID;
    v_removing_user_id UUID;
    v_responded_at_column_exists BOOLEAN;
BEGIN
    -- Check if responded_at column exists in list_invitations table
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'list_invitations'
        AND column_name = 'responded_at'
    ) INTO v_responded_at_column_exists;

    -- Determine which user is being disconnected based on who initiated the removal
    IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
        -- Connection is being removed
        v_removing_user_id := NEW.user_id;
        v_removed_user_id := NEW.connection_id;

        -- Remove the removed user from all groups owned/administered by the removing user
        DELETE FROM group_members
        WHERE user_id = v_removed_user_id
        AND group_id IN (
            SELECT group_id FROM group_members
            WHERE user_id = v_removing_user_id
            AND role IN ('owner', 'admin')
        );

        -- Remove the removing user from all groups owned/administered by the removed user
        DELETE FROM group_members
        WHERE user_id = v_removing_user_id
        AND group_id IN (
            SELECT group_id FROM group_members
            WHERE user_id = v_removed_user_id
            AND role IN ('owner', 'admin')
        );

        -- Cancel all pending group invitations between these users
        UPDATE group_invitations
        SET status = 'cancelled',
            responded_at = CURRENT_TIMESTAMP
        WHERE status = 'pending'
        AND ((inviter_id = v_removing_user_id AND invitee_id = v_removed_user_id)
          OR (inviter_id = v_removed_user_id AND invitee_id = v_removing_user_id));

        -- CANCEL PENDING CONNECTION INVITATIONS BETWEEN THESE USERS
        UPDATE connection_invitations
        SET status = 'cancelled'
        WHERE status = 'pending'
        AND ((sender_id = v_removing_user_id AND recipient_id = v_removed_user_id)
          OR (sender_id = v_removed_user_id AND recipient_id = v_removing_user_id));

        -- Revoke list sharing permissions where one user shared with the other
        DELETE FROM list_collaborators
        WHERE (owner_id = v_removing_user_id AND user_id = v_removed_user_id)
           OR (owner_id = v_removed_user_id AND user_id = v_removing_user_id);

        -- Cancel pending list invitations between these users
        -- Handle both old and new schema
        IF v_responded_at_column_exists THEN
            -- New schema: use responded_at column
            UPDATE list_invitations
            SET status = 'cancelled',
                responded_at = CURRENT_TIMESTAMP
            WHERE status = 'pending'
            AND ((inviter_id = v_removing_user_id AND invitee_id = v_removed_user_id)
              OR (inviter_id = v_removed_user_id AND invitee_id = v_removing_user_id));
        ELSE
            -- Old schema: use updated_at column (fallback)
            UPDATE list_invitations
            SET status = 'cancelled',
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending'
            AND ((inviter_id = v_removing_user_id AND invitee_id = v_removed_user_id)
              OR (inviter_id = v_removed_user_id AND invitee_id = v_removing_user_id));
        END IF;

        -- Log the cascade action for audit
        INSERT INTO audit_logs (
            action_type,
            table_name,
            record_id,
            user_id,
            details,
            created_at
        ) VALUES (
            'cascade_delete',
            'connections',
            NEW.id,
            v_removing_user_id,
            jsonb_build_object(
                'removed_user_id', v_removed_user_id,
                'cascade_type', 'connection_removal',
                'affected_tables', ARRAY['group_members', 'group_invitations', 'connection_invitations', 'list_collaborators', 'list_invitations'],
                'schema_compatibility', v_responded_at_column_exists
            ),
            CURRENT_TIMESTAMP
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for connection removal cascade
CREATE TRIGGER trigger_cascade_connection_removal
    AFTER UPDATE ON connections
    FOR EACH ROW
    WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
    EXECUTE FUNCTION cascade_connection_removal();

-- Add comment for documentation
COMMENT ON FUNCTION cascade_connection_removal() IS 'Handles cascade deletion when a connection is removed, revoking all group memberships, list access, and pending invitations (including connection invitations). Compatible with both old and new list_invitations schema.';

COMMIT;

-- Migration verification
DO $$
BEGIN
    RAISE NOTICE 'Migration 092_cancel_connection_invitations_on_removal completed successfully';
    RAISE NOTICE 'Updated cascade_connection_removal function to cancel connection invitations';
    RAISE NOTICE 'Connection removal now properly cancels all pending connection invitations';
END $$;