-- Fix references to non-existent display_name column in users table
-- The users table has username column, not display_name

-- Update the get_user_pending_invitations function to use username instead of display_name
CREATE OR REPLACE FUNCTION get_user_pending_invitations(
    p_user_id UUID
)
RETURNS TABLE (
    invitation_type TEXT,
    invitation_id UUID,
    sender_name TEXT,
    group_name TEXT,
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE,
    has_pending_group BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        'connection'::TEXT as invitation_type,
        ci.id as invitation_id,
        u.username as sender_name,  -- Changed from display_name to username
        CASE
            WHEN ci.invitation_context = 'group_invitation'
            THEN (ci.metadata->>'group_name')::TEXT
            ELSE NULL::TEXT
        END as group_name,
        ci.message,
        ci.created_at,
        EXISTS(
            SELECT 1 FROM pending_group_invitations pgi
            WHERE pgi.connection_invitation_id = ci.id
            AND pgi.status = 'waiting'
        ) as has_pending_group
    FROM connection_invitations ci
    JOIN users u ON u.id = ci.sender_id
    WHERE ci.recipient_id = p_user_id
    AND ci.status = 'pending'

    UNION ALL

    SELECT
        'group'::TEXT as invitation_type,
        gi.id as invitation_id,
        u.username as sender_name,  -- Changed from display_name to username
        g.name as group_name,
        gi.message,
        gi.created_at,
        FALSE as has_pending_group
    FROM group_invitations gi
    JOIN users u ON u.id = gi.inviter_id
    JOIN collaboration_groups g ON g.id = gi.group_id
    WHERE gi.invitee_id = p_user_id
    AND gi.status = 'pending'

    ORDER BY created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Add comment to track this change
COMMENT ON FUNCTION get_user_pending_invitations IS 'Updated in migration 061 to use username instead of non-existent display_name column';