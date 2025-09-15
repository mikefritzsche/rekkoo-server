-- Migration: Add cascade deletion for connections
-- Purpose: When a connection is removed, revoke all associated group/list access

-- Create audit_logs table if it doesn't exist (needed by cascade function)
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_type VARCHAR(50) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    record_id UUID,
    user_id UUID REFERENCES users(id),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for audit logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_action ON audit_logs(user_id, action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON audit_logs(table_name, record_id);

-- Note: Using CREATE OR REPLACE for idempotency (can run migration multiple times)

-- Function to handle connection removal cascades
CREATE OR REPLACE FUNCTION cascade_connection_removal()
RETURNS TRIGGER AS $$
DECLARE
    v_removed_user_id UUID;
    v_removing_user_id UUID;
BEGIN
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

        -- Revoke list sharing permissions where one user shared with the other
        DELETE FROM list_collaborators
        WHERE (owner_id = v_removing_user_id AND user_id = v_removed_user_id)
           OR (owner_id = v_removed_user_id AND user_id = v_removing_user_id);

        -- Cancel pending list invitations between these users
        UPDATE list_invitations
        SET status = 'cancelled',
            responded_at = CURRENT_TIMESTAMP
        WHERE status = 'pending'
        AND ((inviter_id = v_removing_user_id AND invitee_id = v_removed_user_id)
          OR (inviter_id = v_removed_user_id AND invitee_id = v_removing_user_id));

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
                'affected_tables', ARRAY['group_members', 'group_invitations', 'list_collaborators', 'list_invitations']
            ),
            CURRENT_TIMESTAMP
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for connection removal cascade
DROP TRIGGER IF EXISTS trigger_cascade_connection_removal ON connections;
CREATE TRIGGER trigger_cascade_connection_removal
    AFTER UPDATE ON connections
    FOR EACH ROW
    WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
    EXECUTE FUNCTION cascade_connection_removal();

-- Function to get affected items before connection removal (for UI confirmation)
CREATE OR REPLACE FUNCTION get_connection_removal_impact(
    p_user_id UUID,
    p_connection_id UUID
)
RETURNS TABLE (
    impact_type TEXT,
    item_count INTEGER,
    details JSONB
) AS $$
BEGIN
    -- Groups where removed user will lose membership
    RETURN QUERY
    SELECT
        'groups_membership_loss'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'group_id', gm.group_id,
            'group_name', g.name,
            'user_role', gm.role
        )) as details
    FROM group_members gm
    JOIN collaboration_groups g ON g.id = gm.group_id
    WHERE gm.user_id = p_connection_id
    AND gm.group_id IN (
        SELECT group_id FROM group_members
        WHERE user_id = p_user_id
        AND role IN ('owner', 'admin')
    );

    -- Pending group invitations that will be cancelled
    RETURN QUERY
    SELECT
        'group_invitations_cancelled'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'invitation_id', gi.id,
            'group_name', g.name,
            'direction', CASE
                WHEN gi.inviter_id = p_user_id THEN 'sent'
                ELSE 'received'
            END
        )) as details
    FROM group_invitations gi
    JOIN collaboration_groups g ON g.id = gi.group_id
    WHERE gi.status = 'pending'
    AND ((gi.inviter_id = p_user_id AND gi.invitee_id = p_connection_id)
      OR (gi.inviter_id = p_connection_id AND gi.invitee_id = p_user_id));

    -- List collaborations that will be revoked
    RETURN QUERY
    SELECT
        'list_access_revoked'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'list_id', lc.list_id,
            'list_name', l.title,
            'permission', lc.permission
        )) as details
    FROM list_collaborators lc
    JOIN lists l ON l.id = lc.list_id
    WHERE (lc.owner_id = p_user_id AND lc.user_id = p_connection_id)
       OR (lc.owner_id = p_connection_id AND lc.user_id = p_user_id);

    -- Pending list invitations that will be cancelled
    RETURN QUERY
    SELECT
        'list_invitations_cancelled'::TEXT as impact_type,
        COUNT(*)::INTEGER as item_count,
        jsonb_agg(jsonb_build_object(
            'invitation_id', li.id,
            'list_name', l.title,
            'direction', CASE
                WHEN li.inviter_id = p_user_id THEN 'sent'
                ELSE 'received'
            END
        )) as details
    FROM list_invitations li
    JOIN lists l ON l.id = li.list_id
    WHERE li.status = 'pending'
    AND ((li.inviter_id = p_user_id AND li.invitee_id = p_connection_id)
      OR (li.inviter_id = p_connection_id AND li.invitee_id = p_user_id));
END;
$$ LANGUAGE plpgsql;

-- Add comment for documentation
COMMENT ON FUNCTION cascade_connection_removal() IS 'Handles cascade deletion when a connection is removed, revoking all group memberships, list access, and pending invitations';
COMMENT ON FUNCTION get_connection_removal_impact(UUID, UUID) IS 'Returns a summary of what will be affected when a connection is removed, useful for showing confirmation dialogs';